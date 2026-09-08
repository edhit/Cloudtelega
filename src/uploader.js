import { config, heicMode, livePhotoMode, BOT_UPLOAD_LIMIT, PHOTO_LIMIT } from './config.js';
import { buildCaption } from './caption.js';
import { log, humanSize } from './logger.js';
import { convertHeicToJpeg, isHeic, mimeOf, safeUnlink } from './media.js';
import { botConfigured, sendFileViaBot, sendLivePhotoViaBot } from './telegram/botApi.js';
import { mtprotoConfigured, sendFileViaAccount } from './telegram/mtproto.js';

// Кадр Live Photo Telegram принимает только как обычное фото.
const STILL_OK = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Подпись в полях задания: текст отдельно, режим разметки отдельно. */
const captionFields = (caption) => ({ caption: caption.text, parseMode: caption.parseMode });

/** Фото крупнее 10 МБ Telegram превью не сделает — такие уходят документом. */
function photoTooBigForFeed(size, kind) {
  return kind === 'photo' && size > PHOTO_LIMIT;
}

function originalJob(file, caption, topicId, { forceDocument = false } = {}) {
  const heic = isHeic(file.name);
  return {
    filePath: file.absPath,
    fileName: file.name,
    size: file.size,
    mime: mimeOf(file.name),
    kind: file.kind,
    // HEIC и RAW Telegram как фото не покажет — они всегда документом
    asDocument: forceDocument || heic || config.sendAsDocument || photoTooBigForFeed(file.size, file.kind),
    ...captionFields(caption),
    topicId,
    temporary: false,
  };
}

/**
 * Готовит «посылки» для обычного файла (без пары Live Photo).
 * HEIC может дать две: JPEG для ленты и оригинал для архива — зависит от HEIC_MODE.
 */
async function buildPlainJobs(file, topicId) {
  const jobs = [];
  const heic = isHeic(file.name);
  const mode = heic ? heicMode() : 'document';
  const caption = buildCaption(file);

  if (!heic || mode === 'document' || mode === 'both') jobs.push(originalJob(file, caption, topicId));

  if (heic && (mode === 'convert' || mode === 'both')) {
    let jpeg;
    try {
      jpeg = await convertHeicToJpeg(file.absPath);
    } catch (err) {
      // Битый или нестандартный HEIC — не теряем файл, отправляем оригинал как есть.
      log.warn(`${file.name}: не удалось сконвертировать в JPEG (${err.message}), отправляю оригинал`);
      if (!jobs.length) jobs.push(originalJob(file, caption, topicId));
      return jobs;
    }
    jobs.push({
      filePath: jpeg.path,
      fileName: jpeg.name,
      size: jpeg.size,
      mime: 'image/jpeg',
      kind: 'photo',
      asDocument: config.sendAsDocument || photoTooBigForFeed(jpeg.size, 'photo'),
      ...captionFields(mode === 'both' ? buildCaption(file, { note: 'JPEG из HEIC' }) : caption),
      topicId,
      temporary: true,
    });
  }

  return jobs;
}

/** Кадр для Live Photo: готовый JPEG/PNG или сконвертированный из HEIC. */
async function makeStill(file) {
  if (STILL_OK.has(file.ext)) {
    return { filePath: file.absPath, fileName: file.name, size: file.size, mime: mimeOf(file.name), temporary: false };
  }
  if (!isHeic(file.name)) return null; // RAW и прочее кадром Live Photo быть не может

  try {
    const jpeg = await convertHeicToJpeg(file.absPath);
    return { filePath: jpeg.path, fileName: jpeg.name, size: jpeg.size, mime: 'image/jpeg', temporary: true };
  } catch (err) {
    log.warn(`${file.name}: не удалось сконвертировать кадр Live Photo (${err.message})`);
    return null;
  }
}

/** Фото + короткое видео рядом = Live Photo (sendLivePhoto, Bot API 10.0). */
async function buildLiveJobs(file, topicId) {
  const live = file.livePhoto;
  const caption = buildCaption(file);
  const liveCaption = buildCaption(file, { live: true });
  const mode = livePhotoMode();

  if (mode === 'live' && botConfigured()) {
    const still = await makeStill(file);
    const fits = still && still.size <= PHOTO_LIMIT && live.size <= BOT_UPLOAD_LIMIT;

    if (fits) {
      const jobs = [
        {
          type: 'livePhoto',
          ...still,
          kind: 'photo',
          videoPath: live.absPath,
          videoName: live.name,
          videoSize: live.size,
          videoMime: mimeOf(live.name),
          ...captionFields(liveCaption),
          topicId,
          companion: live,
        },
      ];
      // В режиме both оригинал HEIC всё равно кладём в архив отдельным документом.
      if (isHeic(file.name) && heicMode() === 'both') {
        jobs.push(originalJob(file, buildCaption(file, { note: 'оригинал HEIC' }), topicId, { forceDocument: true }));
      }
      return jobs;
    }
    if (still?.temporary) await safeUnlink(still.filePath);
    log.warn(`${file.name}: пара не подходит для Live Photo (кадр ${humanSize(still?.size ?? file.size)}, видео ${humanSize(live.size)}) — шлю раздельно`);
  }

  const jobs = await buildPlainJobs(file, topicId);
  if (mode !== 'skip') {
    jobs.push({
      filePath: live.absPath,
      fileName: live.name,
      size: live.size,
      mime: mimeOf(live.name),
      kind: 'video',
      asDocument: config.sendAsDocument,
      ...captionFields(buildCaption({ ...live, camera: file.camera }, { note: 'видео Live Photo' })),
      topicId,
      companion: live,
      temporary: false,
    });
  }
  return jobs;
}

export async function buildJobs(file, topicId) {
  return file.livePhoto ? buildLiveJobs(file, topicId) : buildPlainJobs(file, topicId);
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

/** Live Photo одним сообщением; если не вышло — кадр и видео по отдельности. */
async function deliverLivePhoto(job) {
  try {
    return await sendLivePhotoViaBot(job);
  } catch (err) {
    log.warn(`${job.fileName}: Live Photo не отправился (${err.message}), шлю кадр и видео отдельно`);
    const still = await deliver({ ...job, asDocument: false });
    await deliver({
      filePath: job.videoPath,
      fileName: job.videoName,
      size: job.videoSize,
      mime: job.videoMime,
      kind: 'video',
      asDocument: config.sendAsDocument,
      caption: job.caption,
      parseMode: job.parseMode,
      topicId: job.topicId,
    });
    return still;
  }
}

/** Отправляет одну «посылку» и возвращает { messageId, method }. */
export async function sendJob(job) {
  try {
    if (job.type === 'livePhoto') return await deliverLivePhoto(job);

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

