import { config } from '../config.js';
import { log } from '../logger.js';
import { getTopic, putTopic } from '../db.js';
import { botConfigured, createForumTopicViaBot } from './botApi.js';
import { createForumTopicViaAccount, listForumTopics, mtprotoConfigured } from './mtproto.js';

let remoteTopicsCache = null;

/** Топики, которые уже существуют в чате (доступно только через аккаунт). */
async function loadRemoteTopics() {
  if (remoteTopicsCache) return remoteTopicsCache;
  if (!mtprotoConfigured()) return null;
  try {
    remoteTopicsCache = await listForumTopics();
  } catch (err) {
    log.warn(`Не удалось получить список топиков: ${err.message}`);
    remoteTopicsCache = null;
  }
  return remoteTopicsCache;
}

/**
 * Возвращает message_thread_id для года: из базы, из существующих топиков чата
 * или создаёт новый. Работает только в супергруппе с включёнными темами (форумом).
 */
export async function resolveYearTopic(year) {
  const cached = getTopic(config.chatId, year);
  if (cached) return cached;

  const remote = await loadRemoteTopics();
  const found = remote?.find((t) => t.title.trim() === year);
  if (found) {
    putTopic(config.chatId, year, found.id, found.title);
    log.info(`Топик «${year}» уже существует (id ${found.id})`);
    return found.id;
  }

  let topicId;
  if (botConfigured()) {
    topicId = await createForumTopicViaBot(year);
  } else if (mtprotoConfigured()) {
    topicId = await createForumTopicViaAccount(year);
  } else {
    throw new Error('Нет ни бота, ни аккаунта — некому создать топик');
  }

  putTopic(config.chatId, year, topicId, year);
  if (remoteTopicsCache) remoteTopicsCache.push({ id: topicId, title: year });
  log.ok(`Создан топик «${year}» (id ${topicId})`);
  return topicId;
}

/** Топик для конкретного файла в зависимости от TOPIC_MODE. */
export async function topicForFile(file) {
  if (config.topicMode === 'year') {
    const year = String(new Date(file.takenAt ?? file.mtime).getFullYear());
    return resolveYearTopic(year);
  }
  return config.topicId || null;
}
