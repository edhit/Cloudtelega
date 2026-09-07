import { config, BOT_UPLOAD_LIMIT } from './config.js';
import { log, humanSize } from './logger.js';
import { convertHeicToJpeg, isHeic, mimeOf, safeUnlink } from './media.js';
import { botConfigured, sendFileViaBot } from './telegram/botApi.js';
import { mtprotoConfigured, sendFileViaAccount } from './telegram/mtproto.js';

/** Подпись к сообщению: путь, дата, размер и короткий хеш — по ним удобно искать в Telegram. */
export function buildCaption(file) {
  const date = new Date(file.mtime).toISOString().slice(0, 19).replace('T', ' ');
  const lines = [
    file.relPath || file.name,
    `${date} · ${humanSize(file.size)}`,
    `#cloudtelega sha:${file.sha256.slice(0, 16)}`,
  ];
  return lines.join('\n');
}

/**
 * Готовит список «посылок» для одного исходного файла.
 * HEIC может дать две: оригинал (архив) и JPEG (превью), в зависимости от HEIC_MODE.
 */
export async function buildJobs(file) {
  const jobs = [];
  const heic = isHeic(file.name);
  const mode = heic ? config.heicMode : 'document';

  if (!heic || mode === 'document' || mode === 'both') {
    jobs.push({
      filePath: file.absPath,
      fileName: file.name,
      size: file.size,
      mime: mimeOf(file.name),
      kind: file.kind,
      asDocument: config.sendAsDocument,
      caption: buildCaption(file),
      temporary: false,
    });
  }

  if (heic && (mode === 'convert' || mode === 'both')) {
    let jpeg;
    try {
      jpeg = await convertHeicToJpeg(file.absPath);
    } catch (err) {
      // Битый или нестандартный HEIC — не теряем файл, отправляем оригинал как есть.
      log.warn(`${file.name}: не удалось сконвертировать в JPEG (${err.message}), отправляю оригинал`);
      if (!jobs.length) {
        jobs.push({
          filePath: file.absPath,
          fileName: file.name,
          size: file.size,
          mime: mimeOf(file.name),
          kind: file.kind,
          asDocument: true,
          caption: buildCaption(file),
          temporary: false,
        });
      }
      return jobs;
    }
    jobs.push({
      filePath: jpeg.path,
      fileName: jpeg.name,
      size: jpeg.size,
      mime: 'image/jpeg',
      kind: 'photo',
      // JPEG-превью отправляем именно фотографией — так его видно в галерее канала
      asDocument: mode === 'convert' ? config.sendAsDocument : false,
      caption: `${buildCaption(file)}\n(JPEG из HEIC)`,
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
    const err = new Error(
      `Файл ${humanSize(size)} > 50 МБ, а вход в аккаунт не настроен. Выполните: npm run login`,
    );
    err.code = 'NO_TRANSPORT';
    throw err;
  }
  const err = new Error('Не настроен ни бот (TELEGRAM_BOT_TOKEN), ни аккаунт (npm run login)');
  err.code = 'NO_TRANSPORT';
  throw err;
}

/** Отправляет одну «посылку» и возвращает { messageId, method }. */
export async function sendJob(job) {
  const transport = pickTransport(job.size);
  try {
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
    return await sendFileViaAccount(job);
  } finally {
    if (job.temporary) await safeUnlink(job.filePath);
  }
}
