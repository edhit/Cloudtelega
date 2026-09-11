import { openAsBlob } from 'node:fs';
import { config, BOT_UPLOAD_LIMIT } from '../config.js';
import { log } from '../logger.js';
import { botApiAdvice, describeError, explainError } from '../errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method) {
  return `${config.botApiRoot}/bot${config.botToken}/${method}`;
}

/** Куда именно стучимся — без токена, его в лог писать нельзя. */
function endpointOf(method) {
  return `${config.botApiRoot}/bot***/${method}`;
}

async function call(method, payload, { retries = 3, signal } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    const startedAt = Date.now();

    try {
      const isForm = payload instanceof FormData;
      res = await fetch(api(method), {
        method: 'POST',
        body: isForm ? payload : JSON.stringify(payload),
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        signal,
      });
    } catch (err) {
      // Запрос оборвали намеренно (остановили бота) — повторять нечего
      if (err.name === 'AbortError' || signal?.aborted) throw err;

      // «fetch failed» само по себе ни о чём не говорит: настоящая причина
      // лежит в err.cause, её и показываем.
      const why = explainError(err);
      const spent = Date.now() - startedAt;

      if (attempt > retries) {
        const fatal = new Error(`${method}: не удалось связаться с Telegram — ${describeError(err)}`);
        fatal.code = 'NETWORK';
        fatal.method = method;
        fatal.endpoint = endpointOf(method);
        fatal.cause = err;
        throw fatal;
      }

      const wait = 2 ** attempt * 1000;
      log.warn(
        `Bot API ${method}: ${why}. Попытка ${attempt} из ${retries + 1} заняла ${spent} мс, ` +
        `повтор через ${wait} мс. Адрес: ${endpointOf(method)}`,
      );
      await sleep(wait);
      continue;
    }

    let body;
    let raw = '';
    try {
      raw = await res.text();
      body = JSON.parse(raw);
    } catch {
      // Не JSON — обычно так отвечает прокси или страница-заглушка провайдера
      body = { ok: false, description: raw.slice(0, 200).replace(/\s+/g, ' ').trim() || `пустой ответ, HTTP ${res.status}` };
    }

    if (body.ok) return body.result;

    const description = body.description ?? `HTTP ${res.status}`;

    // Flood limit — Telegram сам говорит, сколько ждать.
    const retryAfter = body.parameters?.retry_after;
    if (retryAfter && attempt <= retries + 2) {
      log.warn(
        `Bot API ${method}: Telegram придержал бота (flood limit), просит подождать ${retryAfter} с. ` +
        'Так бывает при слишком частых запросах — программа ждёт и продолжает сама.',
      );
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    if (res.status >= 500 && attempt <= retries) {
      const wait = 2 ** attempt * 1000;
      log.warn(`Bot API ${method}: сбой на стороне Telegram — HTTP ${res.status}, «${description}». Повтор через ${wait} мс`);
      await sleep(wait);
      continue;
    }

    const advice = botApiAdvice(description, res.status);
    const err = new Error(
      `Bot API ${method}: ${description} (HTTP ${res.status}` +
      `${body.error_code && body.error_code !== res.status ? `, код ${body.error_code}` : ''})` +
      `${advice ? `. ${advice}` : ''}`,
    );
    err.code = res.status;
    err.method = method;
    err.description = description;
    err.retryAfter = retryAfter ?? null;
    err.advice = advice;
    throw err;
  }
}

/** Достаёт file_id из ответа Telegram: его можно переиспользовать без повторной загрузки. */
export function extractMedia(msg) {
  if (msg?.live_photo) {
    const sizes = msg.live_photo.photo ?? [];
    return {
      fileType: 'live_photo',
      fileId: sizes.at(-1)?.file_id ?? null,
      fileUniqueId: sizes.at(-1)?.file_unique_id ?? null,
      videoFileId: msg.live_photo.file_id ?? null,
      // Самый маленький размер — готовая миниатюра, её отдаёт сам Telegram
      thumbFileId: sizes[0]?.file_id ?? null,
    };
  }
  if (msg?.photo?.length) {
    const best = msg.photo.at(-1); // последний размер — самый большой
    return {
      fileType: 'photo',
      fileId: best.file_id,
      fileUniqueId: best.file_unique_id,
      videoFileId: null,
      thumbFileId: msg.photo[0]?.file_id ?? null,
    };
  }
  for (const key of ['video', 'animation', 'document', 'audio', 'voice', 'video_note']) {
    if (msg?.[key]) {
      return {
        fileType: key,
        fileId: msg[key].file_id,
        fileUniqueId: msg[key].file_unique_id,
        videoFileId: null,
        thumbFileId: msg[key].thumbnail?.file_id ?? msg[key].thumb?.file_id ?? null,
      };
    }
  }
  return { fileType: null, fileId: null, fileUniqueId: null, videoFileId: null, thumbFileId: null };
}

export function botConfigured() {
  return Boolean(config.botToken);
}

export async function getMe() {
  return call('getMe', {});
}

/** Права бота в чате: без права публиковать сообщения ничего не выйдет. */
/** Путь к файлу на серверах Telegram — по нему миниатюру можно скачать. */
export async function getFilePath(fileId) {
  const file = await call('getFile', { file_id: fileId }, { retries: 1 });
  return file.file_path;
}

export function fileUrl(filePath) {
  return `${config.botApiRoot}/file/bot${config.botToken}/${filePath}`;
}

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
export async function sendFileViaBot({ filePath, fileName, size, mime, caption, parseMode, kind, asDocument, topicId, chatId = config.chatId }) {
  if (config.botApiRoot === 'https://api.telegram.org' && size > BOT_UPLOAD_LIMIT) {
    const err = new Error('Файл больше 50 МБ — Bot API не примет');
    err.code = 'TOO_LARGE';
    throw err;
  }

  const useDocument = asDocument ?? config.sendAsDocument;
  const method = useDocument ? 'sendDocument' : kind === 'video' ? 'sendVideo' : 'sendPhoto';
  const field = useDocument ? 'document' : kind === 'video' ? 'video' : 'photo';

  const form = new FormData();
  form.append('chat_id', String(chatId));
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
export async function createForumTopicViaBot(title, chatId = config.chatId) {
  const result = await call('createForumTopic', { chat_id: chatId, name: title });
  return result.message_thread_id;
}

/**
 * Удаляет тему вместе со всеми сообщениями в ней. Telegram отдельной «корзины»
 * для темы не держит: удаление необратимо, поэтому наверху обязательно
 * спрашиваем подтверждение.
 */
export async function deleteForumTopic(topicId, chatId = config.chatId) {
  await call('deleteForumTopic', { chat_id: chatId, message_thread_id: topicId });
  return true;
}

/** Меняет подпись у уже отправленного файла — так живут заметки к файлам. */
export async function editMessageCaption(chatId, messageId, caption, extra = {}) {
  return call('editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption,
    ...extra,
  });
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

// Кроме личных сообщений нас интересует, куда бота добавили: по этим апдейтам
// мастер находит группы и каналы, не спрашивая у пользователя числовой id.
const WATCHED_UPDATES = [
  'message', 'edited_message', 'channel_post', 'my_chat_member',
  // chat_member показывает, кто вошёл и по какой ссылке; без него не понять,
  // кому и когда закрывать доступ. Telegram шлёт его только если явно попросить.
  'chat_member', 'chat_join_request',
];

export async function getUpdates(offset, timeoutSec = 30, { allowedUpdates = WATCHED_UPDATES, signal } = {}) {
  return call(
    'getUpdates',
    { offset, timeout: timeoutSec, allowed_updates: allowedUpdates },
    { retries: 2, signal },
  );
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

/* ── доступ к чату: ссылки-приглашения и участники ───────────────────────── */

/**
 * Ссылка-приглашение с сроком жизни. Такую ссылку Telegram сам перестаёт
 * принимать после expireDate, а memberLimit ограничивает число входов.
 * @param {{chatId?:string, name?:string, expireDate?:number, memberLimit?:number, joinRequest?:boolean}} opts
 */
export async function createChatInviteLink({ chatId = config.chatId, name, expireDate, memberLimit, joinRequest } = {}) {
  const payload = { chat_id: chatId };
  if (name) payload.name = name.slice(0, 32);
  if (expireDate) payload.expire_date = Math.floor(expireDate / 1000);
  // Telegram не разрешает одновременно лимит и заявки на вступление
  if (joinRequest) payload.creates_join_request = true;
  else if (memberLimit) payload.member_limit = memberLimit;
  return call('createChatInviteLink', payload);
}

export async function revokeChatInviteLink(inviteLink, chatId = config.chatId) {
  return call('revokeChatInviteLink', { chat_id: chatId, invite_link: inviteLink });
}

export async function getChatMemberCount(chatId = config.chatId) {
  return call('getChatMemberCount', { chat_id: chatId });
}

export async function banChatMember(userId, { chatId = config.chatId, untilDate, revokeMessages = false } = {}) {
  const payload = { chat_id: chatId, user_id: Number(userId), revoke_messages: revokeMessages };
  if (untilDate) payload.until_date = Math.floor(untilDate / 1000);
  return call('banChatMember', payload);
}

export async function unbanChatMember(userId, { chatId = config.chatId, onlyIfBanned = true } = {}) {
  return call('unbanChatMember', { chat_id: chatId, user_id: Number(userId), only_if_banned: onlyIfBanned });
}

/**
 * Выгнать, но не забанить. В Bot API отдельной команды «kick» нет: сначала
 * бан (он и выкидывает из чата), сразу за ним разбан — и человек снова может
 * войти по новой ссылке. Без разбана он остался бы в чёрном списке навсегда.
 */
export async function kickWithoutBan(userId, { chatId = config.chatId } = {}) {
  await banChatMember(userId, { chatId });
  await unbanChatMember(userId, { chatId, onlyIfBanned: true });
  return true;
}

export async function approveChatJoinRequest(userId, chatId = config.chatId) {
  return call('approveChatJoinRequest', { chat_id: chatId, user_id: Number(userId) });
}

export async function declineChatJoinRequest(userId, chatId = config.chatId) {
  return call('declineChatJoinRequest', { chat_id: chatId, user_id: Number(userId) });
}

/** Права обычных участников чата: для «диска» их обычно урезают до чтения. */
export async function setChatPermissions(permissions, chatId = config.chatId) {
  return call('setChatPermissions', { chat_id: chatId, permissions });
}

export async function setMyCommands(commands) {
  return call('setMyCommands', { commands });
}
