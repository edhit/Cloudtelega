import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';
import { config, MTPROTO_UPLOAD_LIMIT } from '../config.js';
import { log, humanSize, progressBar } from '../logger.js';

// teleproto (поддерживаемый форк GramJS) — CommonJS-пакет,
// подключаем через require, чтобы не зависеть от интеропа ESM.
const require = createRequire(import.meta.url);

let client = null;
let peerCache = null;

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
    peerCache = null;
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
    onError: (err) => log.error('Ошибка входа:', err.message ?? err),
  });

  const me = await c.getMe();
  const sessionString = c.session.save();
  await c.disconnect();
  rl.close();

  saveSessionToEnv(sessionString);
  return { me, sessionString };
}

/** Дописывает TELEGRAM_SESSION в .env (или обновляет существующую строку). */
function saveSessionToEnv(sessionString) {
  const envPath = path.resolve('.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    content = '';
  }
  const line = `TELEGRAM_SESSION=${sessionString}`;
  if (/^TELEGRAM_SESSION=.*$/m.test(content)) {
    content = content.replace(/^TELEGRAM_SESSION=.*$/m, line);
  } else {
    content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${line}\n`;
  }
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  config.session = sessionString;
  log.ok(`Сессия сохранена в ${envPath}`);
}

/** Находит канал/группу по id (-100...) или @username. */
export async function resolvePeer() {
  if (peerCache) return peerCache;
  const c = await getClient();
  const raw = String(config.chatId).trim();

  try {
    const value = raw.startsWith('@') || Number.isNaN(Number(raw)) ? raw : Number(raw);
    peerCache = await c.getInputEntity(value);
    return peerCache;
  } catch {
    /* пробуем через список диалогов ниже */
  }

  const dialogs = await c.getDialogs({ limit: 500 });
  const wanted = raw.replace(/^@/, '').toLowerCase();
  for (const d of dialogs) {
    const id = d.id?.toString();
    const username = d.entity?.username?.toLowerCase();
    if (id === raw || id === raw.replace(/^-100/, '') || `-100${id}` === raw || username === wanted) {
      peerCache = await c.getInputEntity(d.entity);
      return peerCache;
    }
  }
  throw new Error(`Не найден чат ${raw}. Аккаунт должен состоять в этом канале/группе.`);
}

/**
 * Отправляет файл от имени аккаунта. Лимит — 2 ГБ (4 ГБ с Premium).
 * @returns {Promise<{messageId:number, method:'mtproto'}>}
 */
export async function sendFileViaAccount({ filePath, fileName, size, caption, parseMode, asDocument, topicId }) {
  if (size > MTPROTO_UPLOAD_LIMIT) {
    const err = new Error(`Файл больше ${humanSize(MTPROTO_UPLOAD_LIMIT)} — Telegram не примет`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const { CustomFile } = loadGramJs();
  const c = await getClient();
  const peer = await resolvePeer();

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
export async function listForumTopics(limit = 100) {
  const { Api } = loadGramJs();
  const c = await getClient();
  const peer = await resolvePeer();
  const res = await c.invoke(
    new Api.messages.GetForumTopics({ peer, offsetDate: 0, offsetId: 0, offsetTopic: 0, limit }),
  );
  return (res.topics ?? [])
    .filter((t) => t.title !== undefined)
    .map((t) => ({ id: Number(t.id), title: String(t.title) }));
}

/** Создаёт топик от имени аккаунта (аккаунт должен быть админом с правом на темы). */
export async function createForumTopicViaAccount(title) {
  const { Api, generateRandomLong } = loadGramJs();
  const c = await getClient();
  const peer = await resolvePeer();
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
