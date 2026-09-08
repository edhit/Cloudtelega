import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, heicMode, livePhotoMode, pairPrefer, reloadConfig } from '../config.js';
import { envExists, envPath, updateEnv } from '../env.js';
import { closeDb, countFiles, fileIdCoverage, listFiles, listTopics, sqliteDriver, stats } from '../db.js';
import { detectIosDevices, inspectMount, listMountPoints, mountHint } from '../devices.js';
import { log, humanSize } from '../logger.js';
import { buildCaption } from '../caption.js';
import { collect, isRunning, requestStop, runSend, sendState } from '../pipeline.js';
import { cleanupStrayLiveVideos, describeStray } from '../cleanup.js';
import { botConfigured, getChat, getChatMember, getMe, getUpdates } from '../telegram/botApi.js';
import {
  cancelWebLogin, createStorageGroup, disconnect as disconnectAccount, mtprotoConfigured,
  startWebLogin, submitWebLogin, webLoginState, whoAmI,
} from '../telegram/mtproto.js';
import { createProfile, deleteProfile, listProfiles, setActiveProfile } from '../profiles.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/* ── фоновая работа (сканирование / отправка) ────────────────────────────── */

const job = { mode: null, summary: null, error: null, finished: null, lines: [] };

function note(text) {
  job.lines.push(text);
  if (job.lines.length > 60) job.lines.shift();
}

async function startScan() {
  if (job.mode) throw new Error('Уже идёт другая операция');
  job.mode = 'scan';
  job.summary = null;
  job.error = null;
  job.finished = null;
  job.lines = ['Считаю файлы, хеши и даты съёмки…'];

  collect({ roots: config.scanPaths })
    .then(({ summary, dropped }) => {
      job.summary = { ...summary, dropped: dropped.length };
      note(`Найдено ${summary.count} файлов, ${humanSize(summary.bytes)}`);
    })
    .catch((err) => {
      job.error = err.message;
    })
    .finally(() => {
      job.mode = null;
      job.finished = 'scan';
    });
}

async function startSend() {
  if (job.mode || isRunning()) throw new Error('Уже идёт другая операция');
  job.mode = 'send';
  job.summary = null;
  job.error = null;
  job.finished = null;
  job.lines = ['Сканирую каталоги…'];

  runSend({
    roots: config.scanPaths,
    hooks: {
      onScanned: ({ summary, dropped }) => {
        job.summary = { ...summary, dropped: dropped.length };
        note(`Найдено ${summary.count} файлов, ${humanSize(summary.bytes)}. Начинаю отправку…`);
      },
      onFile: ({ index, total, file, status, error }) => {
        const name = file.relPath || file.name;
        if (status === 'sent') note(`✓ ${index}/${total} ${name}`);
        else if (status === 'duplicate') note(`⏭ ${index}/${total} ${name} — уже в архиве`);
        else if (status === 'failed') note(`✗ ${index}/${total} ${name}: ${error}`);
      },
      onFinish: (r) => {
        note(`Готово: отправлено ${r.sent} (${humanSize(r.bytesSent)}), дублей ${r.duplicates}, ошибок ${r.failed}`);
      },
    },
  })
    .catch((err) => {
      job.error = err.message;
    })
    .finally(() => {
      job.mode = null;
      job.finished = 'send';
    });
}

/* ── состояние для страницы ──────────────────────────────────────────────── */

const mask = (value, tail = 4) =>
  !value ? '' : `${'•'.repeat(Math.max(0, Math.min(12, value.length - tail)))}${value.slice(-tail)}`;

async function buildState() {
  const state = {
    envPath: envPath(),
    envExists: envExists(),
    platform: os.platform(),
    profile: config.profile,
    profiles: listProfiles().map(({ name, active, configured, dbSize }) => ({ name, active, configured, dbSize })),
    settings: {
      botToken: mask(config.botToken, 6),
      botTokenSet: Boolean(config.botToken),
      chatId: config.chatId,
      topicMode: config.topicMode,
      topicId: config.topicId ?? '',
      apiId: config.apiId || '',
      apiHash: mask(config.apiHash, 4),
      apiHashSet: Boolean(config.apiHash),
      sessionSet: Boolean(config.session),
      scanPaths: config.scanPaths,
      sendAsDocument: config.sendAsDocument,
      heicMode: config.heicMode,
      effectiveHeicMode: heicMode(),
      keepHeicOriginal: config.keepHeicOriginal,
      livePhotoVideos: config.livePhotoVideos,
      effectiveLivePhoto: livePhotoMode(),
      pairPrefer: config.pairPrefer,
      effectivePairPrefer: pairPrefer(),
      captionStyle: config.captionStyle,
      adminIds: config.adminIds,
      sendDelayMs: config.sendDelayMs,
    },
    checks: { bot: null, chat: null, account: null },
    job: { ...job, running: Boolean(job.mode), send: sendState() },
  };

  try {
    const db = stats();
    state.stats = {
      total: db.total,
      byStatus: db.byStatus,
      byYear: db.byYear,
      topics: listTopics(config.chatId).length,
      fileIds: fileIdCoverage(),
    };
  } catch {
    state.stats = null;
  }

  return state;
}

/** Полная проверка: бот, права в чате, аккаунт. */
async function runChecks() {
  const result = { bot: null, chat: null, account: null };

  if (botConfigured()) {
    try {
      const me = await getMe();
      result.bot = { ok: true, username: me.username, id: me.id };

      if (config.chatId) {
        try {
          const chat = await getChat();
          const member = await getChatMember(config.chatId, me.id).catch(() => null);
          const canPost =
            member?.status === 'creator' ||
            (member?.status === 'administrator' && member?.can_post_messages !== false);
          result.chat = {
            ok: canPost,
            title: chat.title ?? chat.username ?? String(chat.id),
            type: chat.type,
            isForum: Boolean(chat.is_forum),
            status: member?.status ?? 'unknown',
            problem: canPost
              ? null
              : 'Бот не администратор чата или ему запрещено публиковать сообщения',
          };
        } catch (err) {
          result.chat = { ok: false, problem: err.message };
        }
      }
    } catch (err) {
      result.bot = { ok: false, problem: err.message };
    }
  }

  if (mtprotoConfigured()) {
    try {
      const me = await whoAmI();
      result.account = {
        ok: true,
        name: [me.firstName, me.lastName].filter(Boolean).join(' '),
        username: me.username ?? null,
      };
    } catch (err) {
      result.account = { ok: false, problem: err.message };
    }
  }

  return result;
}

/** Ищет каналы и группы, куда бот уже добавлен: по свежим апдейтам. */
async function detectChats() {
  const updates = await getUpdates(0, 0);
  const found = new Map();

  for (const u of updates) {
    const chat =
      u.channel_post?.chat ?? u.message?.chat ?? u.my_chat_member?.chat ?? u.edited_channel_post?.chat;
    if (!chat || chat.type === 'private') continue;
    found.set(String(chat.id), {
      id: String(chat.id),
      title: chat.title ?? String(chat.id),
      type: chat.type,
      isForum: Boolean(chat.is_forum),
    });
  }
  return [...found.values()];
}

/** Пример сообщения во всех вариантах подписи — чтобы выбирать глазами, а не наугад. */
function captionSamples() {
  const sample = {
    name: 'IMG_0373.jpg',
    relPath: '2020/IMG_0373.jpg',
    size: 3355443,
    takenAt: new Date(2020, 2, 12, 20, 16).getTime(),
    dateSource: 'exif',
    kind: 'photo',
    camera: 'iPhone 13 Pro',
    sha256: 'fb1e7549ae08bcc3d0e2a1b4c7f9e6d5a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8',
  };

  const original = config.captionStyle;
  const out = {};
  try {
    for (const style of ['pretty', 'plain', 'minimal']) {
      config.captionStyle = style;
      out[style] = {
        photo: buildCaption(sample),
        live: buildCaption(sample, { live: true }),
        video: buildCaption({ ...sample, name: 'IMG_0412.MOV', relPath: '2020/IMG_0412.MOV', kind: 'video', camera: null, size: 84 * 1024 * 1024 }),
      };
    }
  } finally {
    config.captionStyle = original;
  }
  return out;
}

/** Кто пишет боту в личку — так узнаётся id владельца без запуска отдельного режима. */
async function detectOwner() {
  const found = [];

  if (mtprotoConfigured()) {
    try {
      const me = await whoAmI();
      found.push({
        id: String(me.id),
        name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'ваш аккаунт',
        source: 'account',
      });
    } catch {
      /* аккаунт не отвечает — попробуем через бота */
    }
  }

  if (botConfigured()) {
    try {
      const updates = await getUpdates(0, 0);
      for (const u of updates) {
        const msg = u.message ?? u.edited_message;
        if (msg?.chat?.type !== 'private' || !msg.from || msg.from.is_bot) continue;
        const id = String(msg.from.id);
        if (found.some((f) => f.id === id)) continue;
        found.push({
          id,
          name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || id,
          source: 'bot',
        });
      }
    } catch {
      /* бот не отвечает — вернём то, что есть */
    }
  }

  return found;
}

async function listDirectories(target) {
  const dir = target ? path.resolve(target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target) : os.homedir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300);
  return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs };
}

/* ── маршруты ────────────────────────────────────────────────────────────── */

const routes = {
  'GET /api/state': async () => buildState(),

  'POST /api/settings': async (body) => {
    const allowed = [
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_TOPIC_ID', 'TOPIC_MODE',
      'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'SCAN_PATHS', 'SEND_AS_DOCUMENT',
      'HEIC_MODE', 'KEEP_HEIC_ORIGINAL', 'LIVE_PHOTO_VIDEOS', 'PAIR_PREFER',
      'CAPTION_STYLE', 'TELEGRAM_ADMIN_IDS', 'SEND_DELAY_MS', 'HEIC_JPEG_QUALITY',
    ];
    const patch = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!allowed.includes(k)) continue;
      const value = String(v ?? '');
      // Секреты пустой строкой не затираем: пустое поле = «не меняю».
      if (!value && ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_HASH', 'TELEGRAM_API_ID'].includes(k)) continue;
      patch[k] = value;
    }
    updateEnv(patch);
    reloadConfig();
    return buildState();
  },

  'POST /api/checks': async () => runChecks(),
  'GET /api/caption-preview': async () => captionSamples(),
  'POST /api/detect-owner': async () => ({ owners: await detectOwner() }),

  'POST /api/create-group': async (body) => {
    if (!mtprotoConfigured()) {
      throw new Error('Сначала подключите аккаунт — группу создаёт он, у бота такого права нет');
    }
    if (!botConfigured()) throw new Error('Сначала сохраните токен бота');

    const me = await getMe();
    const created = await createStorageGroup({
      title: String(body?.title || 'Мой фотоархив').slice(0, 128),
      topics: body?.topics !== false,
      botUsername: me.username,
    });

    updateEnv({
      TELEGRAM_CHAT_ID: created.chatId,
      TOPIC_MODE: created.isForum && body?.topics !== false ? 'year' : 'none',
    });
    reloadConfig();
    return created;
  },

  'GET /api/profiles': async () => ({ profiles: listProfiles(), active: config.profile }),

  'POST /api/profiles/create': async (body) => {
    const name = createProfile(body?.name);
    return { created: name, profiles: listProfiles() };
  },

  'POST /api/profiles/switch': async (body) => {
    if (job.mode || isRunning()) throw new Error('Сейчас идёт отправка — переключите профиль после неё');
    // У другого профиля свой аккаунт и своя база: старые подключения закрываем.
    await cancelWebLogin();
    await disconnectAccount();
    closeDb();
    setActiveProfile(body?.name ?? 'default');
    reloadConfig();
    return buildState();
  },

  'POST /api/profiles/delete': async (body) => {
    deleteProfile(body?.name);
    return { profiles: listProfiles() };
  },

  'POST /api/archive/rows': async (body) => {
    const limit = Math.max(1, Math.min(500, Number(body?.limit) || 100));
    const offset = Math.max(0, Number(body?.offset) || 0);
    const rows = listFiles({ limit, offset });
    const total = countFiles();
    return { rows, total, offset, limit, hasMore: offset + rows.length < total };
  },

  'GET /api/archive': async () => {
    const db = stats();
    // В режиме WAL часть данных лежит в соседнем файле — считаем оба.
    let fileSize = 0;
    for (const file of [config.dbPath, `${config.dbPath}-wal`]) {
      try {
        fileSize += (await fs.stat(file)).size;
      } catch {
        /* файла может не быть */
      }
    }
    return {
      path: config.dbPath,
      driver: sqliteDriver(),
      fileSize,
      total: db.total,
      byStatus: db.byStatus,
      byYear: db.byYear,
      fileIds: fileIdCoverage(),
      topics: listTopics(config.chatId),
      // Первая страница едет сразу, остальные подтягиваются по мере надобности
      page: { rows: listFiles({ limit: 100, offset: 0 }), total: countFiles(), offset: 0, limit: 100 },
    };
  },
  'POST /api/detect-chats': async () => ({ chats: await detectChats() }),

  'POST /api/login/start': async (body) => {
    // Пустые поля означают «оставить то, что уже сохранено», а не «стереть».
    const apiId = String(body.apiId ?? '').trim() || String(config.apiId || '');
    const apiHash = String(body.apiHash ?? '').trim() || config.apiHash;
    if (!apiId || !apiHash) throw new Error('Нужны api_id и api_hash с my.telegram.org');
    if (!String(body.phone ?? '').trim()) throw new Error('Укажите номер телефона');

    updateEnv({ TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash });
    reloadConfig();
    return startWebLogin({ apiId, apiHash, phone: body.phone });
  },
  'POST /api/login/code': async (body) => submitWebLogin('code', body.code),
  'POST /api/login/password': async (body) => submitWebLogin('password', body.password),
  'GET /api/login/state': async () => webLoginState(),
  'POST /api/login/cancel': async () => {
    await cancelWebLogin();
    return { stage: 'idle' };
  },

  'GET /api/devices': async () => {
    const mounts = [];
    for (const m of await listMountPoints()) mounts.push(await inspectMount(m));
    return { mounts, ios: await detectIosDevices(), hint: mountHint() };
  },

  'POST /api/browse': async (body) => listDirectories(body?.path),

  'POST /api/scan': async () => {
    await startScan();
    return { started: true };
  },
  'POST /api/send': async () => {
    await startSend();
    return { started: true };
  },
  'POST /api/stop': async () => ({ stopped: requestStop() }),
  'GET /api/job': async () => ({ ...job, running: Boolean(job.mode), send: sendState() }),

  'POST /api/cleanup': async (body) => {
    const r = await cleanupStrayLiveVideos({ apply: Boolean(body?.apply) });
    return { found: r.found, deleted: r.deleted, failed: r.failed, items: r.rows.slice(0, 30).map(describeStray) };
  },
};

/* ── сервер ──────────────────────────────────────────────────────────────── */

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC_DIR, name);

  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('нельзя');
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('не найдено');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) reject(new Error('слишком большой запрос'));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('ожидался JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function runWeb({ port = 8787, host = '127.0.0.1', open = true } = {}) {
  const token = crypto.randomBytes(12).toString('hex');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Страница открывается по ссылке с токеном, дальше он живёт в cookie.
    const cookieToken = /(?:^|;\s*)ct_token=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    const queryToken = url.searchParams.get('token');
    if (queryToken === token) {
      res.setHeader('set-cookie', `ct_token=${token}; Path=/; SameSite=Strict; HttpOnly`);
    } else if (cookieToken !== token) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Откройте ссылку, которую программа напечатала в терминале.');
      return;
    }

    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];

    if (!handler) {
      if (req.method === 'GET') return serveStatic(req, res);
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"нет такого метода"}');
      return;
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handler(body);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result ?? {}));
    } catch (err) {
      log.error(`${key}: ${err.message}`);
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const link = `http://${host}:${port}/?token=${token}`;
  log.ok(`Мастер настройки запущен. Профиль: ${config.profile}`);
  log.plain('');
  log.plain(`   Откройте в браузере:  ${link}`);
  log.plain('');
  log.info('Ссылка одноразовая для этого запуска. Ctrl+C — остановить.');

  if (open) openBrowser(link);
  await new Promise(() => {}); // держим процесс до Ctrl+C
}

function openBrowser(url) {
  const cmd = os.platform() === 'darwin' ? 'open' : os.platform() === 'win32' ? 'start' : 'xdg-open';
  import('node:child_process')
    .then(({ spawn }) => spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: os.platform() === 'win32' }).unref())
    .catch(() => {});
}
