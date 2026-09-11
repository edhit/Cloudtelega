/**
 * Общая база для совместной работы.
 *
 * Список файлов живёт в SQLite на компьютере, и у каждого участника он свой.
 * Чтобы все видели одно и то же, база выкладывается в тот же чат, где лежат
 * сами файлы: кто открыл чат — тот и забрал свежий список.
 *
 * Слияние идёт по отпечатку файла (sha256 или tg:file_unique_id), и правило
 * одно: **чужие записи только добавляются, свои не затираются**. Так у слияния
 * нет проигравших — две базы, где каждый заливал своё, сходятся в одну.
 * Расплата за простоту честная: правку одной и той же записи с двух сторон
 * оно не разрешает, выигрывает тот, чью базу прочитали последней.
 *
 * Выкладываем ТОЛЬКО записи хранилища, чей это чат, и без путей на компьютере:
 * в чат диска пускают посторонних, и знать, что у вас лежит в /home/маша/фото,
 * им незачем.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log, humanSize } from './logger.js';
import { describeError } from './errors.js';
import { exportRows, getMeta, importRows, setMeta } from './db.js';
import { botConfigured, sendFileViaBot } from './telegram/botApi.js';
import { downloadMessageFile, mtprotoConfigured } from './telegram/mtproto.js';

// Формат снимка. Меняется — старые снимки перестают читаться, поэтому
// номер проверяется на входе, а не угадывается
const FORMAT = 1;

const BUCKETS = {
  drive: { bucket: 'drive', title: 'Диск', chat: () => config.driveChatId || config.chatId },
  photos: { bucket: 'photos', title: 'Фотоархив', chat: () => config.chatId },
};

export function syncTargets() {
  return Object.entries(BUCKETS)
    .filter(([, t]) => t.chat())
    .map(([id, t]) => ({ id, title: t.title, chatId: String(t.chat()) }));
}

function targetOf(id) {
  const target = BUCKETS[id];
  if (!target) throw new Error(`Неизвестное хранилище: ${id}`);
  if (!target.chat()) throw new Error(`У «${target.title}» ещё не выбран чат`);
  return target;
}

/**
 * Снимок списка файлов одного хранилища. Путей на компьютере в нём нет:
 * их видел бы каждый, кого вы пустили в чат.
 */
export function buildSnapshot(id) {
  const target = targetOf(id);
  const rows = exportRows(target.bucket).map((row) => ({
    ...row,
    // abs_path и rel_path — это устройство чужого компьютера, не данные о файле
    abs_path: null,
    rel_path: row.name,
  }));

  return {
    format: FORMAT,
    bucket: target.bucket,
    chatId: String(target.chat()),
    madeAt: Date.now(),
    by: config.profile,
    rows,
  };
}

/** Кладёт снимок в файл — его и отправляем в чат. */
export async function writeSnapshot(id, dir = config.tmpDir || '.') {
  const snapshot = buildSnapshot(id);
  const file = path.join(dir, `cloudtelega-${snapshot.bucket}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(snapshot));
  return { file, rows: snapshot.rows.length, bucket: snapshot.bucket };
}

/**
 * Выкладывает список в чат хранилища. Возвращает номер сообщения —
 * по нему список потом и забирают.
 */
export async function publishSnapshot(id) {
  const target = targetOf(id);
  if (!botConfigured()) throw new Error('Не настроен бот — отправлять список некому');

  const { file, rows } = await writeSnapshot(id);
  try {
    const stat = await fs.stat(file);
    const result = await sendFileViaBot({
      filePath: file,
      fileName: `cloudtelega-${target.bucket}.json`,
      size: stat.size,
      mime: 'application/json',
      kind: 'document',
      asDocument: true,
      caption: `Список файлов «${target.title}»: ${rows} ${rows === 1 ? 'запись' : 'записей'}\n`
        + `Снят ${new Date().toLocaleString('ru-RU')}. Программа читает его сама — удалять не нужно.`,
      chatId: target.chat(),
    });

    setMeta(`sync_published_${target.bucket}`, String(result.messageId));
    setMeta(`sync_published_at_${target.bucket}`, String(Date.now()));
    log.ok(`Список «${target.title}» выложен в чат: ${rows} ${rows === 1 ? 'запись' : 'записей'} (${humanSize(stat.size)})`);
    return { messageId: result.messageId, rows, title: target.title };
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

/** Что известно про выложенный список — для панели. */
export function syncState(id) {
  const target = BUCKETS[id];
  if (!target) return null;
  const at = Number(getMeta(`sync_published_at_${target.bucket}`) ?? 0);
  return {
    id,
    title: target.title,
    chatId: target.chat() ? String(target.chat()) : null,
    messageId: Number(getMeta(`sync_published_${target.bucket}`) ?? 0) || null,
    publishedAt: at || null,
  };
}

/**
 * Забирает список из чата и подмешивает к своему. Сообщение со списком
 * скачиваем через аккаунт: бот отдаёт только файлы до 20 МБ, а список
 * большого архива в них не влезет.
 *
 * @param {string} id хранилище
 * @param {number} messageId сообщение со списком; по умолчанию — последнее своё
 */
export async function pullSnapshot(id, messageId) {
  const target = targetOf(id);
  const msgId = Number(messageId) || Number(getMeta(`sync_published_${target.bucket}`) ?? 0);
  if (!msgId) throw new Error('Не знаю, где список: сначала выложите его или укажите сообщение');
  if (!mtprotoConfigured()) throw new Error('Чтобы забрать список, нужен вход в аккаунт: бот отдаёт только файлы до 20 МБ');

  const dest = path.join(config.tmpDir || '.', `pull-${target.bucket}.json`);
  try {
    await downloadMessageFile({ chatId: target.chat(), messageId: msgId, destPath: dest });
    const raw = JSON.parse(await fs.readFile(dest, 'utf8'));
    return applySnapshot(id, raw);
  } catch (err) {
    throw new Error(`Не вышло забрать список: ${describeError(err, { kind: 'mtproto' })}`);
  } finally {
    await fs.rm(dest, { force: true }).catch(() => {});
  }
}

/**
 * Подмешивает чужой снимок к своей базе. Ничего не удаляет и не переписывает:
 * добавляются только записи, которых у нас нет.
 */
export function applySnapshot(id, snapshot) {
  const target = targetOf(id);

  if (Number(snapshot?.format) !== FORMAT) {
    throw new Error(`Этот список сделан другой версией программы (формат ${snapshot?.format ?? '?'}), прочитать его не могу`);
  }
  if (snapshot.bucket !== target.bucket) {
    throw new Error(`Это список «${snapshot.bucket}», а не «${target.bucket}» — не тот чат`);
  }
  if (String(snapshot.chatId) !== String(target.chat())) {
    throw new Error('Список снят с другого чата — подмешивать его к этому нельзя');
  }

  const added = importRows(snapshot.rows ?? [], target.bucket);
  setMeta(`sync_pulled_at_${target.bucket}`, String(Date.now()));
  log.ok(`Список «${target.title}» подмешан: новых записей ${added}, своих не тронуто`);
  return { added, total: snapshot.rows?.length ?? 0, title: target.title };
}
