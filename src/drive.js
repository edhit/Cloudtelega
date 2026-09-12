/**
 * Диск: любые файлы, а не только фото и видео.
 *
 * От архива снимков отличается тремя вещами:
 *  • берём файл любого типа и всегда шлём документом — без пережатия;
 *  • папка на компьютере становится темой в чате, а не год съёмки;
 *  • файл можно скачать обратно — иначе это не диск, а корзина.
 *
 * Живёт в той же таблице files, что и снимки, но с bucket = 'drive':
 * так бесплатно достаются дедупликация по sha256, поиск, ссылки на сообщения
 * и повтор упавшего.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log, humanSize } from './logger.js';
import { describeError } from './errors.js';
import {
  driveRootCount, driveStats, dropFolder, fileById, findByHash, listDriveFolders,
  markFailed, markSent, putTopic, setFileFolder, setFileNote, upsertPending,
} from './db.js';
import { sha256Cached } from './hash.js';
import { extOf, kindOf, mimeOf } from './media.js';
import { normalizeStem } from './naming.js';
import { messageLink } from './links.js';
import {
  botConfigured, copyMessage, deleteForumTopic, deleteMessage, editMessageCaption,
  sendFileViaBot,
} from './telegram/botApi.js';
import {
  copyMessageToPerson, deleteMessageViaAccount, downloadMessageFile, editCaptionViaAccount,
  mtprotoConfigured, sendFileViaAccount,
} from './telegram/mtproto.js';
import { resolveTopic } from './telegram/topics.js';
import { BOT_UPLOAD_LIMIT } from './config.js';

const BUCKET = 'drive';

export function driveChatId() {
  return config.driveChatId || config.chatId;
}

export function driveConfigured() {
  return Boolean(driveChatId());
}

/** Сводка для панели диска. */
export function driveOverview() {
  const s = driveStats(BUCKET);
  return {
    chatId: driveChatId(),
    separateChat: Boolean(config.driveChatId && config.driveChatId !== config.chatId),
    folders: config.driveFolders,
    files: Number(s?.n ?? 0),
    bytes: Number(s?.bytes ?? 0),
    sent: Number(s?.sent ?? 0),
    downloadDir: config.driveDownloadDir || path.resolve('downloads'),
  };
}

/* ── папки ───────────────────────────────────────────────────────────────── */

// Одно звено пути. Косая черта — разделитель папок, поэтому внутри имени
// её быть не может; Telegram ограничивает имя темы 128 символами.
export function cleanFolderName(raw) {
  const name = String(raw ?? '')
    .replace(/[\\/\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  if (!name) throw new Error('Пустое имя папки');
  if (name === '.' || name === '..') throw new Error('Так папку назвать нельзя');
  return name;
}

// Глубже вложенность людям уже не нужна, а имя темы в Telegram не резиновое
const MAX_DEPTH = 8;

/**
 * Путь папки целиком: «Договоры/2026/Аренда». Именно он лежит в базе,
 * поэтому вложенность не требует отдельной таблицы — достаточно разобрать
 * строку. Каждое звено чистим по отдельности, пустые выбрасываем.
 */
export function cleanFolderPath(raw) {
  const parts = String(raw ?? '')
    .split('/')
    .map((part) => part.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((part) => part.slice(0, 96));

  if (!parts.length) throw new Error('Пустое имя папки');
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('Так папку назвать нельзя');
  if (parts.length > MAX_DEPTH) throw new Error(`Глубже ${MAX_DEPTH} папок не уходим — станет неудобно`);
  return parts.join('/');
}

/** Имя темы в Telegram для папки: путь целиком, чтобы его было видно и там. */
function topicNameFor(path) {
  const name = path.split('/').join(' / ');
  return name.length <= 120 ? name : `…${name.slice(-119)}`;
}

/** Что лежит внутри папки `parent`: сама папка и её непосредственные дети. */
export function folders(parent = '') {
  const chatId = driveChatId();
  const here = parent ? cleanFolderPath(parent) : '';
  return {
    root: { name: here, title: here ? here.split('/').at(-1) : 'Все файлы', n: driveRootCount(BUCKET, here) },
    list: listDriveFolders(chatId, BUCKET, here),
  };
}

/**
 * Создаёт папку: заводит под неё тему в чате, чтобы папка была видна
 * и в самом Telegram.
 * @param {string} raw имя папки
 * @param {string} parent путь папки, внутри которой создаём
 */
export async function createFolder(raw, parent = '') {
  // Не `path`: так зовётся модуль node:path, импортированный выше
  const full = cleanFolderPath(parent ? `${cleanFolderPath(parent)}/${cleanFolderName(raw)}` : raw);
  const chatId = driveChatId();
  if (!chatId) throw new Error('Не выбран чат для диска');

  // Папка живёт в базе в любом случае — путь лежит прямо в записи файла.
  // Тема в Telegram лишь делает её видимой и в самом чате; в канале тем
  // не бывает вовсе, и это не повод оставлять человека без папок.
  let topicId = 0;
  if (config.driveFolders) {
    try {
      topicId = await resolveTopic(topicNameFor(full), chatId, { key: full, bucket: BUCKET });
    } catch (err) {
      log.warn(`Тему для «${full}» завести не вышло (${describeError(err, { kind: 'bot' })}) — папка останется только в программе`);
    }
  }
  if (!topicId) putTopic(chatId, full, 0, full, BUCKET);

  log.ok(topicId ? `Папка «${full}» готова (тема ${topicId})` : `Папка «${full}» готова`);
  return { name: full.split('/').at(-1), path: full, topicId };
}

/**
 * Убирает папку с диска вместе со всем, что внутри, включая вложенные.
 * Тему в Telegram тоже удаляем — иначе в чате остаётся пустая вкладка,
 * которую человек из программы уже никак не уберёт.
 *
 * Возврата нет: Telegram не держит корзину для тем.
 */
export async function removeFolder(raw) {
  const path = cleanFolderPath(raw);
  const chatId = driveChatId();
  if (!chatId) throw new Error('Не выбран чат для диска');

  const { files, topics } = dropFolder(chatId, BUCKET, path);

  let failed = 0;
  for (const row of files) {
    if (!row.message_id) continue;
    if (!(await dropMessage(row.chat_id ?? chatId, row.message_id, { method: row.method }))) failed += 1;
  }

  for (const topic of topics) {
    if (!topic.topic_id) continue;
    try {
      await deleteForumTopic(topic.topic_id, chatId);
    } catch (err) {
      log.warn(`Тему «${topic.key}» удалить не вышло: ${describeError(err, { kind: 'bot' })}`);
    }
  }

  log.ok(`Папка «${path}» убрана: файлов ${files.length}, тем ${topics.length}`);
  return { path, files: files.length, topics: topics.length, failed };
}

/** Переложить файл в другую папку. */
export function moveFile(id, folder) {
  return setFileFolder(id, folder ? cleanFolderPath(folder) : null);
}

/**
 * Папка для файла — его путь относительно корня, целиком. Раньше брали
 * только верхнее звено, и дерево с компьютера схлопывалось в один уровень;
 * теперь «Отчёты/2026/Март» так и остаётся «Отчёты/2026/Март».
 */
function folderOf(absPath, root) {
  if (!root) return null;
  const parts = path.relative(root, absPath).split(path.sep).filter(Boolean);
  parts.pop(); // последнее звено — имя самого файла
  if (!parts.length) return null;
  try {
    return cleanFolderPath(parts.slice(0, MAX_DEPTH).join('/'));
  } catch {
    return null;
  }
}

/** Подпись под файлом на диске — коротко и по делу. */
function driveCaption(file, folder) {
  const parts = [file.name, humanSize(file.size)];
  if (folder) parts.push(`папка: ${folder.split('/').join(' / ')}`);
  return parts.join(' · ');
}

/**
 * Кладёт один файл на диск.
 * @param {string} absPath
 * @param {{root?:string, folder?:string, onProgress?:Function}} opts
 * @returns {Promise<{status:'sent'|'duplicate'|'failed', file:object, error?:string, link?:string}>}
 */
export async function putFile(absPath, { root, folder, displayName } = {}) {
  const chatId = driveChatId();
  if (!chatId) throw new Error('Не выбран чат для диска');

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    return { status: 'failed', file: { name: path.basename(absPath), absPath }, error: describeError(err, { kind: 'file' }) };
  }
  if (!stat.isFile()) {
    return { status: 'failed', file: { name: path.basename(absPath), absPath }, error: 'это не файл' };
  }

  const name = displayName || path.basename(absPath);
  const record = {
    // У перетащенного файла пути на компьютере нет — запоминать нечего
    absPath: displayName ? null : absPath,
    relPath: root ? path.relative(root, absPath) : name,
    name,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    takenAt: Math.floor(stat.mtimeMs),
    dateSource: 'fs',
    ext: extOf(name),
    kind: kindOf(name) ?? 'document',
    bucket: BUCKET,
    stemName: normalizeStem(name),
  };

  let sha256;
  try {
    sha256 = await sha256Cached(absPath, record.size, record.mtime, name);
  } catch (err) {
    return { status: 'failed', file: record, error: `не удалось прочитать: ${describeError(err, { kind: 'file' })}` };
  }
  record.sha256 = sha256;

  // Такой файл уже лежит на диске — второй раз не грузим
  const existing = findByHash(sha256);
  if (existing?.status === 'sent') {
    return { status: 'duplicate', file: { ...record, id: existing.id }, twin: existing, link: messageLink(existing) };
  }

  upsertPending(record);

  try {
    // Папка запоминается всегда, тема — только если чат её держит.
    // В канале тем нет: файл уйдёт в общую ленту, а папка останется в базе
    const folderName = folder ?? folderOf(absPath, root);
    let topicId = null;
    if (folderName && config.driveFolders) {
      topicId = await resolveTopic(topicNameFor(folderName), chatId, { key: folderName, bucket: BUCKET })
        .catch((err) => {
          log.warn(`Тема для «${folderName}» недоступна: ${describeError(err, { kind: 'bot' })}`);
          return null;
        });
    }
    record.folder = folderName ?? null;
    upsertPending(record);

    const job = {
      filePath: absPath,
      fileName: name,
      size: record.size,
      mime: mimeOf(name),
      kind: record.kind,
      asDocument: true, // диск хранит оригиналы: никакого пережатия
      caption: driveCaption(record, folderName),
      topicId,
      chatId,
    };

    const useBot = botConfigured() && (config.botApiRoot !== 'https://api.telegram.org' || record.size <= BOT_UPLOAD_LIMIT);
    if (!useBot && !mtprotoConfigured()) {
      throw new Error(`Файл ${humanSize(record.size)} больше 50 МБ, а вход в аккаунт не выполнен — отправить нечем`);
    }

    const result = useBot
      ? await sendFileViaBot({ ...job, chatId })
      : await sendFileViaAccount(job);

    markSent(sha256, {
      method: result.method,
      chatId,
      topicId,
      messageId: result.messageId,
      fileId: result.fileId,
      fileUniqueId: result.fileUniqueId,
      fileType: result.fileType,
      thumbFileId: result.thumbFileId,
    });

    const saved = findByHash(sha256);
    return { status: 'sent', file: saved, folder: folderName, link: messageLink(saved), method: result.method };
  } catch (err) {
    const why = describeError(err, { kind: err.method ? 'bot' : 'mtproto' });
    markFailed(sha256, why);
    return { status: 'failed', file: record, error: why };
  }
}

/**
 * Кладёт на диск файл, который браузер прислал байтами (перетаскивание).
 * Файл уже сохранён во временный, откуда его и отправляем — так работает
 * и гигабайтный архив: он не держится целиком в памяти.
 * @param {{tmpPath:string, name:string, folder?:string|null}} opts
 */
export async function putUploaded({ tmpPath, name, folder = null }) {
  const safeName = String(name || path.basename(tmpPath)).replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
  const folderName = folder ? cleanFolderPath(folder) : null;

  try {
    return await putFile(tmpPath, { folder: folderName, displayName: safeName });
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** Рекурсивно собирает файлы папки — на диск кладём всё, без отбора по типу. */
export async function listLocalFiles(root, { limit = 5000 } = {}) {
  const out = [];
  const stack = [root];

  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(`Не смог прочитать ${dir}: ${describeError(err, { kind: 'file' })}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Кладёт на диск папку или список файлов.
 * @param {{paths:string[], folder?:string, hooks?:{onFile?:Function, onFinish?:Function}}} opts
 */
export async function putMany({ paths, folder, hooks = {} } = {}) {
  const files = [];
  for (const target of paths) {
    let stat;
    try {
      stat = await fs.stat(target);
    } catch (err) {
      log.warn(`${target}: ${describeError(err, { kind: 'file' })}`);
      continue;
    }
    if (stat.isDirectory()) files.push(...(await listLocalFiles(target)).map((f) => ({ path: f, root: target })));
    else files.push({ path: target, root: path.dirname(target) });
  }

  const result = { total: files.length, sent: 0, duplicates: 0, failed: 0, bytes: 0 };

  for (const [index, item] of files.entries()) {
    const outcome = await putFile(item.path, { root: item.root, folder });
    if (outcome.status === 'sent') {
      result.sent += 1;
      result.bytes += outcome.file?.size ?? 0;
    } else if (outcome.status === 'duplicate') result.duplicates += 1;
    else result.failed += 1;

    await hooks.onFile?.({ index: index + 1, total: files.length, ...outcome });
  }

  await hooks.onFinish?.(result);
  return result;
}

/**
 * Забирает файл с диска обратно на компьютер.
 * @param {number} id запись в базе
 * @param {{destDir?:string, onProgress?:Function}} opts
 */
export async function getFileBack(id, { destDir, onProgress } = {}) {
  const row = fileById(id);
  if (!row) throw new Error(`Записи ${id} нет в базе`);
  if (row.status !== 'sent' || !row.message_id) throw new Error(`${row.name} ещё не отправлен на диск`);
  if (!mtprotoConfigured()) {
    throw new Error('Чтобы скачивать с диска, нужен вход в аккаунт: бот отдаёт только файлы до 20 МБ');
  }

  const dir = destDir || config.driveDownloadDir || path.resolve('downloads');
  const destPath = path.join(dir, row.rel_path || row.name);

  const bytes = await downloadMessageFile({
    chatId: row.chat_id,
    messageId: row.message_id,
    destPath,
    onProgress,
  });

  log.ok(`Скачано: ${row.name} (${humanSize(bytes)}) → ${destPath}`);
  return { path: destPath, bytes, name: row.name };
}

/**
 * Заметка к файлу: меняем подпись у самого сообщения в Telegram и помним
 * копию у себя. Именно ради этого диск удобнее держать в канале — там
 * подпись правится в любой момент и её видят все, у кого есть доступ.
 */
export async function setNote(id, note) {
  const row = fileById(id);
  if (!row) throw new Error(`Записи ${id} нет в базе`);
  if (!row.message_id) throw new Error(`${row.name} ещё не отправлен — подписывать нечего`);

  const text = String(note ?? '').slice(0, 1024);
  const caption = [driveCaption({ name: row.name, size: row.size }, row.folder), text]
    .filter(Boolean)
    .join('\n\n');

  const chatId = row.chat_id ?? driveChatId();

  // Править сообщение может только тот, кто его послал: бот получает от
  // Telegram «message can't be edited» на всё чужое. Крупные файлы уходят
  // аккаунтом, выложенные с телефона — вообще человеком.
  if (row.method === 'bot') {
    await editMessageCaption(chatId, row.message_id, caption);
  } else if (row.method === 'mtproto' && mtprotoConfigured()) {
    await editCaptionViaAccount({ chatId, messageId: row.message_id, caption });
  } else if (row.method === 'telegram') {
    throw new Error(`«${row.name}» выложили в чат вручную — такую подпись программа править не может, `
      + 'поправьте её прямо в Telegram');
  } else {
    throw new Error(`«${row.name}» отправлен через ваш аккаунт — чтобы править подпись, войдите в аккаунт`);
  }

  setFileNote(id, text);
  return { id, note: text };
}

/**
 * Убирает сообщение из чата. Бот-администратор с правом удалять сообщения
 * может убрать любое и в любой момент — ограничение «только за двое суток»
 * на него не распространяется. Но если права не дали, бот бессилен: тогда
 * пробуем аккаунтом, он в своём чате всегда хозяин.
 */
async function dropMessage(chatId, messageId, { method } = {}) {
  try {
    await deleteMessage(chatId, messageId);
    return true;
  } catch (err) {
    if (!mtprotoConfigured()) {
      log.warn(`Сообщение удалить не вышло: ${describeError(err, { kind: 'bot' })}`);
      return false;
    }
    try {
      await deleteMessageViaAccount({ chatId, messageId });
      log.info(`Сообщение ${messageId} убрано аккаунтом — боту Telegram не дал${method ? ` (${method})` : ''}`);
      return true;
    } catch (second) {
      log.warn(`Сообщение удалить не вышло: ${describeError(second, { kind: 'mtproto' })}`);
      return false;
    }
  }
}

/**
 * Отдаёт один файл человеку — и ничего больше.
 *
 * Ссылки «только на этот файл» в Telegram не бывает: доступ там даётся
 * к чату целиком, а не к отдельному сообщению. Поэтому файл не «открывают»,
 * а отправляют — копией в личную переписку. Копия, а не пересылка: у
 * пересланного видно, откуда оно, то есть выдало бы название чата.
 *
 * Два пути, и выбор между ними не наша прихоть, а правило Telegram:
 *  • бот может писать только тому, кто сам ему когда-то написал;
 *  • ваш аккаунт достаёт любого по @имени.
 *
 * @param {number} id запись в базе
 * @param {{userId?:string|number, username?:string}} to кому
 */
export async function shareFile(id, { userId, username } = {}) {
  const row = fileById(id);
  if (!row) throw new Error(`Записи ${id} нет в базе`);
  if (row.status !== 'sent' || !row.message_id) throw new Error(`${row.name} ещё не отправлен на диск`);

  const from = row.chat_id ?? driveChatId();
  const note = row.note ? `\n\n${row.note}` : '';
  const caption = `${row.name} · ${humanSize(row.size)}${note}`;

  // Человеку, который писал боту, отправляет бот: это не требует входа в аккаунт
  if (userId && botConfigured()) {
    try {
      await copyMessage(userId, from, row.message_id, { caption });
      log.ok(`Файл «${row.name}» отправлен человеку ${username ? `@${username}` : userId}`);
      return { sent: 'bot', name: row.name };
    } catch (err) {
      // Бот не пишет первым: если человек ему не писал, Telegram откажет
      if (!mtprotoConfigured()) {
        throw new Error(`Бот не смог: ${describeError(err, { kind: 'bot' })}. `
          + 'Скорее всего, этот человек ни разу не писал вашему боту — попросите его написать боту хоть что-нибудь, '
          + 'либо войдите в аккаунт, и программа отправит файл от вашего имени');
      }
      log.info(`Бот отправить не смог (${describeError(err, { kind: 'bot' })}) — пробую от вашего имени`);
    }
  }

  const target = username ? (String(username).startsWith('@') ? username : `@${username}`) : userId;
  if (!target) throw new Error('Не понял, кому отправлять');
  if (!mtprotoConfigured()) {
    throw new Error('Чтобы отправить файл тому, кто не писал боту, нужен вход в аккаунт: '
      + 'бот не может написать человеку первым — так устроен Telegram');
  }

  await copyMessageToPerson({ to: target, fromChatId: from, messageId: row.message_id });
  log.ok(`Файл «${row.name}» отправлен ${target} от вашего имени`);
  return { sent: 'account', name: row.name };
}

/** Убирает файл с диска: удаляет сообщение и запись. */
export async function removeFromDrive(id) {
  const row = fileById(id);
  if (!row) throw new Error(`Записи ${id} нет в базе`);
  if (row.message_id) {
    await dropMessage(row.chat_id ?? driveChatId(), row.message_id, { method: row.method });
  }
  const { openDb } = await import('./db.js');
  openDb().prepare('DELETE FROM files WHERE id = ?').run(Number(id));
  return { name: row.name };
}
