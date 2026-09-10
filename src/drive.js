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
import { driveStats, fileById, findByHash, markFailed, markSent, upsertPending } from './db.js';
import { sha256Cached } from './hash.js';
import { extOf, kindOf, mimeOf } from './media.js';
import { normalizeStem } from './naming.js';
import { messageLink } from './links.js';
import { botConfigured, deleteMessage, sendFileViaBot } from './telegram/botApi.js';
import { downloadMessageFile, mtprotoConfigured, sendFileViaAccount } from './telegram/mtproto.js';
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

/** Имя темы для файла: верхняя папка относительно корня, иначе «Разное». */
function folderOf(absPath, root) {
  if (!root) return null;
  const rel = path.relative(root, absPath);
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.length > 1 ? parts[0] : null;
}

/** Подпись под файлом на диске — коротко и по делу. */
function driveCaption(file, folder) {
  const parts = [file.name, humanSize(file.size)];
  if (folder) parts.push(`папка: ${folder}`);
  return parts.join(' · ');
}

/**
 * Кладёт один файл на диск.
 * @param {string} absPath
 * @param {{root?:string, folder?:string, onProgress?:Function}} opts
 * @returns {Promise<{status:'sent'|'duplicate'|'failed', file:object, error?:string, link?:string}>}
 */
export async function putFile(absPath, { root, folder } = {}) {
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

  const name = path.basename(absPath);
  const record = {
    absPath,
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
    const folderName = folder ?? (config.driveFolders ? folderOf(absPath, root) : null);
    const topicId = folderName ? await resolveTopic(folderName, chatId) : null;

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

/** Убирает файл с диска: удаляет сообщение и запись. */
export async function removeFromDrive(id) {
  const row = fileById(id);
  if (!row) throw new Error(`Записи ${id} нет в базе`);
  if (row.message_id) {
    await deleteMessage(row.chat_id, row.message_id).catch((err) => {
      log.warn(`Сообщение удалить не вышло: ${describeError(err, { kind: 'bot' })}`);
    });
  }
  const { openDb } = await import('./db.js');
  openDb().prepare('DELETE FROM files WHERE id = ?').run(Number(id));
  return { name: row.name };
}
