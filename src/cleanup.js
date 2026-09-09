import { config } from './config.js';
import { markSkipped, strayLiveVideos } from './db.js';
import { formatDateHuman } from './dates.js';
import { humanSize } from './logger.js';
import { deleteMessage } from './telegram/botApi.js';

/**
 * Ищет видео Live Photo, которые ушли отдельным сообщением, хотя их кадр уже в архиве
 * (например, IMG_0373_HEVC.MOV рядом с IMG_0373.jpg — раньше пара не распознавалась).
 * @param {{apply?:boolean, limit?:number}} opts apply=true — удалить сообщения
 */
export async function cleanupStrayLiveVideos({ apply = false, limit = 500 } = {}) {
  const rows = strayLiveVideos(limit);
  const result = { found: rows.length, deleted: 0, failed: [], rows };
  if (!apply || !rows.length) return result;

  for (const row of rows) {
    try {
      await deleteMessage(row.chat_id ?? config.chatId, row.message_id);
      markSkipped(row.sha256, `дубль Live Photo к ${row.photo_name}, сообщение удалено`);
      result.deleted += 1;
    } catch (err) {
      result.failed.push({ name: row.name, error: describeError(err, { kind: 'bot' }) });
    }
  }
  return result;
}

export function describeStray(row) {
  const when = row.taken_at ? formatDateHuman(row.taken_at) : '—';
  return `${when} · ${row.rel_path || row.name} (${humanSize(row.size)}) — кадр ${row.photo_name}`;
}
