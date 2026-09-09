import { config, livePhotoMode, pairPrefer } from './config.js';
import { findByHash, findSentByStemName, markFailed, markSent, upsertPending } from './db.js';
import { sha256Cached } from './hash.js';
import { log } from './logger.js';
import { describeError } from './errors.js';
import { scanAll, summarize } from './scanner.js';
import { topicForFile } from './telegram/topics.js';
import { normalizeStem } from './naming.js';
import { buildJobs, sendJob } from './uploader.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Состояние текущей отправки — его читают и CLI, и бот. */
const state = {
  running: false,
  stopRequested: false,
  startedAt: 0,
  current: null,
  processed: 0,
  total: 0,
  sent: 0,
  duplicates: 0,
  failed: 0,
  bytesSent: 0,
};

export function sendState() {
  return { ...state };
}

export function isRunning() {
  return state.running;
}

/** Просит остановиться после текущего файла. Возвращает false, если ничего не идёт. */
export function requestStop() {
  if (!state.running) return false;
  state.stopRequested = true;
  return true;
}

function resetState(total) {
  Object.assign(state, {
    running: true,
    stopRequested: false,
    startedAt: Date.now(),
    current: null,
    processed: 0,
    total,
    sent: 0,
    duplicates: 0,
    failed: 0,
    bytesSent: 0,
  });
}

/** Сканирует каталоги: даты съёмки, схлопывание пар, сортировка по дате. */
export async function collect({ roots, since = 0, onDateProgress } = {}) {
  const { files, dropped } = await scanAll(roots, {
    since,
    prefer: pairPrefer(),
    livePhotoVideos: livePhotoMode(),
    onDateProgress,
  });
  return { files, dropped, summary: summarize(files) };
}

/**
 * Считать ли файл уже покрытым тем, что лежит в архиве под тем же именем.
 * Видео Live Photo при наличии кадра — да: ровно случай IMG_0373.jpg рядом с
 * IMG_0373_HEVC.MOV. Фото при наличии видео — нет, кадр терять нельзя.
 * Одинаковые виды (HEIC и JPG) — да, это один снимок в двух форматах.
 */
function supersededBy(file, twin) {
  if (file.kind === 'video' && twin.kind === 'photo') return livePhotoMode() !== 'send';
  if (file.kind === 'photo' && twin.kind === 'video') return false;
  return true;
}

/**
 * Помечает отправленным видео Live Photo.
 * inline = ушло внутри сообщения с кадром (тогда у него собственный video file_id),
 * иначе это было отдельное сообщение со своим file_id.
 */
async function recordCompanion(companion, result, topicId, inline) {
  try {
    const sha256 = await sha256Cached(companion.absPath, companion.size, companion.mtime, companion.name);
    if (findByHash(sha256)?.status === 'sent') return;
    upsertPending({ ...companion, sha256, stemName: normalizeStem(companion.name) });
    markSent(sha256, {
      method: result.method,
      chatId: config.chatId,
      topicId,
      messageId: result.messageId,
      fileId: (inline ? result.videoFileId : result.fileId) ?? null,
      fileType: inline ? (result.videoFileId ? 'video' : null) : (result.fileType ?? null),
    });
  } catch (err) {
    log.warn(`Не удалось записать в базу видео Live Photo ${companion.name}: ${describeError(err)}`);
  }
}

/**
 * Отправляет всё новое из указанных каталогов.
 * hooks: { onScanned({files, dropped, summary}), onFile(event), onFinish(result) }
 * event.status: 'sent' | 'duplicate' | 'failed' | 'skipped' | 'planned'
 */
export async function runSend({ roots, since = 0, limit = Infinity, dryRun = false, hooks = {} }) {
  if (state.running) {
    const err = new Error('Отправка уже идёт');
    err.code = 'BUSY';
    throw err;
  }

  // Занимаем слот до сканирования: иначе две быстрые команды /send уйдут в два обхода диска.
  resetState(0);

  let scanned;
  try {
    scanned = await collect({ roots, since, onDateProgress: hooks.onDateProgress });
  } catch (err) {
    state.running = false;
    throw err;
  }
  await hooks.onScanned?.(scanned);

  const { files } = scanned;
  const total = Math.min(files.length, limit === Infinity ? files.length : limit);
  state.total = total;

  try {
    for (const file of files) {
      if (state.stopRequested) break;
      if (state.processed >= limit) break;
      state.processed += 1;
      state.current = file.relPath || file.name;

      const emit = (status, extra = {}) =>
        hooks.onFile?.({ index: state.processed, total, file, status, ...extra });

      // Тот же снимок в другом формате из прошлых запусков
      if (config.crossRunNameCheck) {
        const twin = findSentByStemName(normalizeStem(file.name), file.takenAt);
        if (twin && twin.name.toLowerCase() !== file.name.toLowerCase() && supersededBy(file, twin)) {
          state.duplicates += 1;
          await emit('duplicate', { twin });
          continue;
        }
      }

      let sha256;
      try {
        sha256 = await sha256Cached(file.absPath, file.size, file.mtime, file.name);
      } catch (err) {
        state.failed += 1;
        await emit('failed', { error: `не удалось прочитать файл: ${describeError(err)}` });
        continue;
      }

      const existing = findByHash(sha256);
      if (existing?.status === 'sent' || existing?.status === 'skipped') {
        state.duplicates += 1;
        await emit('duplicate', { twin: existing });
        continue;
      }
      if (existing?.status === 'failed' && existing.attempts >= config.maxAttempts) {
        await emit('skipped', { error: `${existing.attempts} неудачных попыток` });
        continue;
      }

      const record = { ...file, sha256, stemName: normalizeStem(file.name) };

      if (dryRun) {
        await emit('planned');
        continue;
      }

      upsertPending(record);

      try {
        const topicId = await topicForFile(file);
        const jobs = await buildJobs(record, topicId);
        let firstResult = null;
        let companion = null;
        let companionResult = null;
        let companionInline = false;
        for (const job of jobs) {
          const res = await sendJob(job);
          firstResult ??= res;
          if (job.companion) {
            companion = job.companion;
            companionResult = res;
            companionInline = job.type === 'livePhoto';
          }
        }

        markSent(sha256, {
          method: firstResult.method,
          chatId: config.chatId,
          topicId,
          messageId: firstResult.messageId,
          fileId: firstResult.fileId,
          fileUniqueId: firstResult.fileUniqueId,
          fileType: firstResult.fileType,
          videoFileId: firstResult.videoFileId,
          thumbFileId: firstResult.thumbFileId,
        });
        // Видео Live Photo ушло вместе с кадром — записываем и его, чтобы оно
        // не отправилось повторно, если попадётся в другой папке.
        if (companion) await recordCompanion(companion, companionResult, topicId, companionInline);

        state.sent += 1;
        state.bytesSent += file.size;
        await emit('sent', { result: firstResult, topicId });
      } catch (err) {
        // Причина целиком: по «fetch failed» в логе понять ничего нельзя
        const why = describeError(err, { kind: err.method ? 'bot' : 'mtproto' });
        state.failed += 1;
        markFailed(sha256, why);
        await emit('failed', { error: why });
        if (err.code === 'NO_TRANSPORT') break;
      }

      if (config.sendDelayMs > 0) await sleep(config.sendDelayMs);
    }
  } finally {
    state.running = false;
    state.current = null;
  }

  const result = {
    sent: state.sent,
    duplicates: state.duplicates,
    failed: state.failed,
    bytesSent: state.bytesSent,
    processed: state.processed,
    total,
    stopped: state.stopRequested,
    scanned,
  };
  await hooks.onFinish?.(result);
  return result;
}
