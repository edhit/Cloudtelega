import { config } from '../config.js';
import { log } from '../logger.js';
import { describeError } from '../errors.js';
import { getTopic, putTopic } from '../db.js';
import { botConfigured, createForumTopicViaBot } from './botApi.js';
import { createForumTopicViaAccount, listForumTopics, mtprotoConfigured } from './mtproto.js';

// Список существующих топиков читается через аккаунт и только для того чата,
// с которым сейчас работаем: у архива и у диска чаты могут быть разные.
const remoteTopicsCache = new Map();

/** Топики, которые уже существуют в чате (доступно только через аккаунт). */
async function loadRemoteTopics(chatId) {
  if (remoteTopicsCache.has(chatId)) return remoteTopicsCache.get(chatId);
  if (!mtprotoConfigured()) return null;
  try {
    const topics = await listForumTopics(100, chatId);
    remoteTopicsCache.set(chatId, topics);
    return topics;
  } catch (err) {
    log.warn(`Не удалось получить список топиков: ${describeError(err, { kind: 'bot' })}`);
    remoteTopicsCache.set(chatId, null);
    return null;
  }
}

/**
 * message_thread_id по названию темы: из базы, из существующих тем чата
 * или создаём новую. Работает только в супергруппе с включёнными темами.
 * @param {string} title название темы — год для архива, имя папки для диска
 * @param {string} chatId в каком чате
 */
/**
 * Тема под ключом `key`; если ключ не задан, им становится само название.
 * Ключ и название расходятся у вложенных папок диска: в базе папка лежит
 * путём «Договоры/2026», а темой в Telegram зовётся «Договоры / 2026» —
 * искать её надо по пути, а показывать человеку по названию.
 */
export async function resolveTopic(title, chatId = config.chatId, { key: rawKey, bucket = 'photos' } = {}) {
  if (!chatId) throw new Error('Не задан чат для темы');
  const name = String(title).trim();
  const key = String(rawKey ?? title).trim();

  const cached = getTopic(chatId, key);
  if (cached) return cached;

  const remote = await loadRemoteTopics(chatId);
  const found = remote?.find((t) => t.title.trim() === name);
  if (found) {
    putTopic(chatId, key, found.id, found.title, bucket);
    log.info(`Тема «${name}» уже существует (id ${found.id})`);
    return found.id;
  }

  let topicId;
  if (botConfigured()) {
    topicId = await createForumTopicViaBot(name, chatId);
  } else if (mtprotoConfigured()) {
    topicId = await createForumTopicViaAccount(name, chatId);
  } else {
    throw new Error('Нет ни бота, ни аккаунта — некому создать тему');
  }

  putTopic(chatId, key, topicId, name, bucket);
  remoteTopicsCache.get(chatId)?.push({ id: topicId, title: name });
  log.ok(`Создана тема «${name}» (id ${topicId})`);
  return topicId;
}

/** Топик-год в архиве снимков. */
export const resolveYearTopic = (year) => resolveTopic(year, config.chatId);

/** Топик для конкретного файла в зависимости от TOPIC_MODE. */
export async function topicForFile(file) {
  if (config.topicMode === 'year') {
    const year = String(new Date(file.takenAt ?? file.mtime).getFullYear());
    return resolveYearTopic(year);
  }
  return config.topicId || null;
}
