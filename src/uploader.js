import path from 'node:path';
import { config, heicMode, BOT_UPLOAD_LIMIT, PHOTO_LIMIT } from './config.js';
import { log, humanSize } from './logger.js';
import { formatDate } from './dates.js';
import { convertHeicToJpeg, isHeic, mimeOf, safeUnlink } from './media.js';
import { botConfigured, sendFileViaBot } from './telegram/botApi.js';
import { mtprotoConfigured, sendFileViaAccount } from './telegram/mtproto.js';

/**
 * Подпись к сообщению. Дата съёмки идёт первой строкой: порядок в ленте
 * соответствует дате, но подпись нужна, чтобы дату было видно и в отдельном
 * сообщении, и в поиске.
 */
export function buildCaption(file) {
  const when = formatDate(file.takenAt ?? file.mtime);
  // «≈» — дата взята из файловой системы, съёмке она может не соответствовать.
  const approx = file.dateSource === 'fs' ? '≈ ' : '';
  const d = new Date(file.takenAt ?? file.mtime);
  const month = String(d.getMonth() + 1).padStart(2, '0');

  return [
    `📅 ${approx}${when}`,
    file.relPath || file.name,
    `${humanSize(file.size)} · #y${d.getFullYear()} #m${month} · sha:${file.sha256.slice(0, 16)}`,
  ].join('\n');
}

/** Фото крупнее 10 МБ Telegram превью не сделает — такие уходят документом. */
function photoTooBigForFeed(size, kind) {
  return kind === 'photo' && size > PHOTO_LIMIT;
}

/**
 * Готовит список «посылок» для одного исходного файла.
 * HEIC может дать две: JPEG для ленты и оригинал для архива — зависит от HEIC_MODE.
 */
export async function buildJobs(file, topicId) {
  const jobs = [];
  const heic = isHeic(file.name);
  const mode = heic ? heicMode() : 'document';
  const caption = buildCaption(file);

  const original = () => ({
    filePath: file.absPath,
    fileName: file.name,
    size: file.size,
    mime: mimeOf(file.name),
    kind: file.kind,
    // HEIC Telegram как фото не покажет, оригиналы RAW тоже — они всегда документом
    asDocument: heic ? true : config.sendAsDocument || photoTooBigForFeed(file.size, file.kind),
    caption,
    topicId,
    temporary: false,
  });

  if (!heic || mode === 'document' || mode === 'both') jobs.push(original());

  if (heic && (mode === 'convert' || mode === 'both')) {
    let jpeg;
    try {
      jpeg = await convertHeicToJpeg(file.absPath);
    } catch (err) {
      // Битый или нестандартный HEIC — не теряем файл, отправляем оригинал как есть.
      log.warn(`${file.name}: не удалось сконвертировать в JPEG (${err.message}), отправляю оригинал`);
      if (!jobs.length) jobs.push(original());
      return jobs;
    }
    jobs.push({
      filePath: jpeg.path,
      fileName: jpeg.name,
      size: jpeg.size,
      mime: 'image/jpeg',
      kind: 'photo',
      asDocument: config.sendAsDocument || photoTooBigForFeed(jpeg.size, 'photo'),
      caption: mode === 'both' ? `${caption}\n(JPEG из HEIC)` : caption,
      topicId,
      temporary: true,
    });
  }

  return jobs;
}

/** Выбирает транспорт: до 50 МБ — бот, крупнее — аккаунт (MTProto). */
export function pickTransport(size) {
  const botLimitApplies = config.botApiRoot === 'https://api.telegram.org';
  const fitsBot = !botLimitApplies || size <= BOT_UPLOAD_LIMIT;

  if (botConfigured() && fitsBot) return 'bot';
  if (mtprotoConfigured()) return 'mtproto';
  if (botConfigured() && !fitsBot) {
    const err = new Error(`Файл ${humanSize(size)} > 50 МБ, а вход в аккаунт не настроен. Выполните: npm run login`);
    err.code = 'NO_TRANSPORT';
    throw err;
  }
  const err = new Error('Не настроен ни бот (TELEGRAM_BOT_TOKEN), ни аккаунт (npm run login)');
  err.code = 'NO_TRANSPORT';
  throw err;
}

// Telegram отказался обрабатывать файл как фото/видео — но документом примет.
const PHOTO_REJECTED = /PHOTO_INVALID|PHOTO_EXT_INVALID|PHOTO_SAVE_FILE_INVALID|IMAGE_PROCESS_FAILED|MEDIA_EMPTY|dimensions|too big|IMAGE_PROCESS/i;

async function deliver(job) {
  const transport = pickTransport(job.size);
  if (transport === 'bot') {
    try {
      return await sendFileViaBot(job);
    } catch (err) {
      // Bot API отказался по размеру — пробуем аккаунтом, если он настроен.
      if ((err.code === 'TOO_LARGE' || /too big|too large/i.test(err.description ?? '')) && mtprotoConfigured()) {
        log.warn(`${job.fileName}: бот не принял, отправляю от имени аккаунта`);
        return await sendFileViaAccount(job);
      }
      throw err;
    }
  }
  return sendFileViaAccount(job);
}

/** Отправляет одну «посылку» и возвращает { messageId, method }. */
export async function sendJob(job) {
  try {
    try {
      return await deliver(job);
    } catch (err) {
      if (!job.asDocument && PHOTO_REJECTED.test(`${err.message} ${err.description ?? ''}`)) {
        log.warn(`${job.fileName}: не принялся как фото (${err.message}), отправляю документом`);
        return await deliver({ ...job, asDocument: true });
      }
      throw err;
    }
  } finally {
    if (job.temporary) await safeUnlink(job.filePath);
  }
}

export function stemOf(name) {
  return path.basename(name, path.extname(name));
}
