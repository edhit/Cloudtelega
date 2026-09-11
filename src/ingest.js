/**
 * Подхват файлов, выложенных прямо в Telegram.
 *
 * Человек кидает файл в чат диска с телефона — программа должна о нём узнать,
 * иначе список в окне и содержимое чата расходятся, и совместная работа
 * рассыпается: у каждого своя правда.
 *
 * Сам файл никуда не скачивается. Telegram уже хранит его, а нам достаточно
 * записи: имя, размер, номер сообщения. Отпечатком служит file_unique_id —
 * настоящий sha256 потребовал бы скачать файл целиком, а он для того
 * и лежит в облаке, чтобы его не качать. Отсюда честное ограничение:
 * один и тот же файл, залитый и с компьютера, и с телефона, останется
 * двумя записями — их отпечатки считаются по-разному.
 */
import { log, humanSize } from './logger.js';
import { config } from './config.js';
import { findByHash, getTopicKey, setMeta, upsertPending, markSent } from './db.js';
import { extOf, kindOf } from './media.js';
import { normalizeStem } from './naming.js';

/** Чат диска: у него может быть свой, иначе общий со снимками. */
function driveChat() {
  return config.driveChatId || config.chatId;
}

/**
 * Достаёт из сообщения вложение, какое бы оно ни было.
 * Фото приходит списком размеров — берём самый большой.
 */
export function attachmentOf(msg) {
  if (!msg) return null;

  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      uniqueId: msg.document.file_unique_id,
      name: msg.document.file_name || `файл-${msg.document.file_unique_id}`,
      size: msg.document.file_size ?? 0,
      type: 'document',
    };
  }

  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a));
    return {
      fileId: best.file_id,
      uniqueId: best.file_unique_id,
      name: `фото-${best.file_unique_id}.jpg`,
      size: best.file_size ?? 0,
      type: 'photo',
    };
  }

  for (const [key, type] of [['video', 'video'], ['audio', 'audio'], ['voice', 'voice'], ['animation', 'animation']]) {
    const media = msg[key];
    if (!media) continue;
    const ext = key === 'video' ? '.mp4' : key === 'audio' ? '.mp3' : key === 'voice' ? '.ogg' : '.gif';
    return {
      fileId: media.file_id,
      uniqueId: media.file_unique_id,
      name: media.file_name || `${key}-${media.file_unique_id}${ext}`,
      size: media.file_size ?? 0,
      type,
    };
  }

  return null;
}

/**
 * Отпечаток для файла, который мы не качали. Префикс говорит, откуда он:
 * по нему видно, что настоящий sha256 не считался.
 */
const fingerprint = (uniqueId) => `tg:${uniqueId}`;

/**
 * Записывает файл из сообщения на диск. Папку берём по теме: сообщение
 * в теме «Договоры» — файл в папке «Договоры».
 *
 * @returns {'added'|'known'|'skipped'}
 */
export function ingestMessage(msg) {
  const chatId = driveChat();
  if (!chatId) return 'skipped';
  if (String(msg?.chat?.id ?? '') !== String(chatId)) return 'skipped';

  const file = attachmentOf(msg);
  if (!file) return 'skipped';

  const sha256 = fingerprint(file.uniqueId);
  if (findByHash(sha256)) return 'known';

  // Тема, в которую положили сообщение, — это и есть папка на диске
  const folder = msg.message_thread_id
    ? getTopicKey(chatId, msg.message_thread_id, 'drive')
    : null;

  const takenAt = (msg.date ?? Math.floor(Date.now() / 1000)) * 1000;
  upsertPending({
    sha256,
    // Файла на этом компьютере нет — он пришёл из чата
    absPath: null,
    relPath: file.name,
    name: file.name,
    size: file.size,
    mtime: takenAt,
    takenAt,
    dateSource: 'telegram',
    ext: extOf(file.name),
    kind: kindOf(file.name) ?? file.type,
    bucket: 'drive',
    folder,
    stemName: normalizeStem(file.name),
  });

  markSent(sha256, {
    method: 'telegram',
    chatId,
    topicId: msg.message_thread_id ?? null,
    messageId: msg.message_id,
    fileId: file.fileId,
    fileUniqueId: file.uniqueId,
    fileType: file.type,
    thumbFileId: null,
  });

  log.ok(`С телефона: ${file.name} (${humanSize(file.size)})${folder ? ` → папка «${folder}»` : ''}`);
  return 'added';
}

/**
 * Разбирает пачку апдейтов и подхватывает всё, что в них лежит.
 * Считает только чат диска: снимки в фотоархиве живут по своим правилам,
 * с датой съёмки и разбором EXIF, и подменять их записью из чата нельзя.
 */
export function ingestUpdates(updates) {
  let added = 0;
  for (const update of updates) {
    const msg = update.channel_post ?? update.message;
    if (!msg) continue;
    try {
      if (ingestMessage(msg) === 'added') added += 1;
    } catch (err) {
      log.warn(`Не смог записать файл из чата: ${err.message}`);
    }
  }
  if (added) setMeta('drive_ingest_at', String(Date.now()));
  return added;
}
