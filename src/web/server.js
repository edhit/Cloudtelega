import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, heicMode, livePhotoMode, pairPrefer, reloadConfig } from '../config.js';
import { envExists, envPath, updateEnv } from '../env.js';
import { closeDb, countFiles, fileIdCoverage, listFiles, listTopics, searchFiles, sqliteDriver, stats } from '../db.js';
import { messageLink } from '../links.js';
import { detectPhones, inspectMount, listMountPoints, mountHint } from '../devices.js';
import { log, humanSize } from '../logger.js';
import { buildCaption } from '../caption.js';
import { collect, isRunning, requestStop, runSend, sendState } from '../pipeline.js';
import { cleanupStrayLiveVideos, describeStray } from '../cleanup.js';
import {
  botConfigured, fileUrl, getChat, getChatMember, getFilePath, getMe, getUpdates, sendMessageWithToken,
} from '../telegram/botApi.js';
import {
  accountInfo, cancelWebLogin, createStorageGroup, disconnect as disconnectAccount,
  downloadMyAvatar, downloadUserPhoto, listGroupMembers, mtprotoConfigured, startWebLogin,
  submitWebLogin, webLoginState, whoAmI,
} from '../telegram/mtproto.js';
import { botRunning, botState, runBot, seenChats, seenPeople, stopBot } from '../bot.js';
import { createProfile, deleteProfile, listProfiles, readProfileEnv, setActiveProfile } from '../profiles.js';
import {
  avatarPath, isProfileLocked, markProfileLogin, profileStateDir, readProfileStore, saveAvatar,
  setProfileLock, verifyProfileSecret, writeProfileStore,
} from '../profile-store.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Кэш картинок держим только в памяти: миниатюры и аватары приходят из Telegram
 * и не должны засорять диск. При выходе из программы всё исчезает.
 */
const MEMORY_THUMB_LIMIT = 400;
const memoryThumbs = new Map();

function rememberThumb(key, buffer) {
  memoryThumbs.set(key, buffer);
  while (memoryThumbs.size > MEMORY_THUMB_LIMIT) {
    memoryThumbs.delete(memoryThumbs.keys().next().value);
  }
}

/* ── бот: слушает команды с телефона ─────────────────────────────────────── */

/**
 * Бот живёт прямо в мастере: отдельную команду запускать не нужно.
 * Включается сам, как только есть токен и хотя бы один владелец, и здоровается
 * в личку — чтобы было видно, что всё работает.
 */
async function startBot({ greet = true } = {}) {
  if (botRunning()) return botState();
  if (!config.botToken) throw new Error('Сначала подключите бота на шаге 2');
  if (!config.adminIds.length) {
    throw new Error('Сначала укажите, кто может командовать ботом — на шаге «Как отправлять»');
  }

  // Без await: цикл опроса живёт, пока бота не остановят
  runBot({ greet }).catch((err) => log.warn(`Бот остановился: ${err.message}`));
  // Дадим циклу дойти до приветствия, чтобы состояние вернулось уже настоящим
  await new Promise((r) => setTimeout(r, 150));
  return botState();
}

/** Тихо поднимает бота при старте мастера и после смены профиля. */
function autoStartBot({ greet = true } = {}) {
  if (!config.botToken || !config.adminIds.length) return;
  startBot({ greet }).catch((err) => log.warn(`Бот не запустился: ${err.message}`));
}

/**
 * После правки настроек или смены профиля бот должен работать с новым токеном
 * и новым списком владельцев. Уже работавшего перезапускаем молча, а вот когда
 * бот включается впервые — здороваемся: это ровно тот момент, когда настройка
 * закончена и человек ждёт подтверждения.
 */
function refreshBot() {
  const wasRunning = botRunning();
  if (wasRunning) stopBot();
  autoStartBot({ greet: !wasRunning });
}

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

/* ── замок профиля ───────────────────────────────────────────────────────── */

// Разблокированные профили: имя → когда истекает доступ
const unlocked = new Map();
// Одноразовые коды входа: имя → { code, expiresAt, attempts }
const loginCodes = new Map();

function autoLockMs(name) {
  const minutes = Number(readProfileStore(name).lock.autoLockMinutes) || 30;
  return Math.max(1, minutes) * 60_000;
}

export function profileUnlocked(name) {
  if (!isProfileLocked(name)) return true;
  const until = unlocked.get(name);
  if (!until || until < Date.now()) {
    unlocked.delete(name);
    return false;
  }
  return true;
}

function touchUnlock(name) {
  if (unlocked.has(name)) unlocked.set(name, Date.now() + autoLockMs(name));
}

function unlockProfile(name) {
  unlocked.set(name, Date.now() + autoLockMs(name));
  markProfileLogin(name);
}

/** Куда слать код входа: боту того профиля, в личку его владельцу. */
async function sendLoginCode(name) {
  const env = readProfileEnv(name);
  const token = env.TELEGRAM_BOT_TOKEN;
  const admin = String(env.TELEGRAM_ADMIN_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean)[0];

  if (!token || !admin) {
    throw new Error(
      'Для кода в Telegram профилю нужен бот и ваш id в списке владельцев. ' +
        'Задайте их на шагах «Бот» и «Как отправлять», либо используйте PIN.',
    );
  }

  const code = String(crypto.randomInt(100000, 999999));
  loginCodes.set(name, { code, expiresAt: Date.now() + 5 * 60_000, attempts: 0 });

  await sendMessageWithToken({
    token,
    apiRoot: env.TELEGRAM_BOT_API_ROOT,
    chatId: admin,
    text: `Код для входа в профиль «${name}»: ${code}\nДействует 5 минут. Если это не вы — просто не вводите его.`,
  });

  return { sentTo: `id ${admin}`, expiresInSec: 300 };
}

function verifyLoginCode(name, code) {
  const entry = loginCodes.get(name);
  if (!entry) throw new Error('Код не запрашивался или уже использован');
  if (entry.expiresAt < Date.now()) {
    loginCodes.delete(name);
    throw new Error('Код устарел, запросите новый');
  }
  entry.attempts += 1;
  if (entry.attempts > 5) {
    loginCodes.delete(name);
    throw new Error('Слишком много попыток, запросите новый код');
  }
  if (String(code).trim() !== entry.code) return false;
  loginCodes.delete(name);
  return true;
}

/** Профили для боковой колонки: с аватаром, именем и временем последнего входа. */
function profileCards() {
  return listProfiles().map((p) => {
    const store = readProfileStore(p.name);
    return {
      ...p,
      displayName: store.displayName || store.telegram?.name || '',
      hasAvatar: Boolean(avatarPath(p.name)),
      accent: store.accent,
      lock: store.lock.type,
      pinLength: store.lock.pinLength ?? 4,
      locked: isProfileLocked(p.name) && !profileUnlocked(p.name),
      lastLoginAt: store.lastLoginAt,
      username: store.telegram?.username ?? null,
      premium: Boolean(store.telegram?.premium),
    };
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
    profiles: profileCards(),
    locked: !profileUnlocked(config.profile),
    style: (({ displayName, accent, theme, wallpaper }) => ({ displayName, accent, theme, wallpaper }))(readProfileStore()),
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
      // Имена вместо чисел: id остаются внутри, пользователю их видеть незачем
      admins: config.adminIds.map((id) => {
        const known = readProfileStore().knownPeople?.[id];
        return { id, name: known?.name ?? 'Владелец', username: known?.username ?? null };
      }),
      chatTitle: readProfileStore().chatTitle ?? '',
      sendDelayMs: config.sendDelayMs,
    },
    checks: { bot: null, chat: null, account: null },
    job: { ...job, running: Boolean(job.mode), send: sendState() },
    bot: botState(),
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
          const title = chat.title ?? chat.username ?? String(chat.id);
          writeProfileStore({ chatTitle: title });
          result.chat = {
            ok: canPost,
            title,
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

/**
 * Ищет каналы и группы, куда бот уже добавлен: по свежим апдейтам.
 * Пока бот слушает команды, второй getUpdates Telegram не разрешит — тогда
 * берём то, что бот уже увидел сам.
 */
async function detectChats() {
  const found = new Map();

  const updates = botRunning() ? [] : await getUpdates(0, 0);
  for (const chat of seenChats()) found.set(chat.id, { ...chat });

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

  // Уже выбранная группа в списке нужна всегда — даже если писать в неё давно перестали
  if (config.chatId && !found.has(String(config.chatId))) {
    found.set(String(config.chatId), {
      id: String(config.chatId),
      title: readProfileStore().chatTitle || String(config.chatId),
      type: 'supergroup',
      isForum: false,
    });
  }

  // Подтягиваем аватар и количество участников — со списком приятнее работать
  for (const chat of found.values()) {
    try {
      const full = await getChat(chat.id);
      chat.photo = full.photo?.small_file_id ?? null;
      chat.isForum = Boolean(full.is_forum);
      chat.description = full.description ?? '';
    } catch {
      /* без подробностей тоже сойдёт */
    }
  }

  return [...found.values()];
}

/** Убирает прошлую картинку-фон, чтобы в папке профиля не копились файлы. */
async function removeWallpaperFile(name = config.profile) {
  const { wallpaper } = readProfileStore(name);
  if (wallpaper?.type !== 'custom' || !wallpaper.file) return;
  await fs.rm(path.join(profileStateDir(name), wallpaper.file), { force: true });
}

/** К каждой записи добавляем ссылку на сообщение в Telegram. */
const withLinks = (rows) => rows.map((row) => ({ ...row, link: messageLink(row) }));

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
        name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'Ваш аккаунт',
        username: me.username ?? null,
        source: 'account',
      });
    } catch {
      /* аккаунт не отвечает — попробуем через бота */
    }
  }

  // Участники группы — их видит аккаунт; Bot API такого списка не отдаёт
  if (mtprotoConfigured() && config.chatId) {
    try {
      for (const member of await listGroupMembers()) {
        if (found.some((f) => f.id === member.id)) continue;
        found.push({ ...member, source: 'group' });
      }
    } catch {
      /* нет доступа к списку участников — не беда */
    }
  }

  if (botConfigured()) {
    try {
      for (const person of seenPeople()) {
        if (found.some((f) => f.id === person.id)) continue;
        found.push({ ...person, source: 'bot' });
      }

      const updates = botRunning() ? [] : await getUpdates(0, 0);
      for (const u of updates) {
        const msg = u.message ?? u.edited_message;
        if (msg?.chat?.type !== 'private' || !msg.from || msg.from.is_bot) continue;
        const id = String(msg.from.id);
        if (found.some((f) => f.id === id)) continue;
        found.push({
          id,
          name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'Пользователь',
          username: msg.from.username ?? null,
          source: 'bot',
        });
      }
    } catch {
      /* бот не отвечает — вернём то, что есть */
    }
  }

  // Те, кто писал боту раньше: Telegram отдаёт апдейт один раз, а список
  // выбора должен оставаться прежним и после перезапуска.
  for (const [id, person] of Object.entries(readProfileStore().knownPeople ?? {})) {
    if (found.some((f) => f.id === id)) continue;
    found.push({ id, name: person.name, username: person.username ?? null, source: 'known' });
  }

  // Запоминаем, кто есть кто: чтобы дальше показывать имена, а не числа
  if (found.length) {
    const known = { ...(readProfileStore().knownPeople ?? {}) };
    for (const person of found) known[person.id] = { name: person.name, username: person.username ?? null };
    writeProfileStore({ knownPeople: known });
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
    // Токен и список владельцев мог измениться — бот подхватывает их сразу
    if (patch.TELEGRAM_BOT_TOKEN !== undefined || patch.TELEGRAM_ADMIN_IDS !== undefined) refreshBot();
    return buildState();
  },

  /** Включить бота: он сразу напишет владельцу, что готов к работе. */
  'POST /api/bot/start': async () => startBot(),

  'POST /api/bot/stop': async () => {
    stopBot();
    return botState();
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

    const name = body?.name ?? 'default';
    // Чужой профиль под замком не открываем, пока не подтвердят, что это свой
    if (isProfileLocked(name) && !profileUnlocked(name)) {
      const { lock } = readProfileStore(name);
      const env = readProfileEnv(name);
      const canCode = Boolean(env.TELEGRAM_BOT_TOKEN && String(env.TELEGRAM_ADMIN_IDS ?? '').trim());
      return { needsUnlock: true, name, method: lock.type, pinLength: lock.pinLength ?? 4, canCode };
    }

    // У другого профиля свой аккаунт, свой бот и своя база: старое закрываем.
    stopBot();
    await cancelWebLogin();
    await disconnectAccount();
    closeDb();
    setActiveProfile(name);
    reloadConfig();
    autoStartBot();
    return buildState();
  },

  'POST /api/profiles/unlock': async (body) => {
    const name = body?.name ?? config.profile;
    const { lock } = readProfileStore(name);

    let ok = false;
    if (body?.code) ok = verifyLoginCode(name, body.code);
    else if (lock.type === 'pin' || lock.type === 'password') ok = verifyProfileSecret(body?.secret, name);

    if (!ok) throw new Error(lock.type === 'pin' ? 'Неверный PIN' : 'Не подошло');

    unlockProfile(name);
    if (name !== config.profile) {
      stopBot();
      await cancelWebLogin();
      await disconnectAccount();
      closeDb();
      setActiveProfile(name);
      reloadConfig();
      autoStartBot();
    }
    return buildState();
  },

  'POST /api/profiles/request-code': async (body) => sendLoginCode(body?.name ?? config.profile),

  'POST /api/profiles/lock-now': async () => {
    unlocked.delete(config.profile);
    return { locked: isProfileLocked(config.profile) };
  },

  /* ── личные настройки профиля ─────────────────────────────────────────── */

  'GET /api/profile': async () => {
    const store = readProfileStore();
    return {
      name: config.profile,
      displayName: store.displayName,
      accent: store.accent,
      theme: store.theme,
      hasAvatar: Boolean(avatarPath()),
      // telegram — то, что уже запомнили; accountConnected — есть ли сам вход
      telegram: store.telegram,
      accountConnected: mtprotoConfigured(),
      lock: { type: store.lock.type, autoLockMinutes: store.lock.autoLockMinutes, pinLength: store.lock.pinLength ?? 4 },
      wallpaper: store.wallpaper ?? { type: 'none' },
      lastLoginAt: store.lastLoginAt,
      canUseTelegramCode: Boolean(config.botToken && config.adminIds.length),
    };
  },

  'POST /api/profile': async (body) => {
    const patch = {};
    if (typeof body?.displayName === 'string') patch.displayName = body.displayName.slice(0, 60);
    if (/^#[0-9a-f]{6}$/i.test(body?.accent ?? '')) patch.accent = body.accent.toLowerCase();
    if (['auto', 'light', 'dark'].includes(body?.theme)) patch.theme = body.theme;
    writeProfileStore(patch);
    return routes['GET /api/profile']();
  },

  /** Тянет имя, username и аватар из Telegram — и запоминает их для профиля. */
  'POST /api/profile/refresh-telegram': async () => {
    if (!mtprotoConfigured()) throw new Error('Сначала подключите аккаунт на шаге 3');

    const info = await accountInfo();
    const avatar = await downloadMyAvatar().catch(() => null);
    if (avatar) saveAvatar(avatar);

    writeProfileStore({ telegram: { ...info, updatedAt: Date.now() } });
    return routes['GET /api/profile']();
  },

  /** Своя картинка вместо аватара из Telegram — только внутри программы. */
  'POST /api/profile/avatar': async (body) => {
    const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(body?.dataUrl ?? ''));
    if (!match) throw new Error('Нужна картинка PNG, JPEG или WebP');

    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 8 * 1024 * 1024) throw new Error('Картинка больше 8 МБ');
    const ext = match[1].toLowerCase().startsWith('jp') ? '.jpg' : `.${match[1].toLowerCase()}`;
    saveAvatar(buffer, ext);

    return { ok: true };
  },

  /**
   * Фон рабочей области: один из готовых или своя картинка.
   * Готовые — просто имя градиента, ничего не занимают; своя картинка
   * лежит рядом с профилем одним файлом и заменяет прошлую.
   */
  'POST /api/profile/wallpaper': async (body) => {
    const type = body?.type;

    if (type === 'none') {
      await removeWallpaperFile();
      writeProfileStore({ wallpaper: { type: 'none' } });
      return routes['GET /api/profile']();
    }

    if (type === 'preset') {
      const value = String(body?.value ?? '').slice(0, 32);
      if (!/^[a-z]+$/.test(value)) throw new Error('Неизвестный фон');
      await removeWallpaperFile();
      writeProfileStore({ wallpaper: { type: 'preset', value } });
      return routes['GET /api/profile']();
    }

    if (type === 'custom') {
      const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(body?.dataUrl ?? ''));
      if (!match) throw new Error('Нужна картинка PNG, JPEG или WebP');
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 12 * 1024 * 1024) throw new Error('Картинка больше 12 МБ');

      await removeWallpaperFile();
      const file = `wallpaper.${match[1].toLowerCase().startsWith('jp') ? 'jpg' : match[1].toLowerCase()}`;
      const dir = profileStateDir();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, file), buffer);
      writeProfileStore({ wallpaper: { type: 'custom', file } });
      return routes['GET /api/profile']();
    }

    throw new Error('Неизвестный вид фона');
  },

  /** Отключить аккаунт Telegram: ключ сессии стирается, архив и настройки остаются. */
  'POST /api/profile/logout-telegram': async () => {
    await disconnectAccount();
    updateEnv({ TELEGRAM_SESSION: ' ' });
    reloadConfig();
    writeProfileStore({ telegram: null });
    return { ok: true };
  },

  'POST /api/profile/lock': async (body) => {
    const type = body?.type ?? 'none';
    // Меняем защиту только у того, кто уже внутри профиля
    setProfileLock(type, body?.secret);
    if (typeof body?.autoLockMinutes === 'number') {
      const store = readProfileStore();
      writeProfileStore({ lock: { ...store.lock, autoLockMinutes: Math.max(1, Math.min(720, body.autoLockMinutes)) } });
    }
    if (type !== 'none') unlockProfile(config.profile);
    return routes['GET /api/profile']();
  },

  'POST /api/profiles/delete': async (body) => {
    if (body?.name === config.profile) stopBot();
    deleteProfile(body?.name);
    return { profiles: listProfiles() };
  },

  'POST /api/archive/rows': async (body) => {
    const page = searchFiles({
      query: body?.query ?? '',
      status: ['sent', 'failed', 'skipped', 'pending'].includes(body?.status) ? body.status : '',
      limit: body?.limit,
      offset: body?.offset,
    });
    return { ...page, rows: withLinks(page.rows), hasMore: page.offset + page.rows.length < page.total };
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
      page: { rows: withLinks(listFiles({ limit: 100, offset: 0 })), total: countFiles(), offset: 0, limit: 100 },
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
    return { mounts, phones: await detectPhones(), hint: mountHint() };
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

/**
 * Миниатюры не храним у себя вообще: Telegram уже держит маленькую превьюшку
 * каждого снимка. Тянем её по требованию и держим только в памяти — на диске
 * программы не появляется ни одного лишнего файла.
 */
async function serveThumb(req, res, url) {
  const fileId = url.searchParams.get('file');
  if (!fileId || !config.botToken) {
    res.writeHead(404).end();
    return;
  }

  const cached = memoryThumbs.get(fileId);
  if (cached) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
    res.end(cached);
    return;
  }

  try {
    const filePath = await getFilePath(fileId);
    const response = await fetch(fileUrl(filePath));
    if (!response.ok) throw new Error(`Telegram ответил ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    rememberThumb(fileId, buffer);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
    res.end(buffer);
  } catch {
    res.writeHead(404).end();
  }
}

/** Аватар участника — тоже мимо диска, прямо из Telegram в браузер. */
async function serveUserPhoto(req, res, url) {
  const id = url.searchParams.get('id');
  if (!id || !mtprotoConfigured()) {
    res.writeHead(404).end();
    return;
  }

  const key = `user:${id}`;
  const cached = memoryThumbs.get(key);
  if (cached) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
    res.end(cached);
    return;
  }

  try {
    const buffer = await downloadUserPhoto(id);
    if (!buffer) throw new Error('нет фото');
    rememberThumb(key, buffer);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
    res.end(buffer);
  } catch {
    res.writeHead(404).end();
  }
}

/** Обои рабочей области, если пользователь загрузил свою картинку. */
async function serveWallpaper(req, res, url) {
  const name = url.searchParams.get('name') || config.profile;
  const store = readProfileStore(name);
  if (store.wallpaper?.type !== 'custom' || !store.wallpaper.file) {
    res.writeHead(404).end();
    return;
  }
  try {
    const file = store.wallpaper.file;
    const data = await fs.readFile(path.join(profileStateDir(name), file));
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}

/** Аватар профиля отдаём как обычную картинку. */
async function serveAvatar(req, res, url) {
  const name = url.searchParams.get('name') || config.profile;
  const file = avatarPath(name);
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const data = await fs.readFile(file);
  res.writeHead(200, {
    'content-type': { '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] ?? 'image/jpeg',
    'cache-control': 'no-cache',
  });
  res.end(data);
}

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

    if (req.method === 'GET' && url.pathname === '/api/avatar') {
      await serveAvatar(req, res, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/thumb') {
      if (!profileUnlocked(config.profile)) {
        res.writeHead(423).end();
        return;
      }
      await serveThumb(req, res, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/user-photo') {
      await serveUserPhoto(req, res, url);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/wallpaper') {
      await serveWallpaper(req, res, url);
      return;
    }

    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];

    // Пока профиль под замком, наружу отдаём только то, что нужно для входа
    const ALLOWED_WHEN_LOCKED = new Set([
      'GET /api/state', 'GET /api/profiles', 'POST /api/profiles/switch',
      'POST /api/profiles/unlock', 'POST /api/profiles/request-code',
      // Новый профиль пустой — завести его можно и не открывая закрытый
      'POST /api/profiles/create',
    ]);
    if (handler && !profileUnlocked(config.profile) && !ALLOWED_WHEN_LOCKED.has(key)) {
      res.writeHead(423, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Профиль закрыт — введите PIN или код из Telegram', locked: true }));
      return;
    }
    touchUnlock(config.profile);

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

  // Бот поднимается сам: отдельную команду запускать не нужно, он сразу
  // напишет владельцу, что готов к работе.
  autoStartBot();

  await new Promise(() => {}); // держим процесс до Ctrl+C
}

/**
 * Открывает мастер в браузере. Если открыть нечем (сервер без графики,
 * нет xdg-open), это не беда: ссылка уже напечатана выше — молча идём дальше.
 */
function openBrowser(url) {
  const cmd = os.platform() === 'darwin' ? 'open' : os.platform() === 'win32' ? 'start' : 'xdg-open';
  import('node:child_process')
    .then(({ spawn }) => {
      const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: os.platform() === 'win32' });
      // Без этого обработчика ENOENT прилетает как необработанное событие 'error'
      // и роняет весь мастер настройки.
      child.on('error', () => {});
      child.unref();
    })
    .catch(() => {});
}
