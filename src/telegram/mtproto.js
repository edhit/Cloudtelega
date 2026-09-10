import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';
import { config, reloadConfig, mtprotoLimit } from '../config.js';
import { updateEnv } from '../env.js';
import { log, humanSize, progressBar } from '../logger.js';
import { describeError } from '../errors.js';

// teleproto (поддерживаемый форк GramJS) — CommonJS-пакет,
// подключаем через require, чтобы не зависеть от интеропа ESM.
const require = createRequire(import.meta.url);

let client = null;
const peerCache = new Map();

function loadGramJs() {
  const { TelegramClient, Api } = require('teleproto');
  const { StringSession } = require('teleproto/sessions/index.js');
  const { CustomFile } = require('teleproto/client/uploads.js');
  const { generateRandomLong } = require('teleproto/Helpers.js');
  return { TelegramClient, Api, StringSession, CustomFile, generateRandomLong };
}

export function mtprotoConfigured() {
  return Boolean(config.apiId && config.apiHash && config.session);
}

export function canLogin() {
  return Boolean(config.apiId && config.apiHash);
}

/** Создаёт и подключает клиент от имени аккаунта (нужен для файлов > 50 МБ). */
export async function getClient() {
  if (client?.connected) return client;
  if (!canLogin()) {
    throw new Error('Не заданы TELEGRAM_API_ID / TELEGRAM_API_HASH (my.telegram.org → API development tools)');
  }

  const { TelegramClient, StringSession } = loadGramJs();
  client = new TelegramClient(new StringSession(config.session || ''), config.apiId, config.apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 24 * 60 * 60, // GramJS сам переждёт FLOOD_WAIT
    useWSS: false,
  });

  try {
    client.setLogLevel('error');
  } catch {
    /* в старых версиях метода нет */
  }

  await client.connect();
  return client;
}

export async function disconnect() {
  if (client) {
    await client.disconnect().catch(() => {});
    await client.destroy?.().catch(() => {});
    client = null;
    peerCache.clear();
  }
}

/** Интерактивный вход в аккаунт: телефон → код → (при необходимости) пароль 2FA. */
export async function login() {
  if (!canLogin()) {
    throw new Error('Сначала заполните TELEGRAM_API_ID и TELEGRAM_API_HASH в .env');
  }
  const { TelegramClient, StringSession } = loadGramJs();
  const rl = readline.createInterface({ input, output });

  const session = new StringSession(config.session || '');
  const c = new TelegramClient(session, config.apiId, config.apiHash, { connectionRetries: 5 });
  try {
    c.setLogLevel('error');
  } catch {
    /* noop */
  }

  await c.start({
    phoneNumber: async () => (await rl.question('Номер телефона (+7...): ')).trim(),
    password: async () => (await rl.question('Пароль двухфакторной авторизации: ')).trim(),
    phoneCode: async () => (await rl.question('Код из Telegram: ')).trim(),
    onError: (err) => log.error('Ошибка входа:', describeError(err, { kind: 'mtproto' })),
  });

  const me = await c.getMe();
  const sessionString = c.session.save();
  await c.disconnect();
  rl.close();

  saveSessionToEnv(sessionString);
  return { me, sessionString };
}

/** Сохраняет строку сессии в .env. Это полный доступ к аккаунту — файл только для владельца. */
function saveSessionToEnv(sessionString) {
  const file = updateEnv({ TELEGRAM_SESSION: sessionString });
  config.session = sessionString;
  log.ok(`Сессия сохранена в ${file}`);
}

/**
 * Находит канал/группу по id (-100...) или @username.
 * Кэш по чату: у архива снимков и у диска чаты разные.
 */
export async function resolvePeer(chatId = config.chatId) {
  const raw = String(chatId).trim();
  if (!raw) throw new Error('Не задан чат');
  if (peerCache.has(raw)) return peerCache.get(raw);

  const c = await getClient();

  try {
    const value = raw.startsWith('@') || Number.isNaN(Number(raw)) ? raw : Number(raw);
    const peer = await c.getInputEntity(value);
    peerCache.set(raw, peer);
    return peer;
  } catch {
    /* пробуем через список диалогов ниже */
  }

  const dialogs = await c.getDialogs({ limit: 500 });
  const wanted = raw.replace(/^@/, '').toLowerCase();
  for (const d of dialogs) {
    const id = d.id?.toString();
    const username = d.entity?.username?.toLowerCase();
    if (id === raw || id === raw.replace(/^-100/, '') || `-100${id}` === raw || username === wanted) {
      const peer = await c.getInputEntity(d.entity);
      peerCache.set(raw, peer);
      return peer;
    }
  }
  throw new Error(`Не найден чат ${raw}. Аккаунт должен состоять в этом канале/группе.`);
}

/**
 * Отправляет файл от имени аккаунта. Лимит — 2 ГБ (4 ГБ с Premium).
 * @returns {Promise<{messageId:number, method:'mtproto'}>}
 */
export async function sendFileViaAccount({ filePath, fileName, size, caption, parseMode, asDocument, topicId, chatId = config.chatId }) {
  const limit = await mtprotoLimit();
  if (size > limit) {
    const err = new Error(`Файл больше ${humanSize(limit)} — Telegram не примет`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const { CustomFile } = loadGramJs();
  const c = await getClient();
  const peer = await resolvePeer(chatId);

  let lastPrint = 0;
  const msg = await c.sendFile(peer, {
    file: new CustomFile(fileName, size, filePath),
    caption: caption?.slice(0, 1024),
    parseMode: parseMode ? parseMode.toLowerCase() : undefined,
    forceDocument: asDocument ?? config.sendAsDocument,
    silent: true,
    workers: 4,
    topMsgId: topicId || undefined,
    progressCallback: (progress) => {
      const now = Date.now();
      if (now - lastPrint < 1000) return;
      lastPrint = now;
      process.stdout.write(`\r  ${progressBar(Number(progress))} ${fileName}   `);
    },
  });
  process.stdout.write('\r\x1b[2K');

  // file_id из Bot API у MTProto нет: такие сообщения переиспользуются через copyMessage
  return { messageId: msg.id, method: 'mtproto', fileType: null, fileId: null, fileUniqueId: null, videoFileId: null };
}

/** Список существующих топиков форум-супергруппы: [{ id, title }]. */
export async function listForumTopics(limit = 100, chatId = config.chatId) {
  const { Api } = loadGramJs();
  const c = await getClient();
  const peer = await resolvePeer(chatId);
  const res = await c.invoke(
    new Api.messages.GetForumTopics({ peer, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit }),
  );
  return (res.topics ?? [])
    .filter((t) => t.title !== undefined)
    .map((t) => ({ id: Number(t.id), title: String(t.title) }));
}

/** Создаёт топик от имени аккаунта (аккаунт должен быть админом с правом на темы). */
export async function createForumTopicViaAccount(title, chatId = config.chatId) {
  const { Api, generateRandomLong } = loadGramJs();
  const c = await getClient();
  const peer = await resolvePeer(chatId);
  const updates = await c.invoke(
    new Api.messages.CreateForumTopic({ peer, title, randomId: generateRandomLong() }),
  );
  // id топика — это id служебного сообщения о его создании.
  for (const u of updates.updates ?? []) {
    const id = u.message?.id ?? u.id;
    if (id) return Number(id);
  }
  throw new Error(`Топик «${title}» создан, но Telegram не вернул его id`);
}

export async function whoAmI() {
  const c = await getClient();
  return c.getMe();
}

/* ── создание хранилища «под ключ» ───────────────────────────────────────── */

/**
 * Создаёт супергруппу с темами и делает бота администратором.
 * Бот сам себе группу создать не может — это умеет только аккаунт,
 * поэтому вся тяжёлая работа берётся на себя здесь.
 *
 * @param {{title:string, about?:string, topics?:boolean, botUsername:string}} opts
 * @returns {Promise<{chatId:string, title:string, isForum:boolean, warnings:string[]}>}
 */
export async function createStorageGroup({ title, about = 'Архив фото и видео', topics = true, botUsername }) {
  const { Api } = loadGramJs();
  const c = await getClient();
  const warnings = [];

  const created = await c.invoke(
    new Api.channels.CreateChannel({ title, about, megagroup: true, forum: topics }),
  );
  const channel = created.chats?.find((ch) => ch.className === 'Channel' || ch.megagroup);
  if (!channel) throw new Error('Telegram не вернул созданную группу');

  let isForum = Boolean(channel.forum);
  if (topics && !isForum) {
    // Часть аккаунтов включает темы отдельным вызовом
    try {
      await c.invoke(new Api.channels.ToggleForum({ channel, enabled: true, tabs: false }));
      isForum = true;
    } catch (err) {
      warnings.push(`Темы включить не удалось (${describeError(err, { kind: 'mtproto' })}). Включите их в настройках группы вручную.`);
    }
  }

  const bot = String(botUsername).replace(/^@/, '');
  try {
    await c.invoke(new Api.channels.InviteToChannel({ channel, users: [bot] }));
  } catch (err) {
    // Бот мог добавиться сам, если уже состоял в группе
    warnings.push(`Не удалось добавить бота (${describeError(err, { kind: 'mtproto' })})`);
  }

  try {
    await c.invoke(
      new Api.channels.EditAdmin({
        channel,
        userId: bot,
        adminRights: new Api.ChatAdminRights({
          changeInfo: true,
          postMessages: true,
          editMessages: true,
          deleteMessages: true,
          inviteUsers: true,
          pinMessages: true,
          manageTopics: true,
        }),
        rank: 'архивариус',
      }),
    );
  } catch (err) {
    warnings.push(`Не удалось выдать боту права администратора (${describeError(err, { kind: 'mtproto' })}). Сделайте это вручную.`);
  }

  peerCache.clear();
  return { chatId: `-100${channel.id}`, title, isForum, warnings };
}

/* ── вход из браузера (веб-мастер настройки) ─────────────────────────────── */

let webLogin = null;

/** Что сейчас нужно от пользователя: код из Telegram, пароль 2FA, или всё готово. */
export function webLoginState() {
  if (!webLogin) return { stage: 'idle' };

  // Если Telegram не отвечает (нет сети, неверный api_id), не оставляем страницу в подвешенном виде.
  const stuck = webLogin.stage === 'starting' && Date.now() - webLogin.startedAt > 45_000;
  if (stuck && !webLogin.error) {
    webLogin.stage = 'error';
    webLogin.error = 'Telegram не ответил. Проверьте api_id, api_hash и интернет';
  }
  return { stage: webLogin.stage, error: webLogin.error ?? null, user: webLogin.user ?? null };
}

/**
 * Начинает вход по номеру телефона. Код и пароль приходят позже,
 * отдельными вызовами — их вводят на странице настройки.
 */
export async function startWebLogin({ apiId, apiHash, phone }) {
  await cancelWebLogin();

  const { TelegramClient, StringSession } = loadGramJs();
  const client = new TelegramClient(new StringSession(''), Number(apiId), String(apiHash), {
    connectionRetries: 5,
  });
  try {
    client.setLogLevel('error');
  } catch {
    /* noop */
  }

  const ask = (stage) =>
    new Promise((resolve) => {
      webLogin.stage = stage;
      webLogin.resolvers[stage] = resolve;
    });

  webLogin = { client, stage: 'starting', resolvers: {}, error: null, user: null, startedAt: Date.now() };

  client
    .start({
      phoneNumber: async () => String(phone),
      phoneCode: () => ask('code'),
      password: () => ask('password'),
      onError: (err) => {
        webLogin.error = err?.message ?? String(err);
      },
    })
    .then(async () => {
      const me = await client.getMe();
      saveSessionToEnv(client.session.save());
      reloadConfig();
      webLogin.user = { name: [me.firstName, me.lastName].filter(Boolean).join(' '), username: me.username ?? null };
      webLogin.stage = 'done';
      await client.disconnect().catch(() => {});
    })
    .catch((err) => {
      webLogin.error = err?.message ?? String(err);
      webLogin.stage = 'error';
    });

  // Даём GramJS дойти до запроса кода, чтобы страница сразу показала нужное поле.
  await new Promise((r) => setTimeout(r, 1200));
  return webLoginState();
}

export function submitWebLogin(stage, value) {
  if (!webLogin) throw new Error('Вход не начат');
  const resolve = webLogin.resolvers[stage];
  if (!resolve) throw new Error(`Сейчас нужен не «${stage}», а «${webLogin.stage}»`);
  webLogin.resolvers[stage] = null;
  webLogin.error = null;
  webLogin.stage = 'checking';
  resolve(String(value));
  return webLoginState();
}

export async function cancelWebLogin() {
  if (!webLogin) return;
  await webLogin.client?.disconnect().catch(() => {});
  webLogin = null;
}

/* ── аккаунт: аватар, имя, Premium ───────────────────────────────────────── */

/** Кто вошёл: имя, username, телефон и есть ли Premium (от него зависит лимит файла). */
export async function accountInfo() {
  const me = await whoAmI();
  return {
    id: String(me.id),
    firstName: me.firstName ?? '',
    lastName: me.lastName ?? '',
    name: [me.firstName, me.lastName].filter(Boolean).join(' '),
    username: me.username ?? null,
    phone: me.phone ? `+${me.phone}` : null,
    premium: Boolean(me.premium),
  };
}

/** Скачивает аватар аккаунта, чтобы показывать его в программе. */
export async function downloadMyAvatar() {
  const c = await getClient();
  const buffer = await c.downloadProfilePhoto('me', { isBig: true });
  return buffer && buffer.length ? Buffer.from(buffer) : null;
}

/** Отправляет сообщение самому себе («Избранное») — так приходит код входа. */
export async function messageSelf(text) {
  const c = await getClient();
  await c.sendMessage('me', { message: text });
  return true;
}

/* ── обратная дорога: скачать файл из Telegram ───────────────────────────── */

/**
 * Скачивает вложение сообщения на диск. Через аккаунт, а не бота: Bot API
 * отдаёт на скачивание только файлы до 20 МБ, а на диске лежат и большие.
 * @param {{chatId:string, messageId:number, destPath:string, onProgress?:(done:number,total:number)=>void}} opts
 * @returns {Promise<number>} сколько байт записали
 */
export async function downloadMessageFile({ chatId, messageId, destPath, onProgress }) {
  const c = await getClient();
  const peer = await resolvePeer(chatId);

  const [msg] = await c.getMessages(peer, { ids: [Number(messageId)] });
  if (!msg) throw new Error(`Сообщение ${messageId} не найдено — возможно, его удалили`);
  if (!msg.media) throw new Error(`В сообщении ${messageId} нет вложения`);

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const buffer = await c.downloadMedia(msg, {
    progressCallback: (done, total) => onProgress?.(Number(done), Number(total)),
  });
  if (!buffer?.length) throw new Error('Telegram отдал пустой файл');

  await fs.promises.writeFile(destPath, buffer);
  return buffer.length;
}

/* ── участники группы ────────────────────────────────────────────────────── */

/**
 * Кто состоит в вашей группе. Bot API такого не умеет, а аккаунт — умеет:
 * из этого списка удобно выбирать, кому доверить команды боту.
 */
export async function listGroupMembers(limit = 100) {
  const c = await getClient();
  const peer = await resolvePeer();
  const users = await c.getParticipants(peer, { limit });

  return users
    .filter((u) => !u.bot && !u.deleted)
    .map((u) => ({
      id: String(u.id),
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'Без имени',
      username: u.username ?? null,
      self: Boolean(u.self),
    }));
}

/** Аватар пользователя — отдаём буфером, на диск ничего не пишем. */
export async function downloadUserPhoto(userId) {
  const c = await getClient();
  const buffer = await c.downloadProfilePhoto(Number(userId), { isBig: false });
  return buffer && buffer.length ? Buffer.from(buffer) : null;
}
