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

/** Достаёт file_id из ответа Telegram: его можно переиспользовать без повторной загрузки. */
export function extractMedia(msg) {
  if (msg?.live_photo) {
    const still = msg.live_photo.photo?.at(-1);
    return {
      fileType: 'live_photo',
      fileId: still?.file_id ?? null,
      fileUniqueId: still?.file_unique_id ?? null,
      videoFileId: msg.live_photo.file_id ?? null,
    };
  }
  if (msg?.photo?.length) {
    const best = msg.photo.at(-1); // последний размер — самый большой
    return { fileType: 'photo', fileId: best.file_id, fileUniqueId: best.file_unique_id, videoFileId: null };
  }
  for (const key of ['video', 'animation', 'document', 'audio', 'voice', 'video_note']) {
    if (msg?.[key]) {
      return { fileType: key, fileId: msg[key].file_id, fileUniqueId: msg[key].file_unique_id, videoFileId: null };
    }
  }
  return { fileType: null, fileId: null, fileUniqueId: null, videoFileId: null };
}

export function botConfigured() {
  return Boolean(config.botToken);
}

export async function getMe() {
  return call('getMe', {});
}

/** Права бота в чате: без права публиковать сообщения ничего не выйдет. */
export async function getChatMember(chatId, userId) {
  return call('getChatMember', { chat_id: chatId, user_id: userId });
}

export async function getChat(chatId = config.chatId) {
  return call('getChat', { chat_id: chatId });
}

/**
 * Отправляет файл через Bot API. Лимит — 50 МБ (или 2000 МБ на своём Bot API server),
 * а для «фото с превью» — 10 МБ.
 * @returns {Promise<{messageId:number, method:'bot'}>}
 */
export async function sendFileViaBot({ filePath, fileName, size, mime, caption, parseMode, kind, asDocument, topicId }) {
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
  if (caption && parseMode) form.append('parse_mode', parseMode);
  form.append('disable_notification', 'true');
  if (useDocument) form.append('disable_content_type_detection', 'true');
  if (method === 'sendVideo') form.append('supports_streaming', 'true');

  const blob = await openAsBlob(filePath, { type: mime });
  form.append(field, blob, fileName);

  const result = await call(method, form);
  return { messageId: result.message_id, method: 'bot', ...extractMedia(result) };
}

/**
 * Отправляет Live Photo одним сообщением: статичный кадр + короткое видео.
 * Метод sendLivePhoto появился в Bot API 10.0 (апрель 2026).
 * @returns {Promise<{messageId:number, method:'bot'}>}
 */
export async function sendLivePhotoViaBot({ filePath, fileName, mime, videoPath, videoName, videoMime, caption, parseMode, topicId }) {
  const form = new FormData();
  form.append('chat_id', String(config.chatId));
  if (topicId) form.append('message_thread_id', String(topicId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  if (caption && parseMode) form.append('parse_mode', parseMode);
  form.append('disable_notification', 'true');

  form.append('photo', await openAsBlob(filePath, { type: mime }), fileName);
  form.append('live_photo', await openAsBlob(videoPath, { type: videoMime ?? 'video/quicktime' }), videoName);

  const result = await call('sendLivePhoto', form, { retries: 1 });
  return { messageId: result.message_id, method: 'bot', ...extractMedia(result) };
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

/* ── переписка с ботом (режим команд) ────────────────────────────────────── */

export async function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4096),
    disable_notification: true,
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

export async function editMessageText(chatId, messageId, text, extra = {}) {
  try {
    return await call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4096),
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch (err) {
    // «message is not modified» — не ошибка, просто текст не изменился
    if (/not modified/i.test(err.description ?? '')) return null;
    throw err;
  }
}

/** Отправляет уже загруженный файл по file_id — мгновенно, без повторной загрузки. */
export async function sendByFileId(chatId, fileType, fileId, extra = {}) {
  const methods = {
    photo: ['sendPhoto', 'photo'],
    video: ['sendVideo', 'video'],
    animation: ['sendAnimation', 'animation'],
    document: ['sendDocument', 'document'],
    audio: ['sendAudio', 'audio'],
    voice: ['sendVoice', 'voice'],
    video_note: ['sendVideoNote', 'video_note'],
  };
  const [method, field] = methods[fileType] ?? methods.document;
  const result = await call(method, { chat_id: chatId, [field]: fileId, ...extra });
  return result.message_id;
}

/** Пересобирает Live Photo из уже загруженных file_id — без повторной загрузки. */
export async function sendLivePhotoByFileId(chatId, photoFileId, videoFileId, extra = {}) {
  const result = await call('sendLivePhoto', {
    chat_id: chatId,
    photo: photoFileId,
    live_photo: videoFileId,
    ...extra,
  });
  return result.message_id;
}

/** Удаляет сообщение из хранилища (бот должен быть админом с правом удаления). */
export async function deleteMessage(chatId, messageId) {
  return call('deleteMessage', { chat_id: chatId, message_id: messageId }, { retries: 1 });
}

/** Копирует сообщение из хранилища — работает и когда file_id нет (файл ушёл через аккаунт). */
export async function copyMessage(toChatId, fromChatId, messageId, extra = {}) {
  const result = await call('copyMessage', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...extra,
  });
  return result.message_id;
}

export async function getUpdates(offset, timeoutSec = 30) {
  return call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, { retries: 2 });
}

/**
 * Отправка сообщения токеном конкретного профиля — минуя текущие настройки.
 * Так код входа уходит через бота того профиля, в который вы входите.
 */
export async function sendMessageWithToken({ token, apiRoot, chatId, text }) {
  const root = (apiRoot || 'https://api.telegram.org').replace(/\/+$/, '');
  const res = await fetch(`${root}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_notification: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(body.description ?? `Telegram ответил ${res.status}`);
  return body.result;
}

export async function setMyCommands(commands) {
  return call('setMyCommands', { commands });
}
