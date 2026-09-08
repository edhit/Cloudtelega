import { openAsBlob } from 'node:fs';
import { config, BOT_UPLOAD_LIMIT } from '../config.js';
import { log } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method) {
  return `${config.botApiRoot}/bot${config.botToken}/${method}`;
}

async function call(method, payload, { retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    try {
      const isForm = payload instanceof FormData;
      res = await fetch(api(method), {
        method: 'POST',
        body: isForm ? payload : JSON.stringify(payload),
        headers: isForm ? undefined : { 'content-type': 'application/json' },
      });
    } catch (err) {
      if (attempt > retries) throw err;
      const wait = 2 ** attempt * 1000;
      log.warn(`Bot API сеть: ${err.message}. Повтор через ${wait} мс`);
      await sleep(wait);
      continue;
    }

    let body;
    try {
      body = await res.json();
    } catch {
      body = { ok: false, description: `HTTP ${res.status}` };
    }

    if (body.ok) return body.result;

    // Flood limit — Telegram сам говорит, сколько ждать.
    const retryAfter = body.parameters?.retry_after;
    if (retryAfter && attempt <= retries + 2) {
      log.warn(`Bot API flood limit, ждём ${retryAfter} с`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    if (res.status >= 500 && attempt <= retries) {
      const wait = 2 ** attempt * 1000;
      log.warn(`Bot API ${res.status}: ${body.description}. Повтор через ${wait} мс`);
      await sleep(wait);
      continue;
    }

    const err = new Error(`Bot API ${method}: ${body.description ?? 'неизвестная ошибка'}`);
    err.code = res.status;
    err.description = body.description;
    throw err;
  }
}

export function botConfigured() {
  return Boolean(config.botToken);
}

export async function getMe() {
  return call('getMe', {});
}

export async function getChat(chatId = config.chatId) {
  return call('getChat', { chat_id: chatId });
}

/**
 * Отправляет файл через Bot API. Лимит — 50 МБ (или 2000 МБ на своём Bot API server),
 * а для «фото с превью» — 10 МБ.
 * @returns {Promise<{messageId:number, method:'bot'}>}
 */
export async function sendFileViaBot({ filePath, fileName, size, mime, caption, kind, asDocument, topicId }) {
  if (config.botApiRoot === 'https://api.telegram.org' && size > BOT_UPLOAD_LIMIT) {
    const err = new Error('Файл больше 50 МБ — Bot API не примет');
    err.code = 'TOO_LARGE';
    throw err;
  }

  const useDocument = asDocument ?? config.sendAsDocument;
  const method = useDocument ? 'sendDocument' : kind === 'video' ? 'sendVideo' : 'sendPhoto';
  const field = useDocument ? 'document' : kind === 'video' ? 'video' : 'photo';

  const form = new FormData();
  form.append('chat_id', String(config.chatId));
  if (topicId) form.append('message_thread_id', String(topicId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('disable_notification', 'true');
  if (useDocument) form.append('disable_content_type_detection', 'true');
  if (method === 'sendVideo') form.append('supports_streaming', 'true');

  const blob = await openAsBlob(filePath, { type: mime });
  form.append(field, blob, fileName);

  const result = await call(method, form);
  return { messageId: result.message_id, method: 'bot' };
}

/**
 * Отправляет Live Photo одним сообщением: статичный кадр + короткое видео.
 * Метод sendLivePhoto появился в Bot API 10.0 (апрель 2026).
 * @returns {Promise<{messageId:number, method:'bot'}>}
 */
export async function sendLivePhotoViaBot({ filePath, fileName, mime, videoPath, videoName, videoMime, caption, topicId }) {
  const form = new FormData();
  form.append('chat_id', String(config.chatId));
  if (topicId) form.append('message_thread_id', String(topicId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('disable_notification', 'true');

  form.append('photo', await openAsBlob(filePath, { type: mime }), fileName);
  form.append('live_photo', await openAsBlob(videoPath, { type: videoMime ?? 'video/quicktime' }), videoName);

  const result = await call('sendLivePhoto', form, { retries: 1 });
  return { messageId: result.message_id, method: 'bot' };
}

/**
 * Создаёт топик в форум-супергруппе. Бот должен быть админом с правом
 * «Управление темами» (can_manage_topics).
 * @returns {Promise<number>} message_thread_id
 */
export async function createForumTopicViaBot(title) {
  const result = await call('createForumTopic', { chat_id: config.chatId, name: title });
  return result.message_thread_id;
}
