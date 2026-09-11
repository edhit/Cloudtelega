import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, heicMode, livePhotoMode, pairPrefer, reloadConfig } from '../config.js';
import { describeError } from '../errors.js';
import { envExists, envPath, updateEnv } from '../env.js';
import {
  closeDb, countFiles, fileIdCoverage, listFiles, listGuests, listTopics,
  searchFiles, sqliteDriver, stats,
} from '../db.js';
import { messageLink } from '../links.js';
import { connectGuides, detectPhones, inspectMount, listMountPoints } from '../devices.js';
import { log, humanSize, onLog } from '../logger.js';
import { buildCaption } from '../caption.js';
import { collect, isRunning, requestStop, runSend, sendState } from '../pipeline.js';
import { summarizeUnreadable } from '../scanner.js';
import {
  createFolder, driveOverview, folders as driveFolders, getFileBack, moveFile,
  putMany, putUploaded, removeFolder, removeFromDrive, setNote,
} from '../drive.js';
import {
  accessOverview, createAccessLink, expireGuests, extendGuest, presetHours,
  removeGuest, revokeAccessLink,
} from '../sharing.js';
import { cleanupStrayLiveVideos, describeStray } from '../cleanup.js';
import { publishSnapshot, pullSnapshot, syncState, syncTargets } from '../sync.js';
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
 * Кэш картинок держим только в памяти: аватары групп и людей приходят из
 * Telegram и не должны засорять диск. При выходе из программы всё исчезает.
 * Тут именно аватары — их единицы; миниатюры снимков программа не тянет
 * совсем, чтобы не сажать бота на flood limit.
 */
const MEMORY_IMAGE_LIMIT = 200;
const memoryImages = new Map();

function rememberImage(key, buffer) {
  memoryImages.set(key, buffer);
  while (memoryImages.size > MEMORY_IMAGE_LIMIT) {
    memoryImages.delete(memoryImages.keys().next().value);
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
  runBot({ greet }).catch((err) => log.warn(`Бот остановился: ${describeError(err, { kind: 'bot' })}`));
  // Дадим циклу дойти до приветствия, чтобы состояние вернулось уже настоящим
  await new Promise((r) => setTimeout(r, 150));
  return botState();
}

/** Тихо поднимает бота при старте мастера и после смены профиля. */
function autoStartBot({ greet = true } = {}) {
  if (!config.botToken || !config.adminIds.length) return;
  startBot({ greet }).catch((err) => log.warn(`Бот не запустился: ${describeError(err, { kind: 'bot' })}`));
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

// problem, а не error: любое поле error в ответе клиент считает отказом запроса,
// и тогда упавшая операция переставала отображаться вовсе.
const job = { mode: null, summary: null, problem: null, finished: null, lines: [] };

// Лог держим длинным: по коротким «✗ не отправилось» причину не найти,
// а лезть в терминал за ней человек не должен.
const LOG_LIMIT = 500;

/**
 * Строка лога: уровень нужен, чтобы предупреждения и ошибки было видно глазом.
 * @param {string} text
 * @param {'info'|'ok'|'warn'|'error'} [level]
 */
function note(text, level = 'info') {
  job.lines.push({ level, text, at: Date.now() });
  if (job.lines.length > LOG_LIMIT) job.lines.shift();
}

/**
 * Пока идёт работа, всё, что программа пишет в терминал, попадает и в браузер.
 * Именно там оседают причины сбоев: повторы запросов, flood limit, отказ
 * Telegram принять файл, неудачная конвертация HEIC.
 * @returns {() => void} отписка
 */
function mirrorLogToJob() {
  return onLog(({ level, text }) => {
    if (level === 'plain') return;
    note(text, level === 'ok' ? 'ok' : level);
  });
}

/**
 * Начало любой операции: чистим прошлый лог и пишем, с чем работаем.
 * @param {string[]} [paths] что именно обходим — у диска свои пути, не SCAN_PATHS
 */
function beginJob(mode, firstLine, paths = config.scanPaths) {
  job.mode = mode;
  job.summary = null;
  job.problem = null;
  job.finished = null;
  job.lines = [];
  note(firstLine);
  note(`Папок для обхода: ${paths.length}${paths.length ? ` — ${paths.join(', ')}` : ''}`);
  return mirrorLogToJob();
}

/** Конец операции: ошибку показываем целиком, с причиной и советом. */
function failJob(err) {
  job.problem = describeError(err);
  note(job.problem, 'error');
  if (err?.stack && process.env.CLOUDTELEGA_DEBUG) note(err.stack, 'error');
}

/**
 * Нечитаемое — отдельной сводкой, а не строкой на каждый файл: на сбойном
 * диске их сотни. И это не мелочь: такие снимки в архив не попали, значит
 * стирать с диска ничего нельзя.
 */
function noteUnreadable(unreadable = []) {
  if (!unreadable.length) return;
  const sum = summarizeUnreadable(unreadable);

  note(`Не удалось прочитать: ${sum.total} (из них папок: ${sum.dirs}). Эти файлы в архив НЕ попали`, 'error');
  for (const group of sum.byCode) {
    note(`  ${group.n} × ${group.why}`, 'warn');
    for (const sample of group.samples) note(`    ${sample}`);
    if (group.n > group.samples.length) note(`    …и ещё ${group.n - group.samples.length}`);
  }
  note('Пока диск отдаёт ошибки, считать архив полным нельзя — не удаляйте с него ничего', 'error');
}

async function startScan() {
  if (job.mode) throw new Error('Уже идёт другая операция');
  const unmirror = beginJob('scan', 'Считаю файлы, хеши и даты съёмки…');

  let lastPercent = -1;
  collect({
    roots: config.scanPaths,
    onDateProgress: (done, total) => {
      // Раз в 10 % — чтобы лог не превратился в счётчик
      const percent = total ? Math.floor((done / total) * 10) * 10 : 0;
      if (percent === lastPercent) return;
      lastPercent = percent;
      note(`Даты съёмки: ${done} из ${total} (${percent} %)`);
    },
  })
    .then(({ summary, dropped, files, unreadable }) => {
      job.summary = { ...summary, dropped: dropped.length, unreadable: unreadable.length };
      note(`Найдено ${summary.count} файлов, ${humanSize(summary.bytes)}`, 'ok');
      // Откуда разница между «медиафайлов на диске» и «файлов к отправке» —
      // без этой строки цифры выглядят необъяснимо
      if (summary.livePhotos) {
        note(`Из них пар Live Photo: ${summary.livePhotos} — кадр и видео уходят одним сообщением`);
      }
      if (summary.big) note(`Крупнее 50 МБ: ${summary.big} — уйдут через аккаунт`);

      for (const [year, n] of summary.byYear ?? []) note(`  ${year}: ${n}`);
      // Отброшенные дубли — самая частая причина «а почему файлов меньше?»
      if (dropped.length) {
        note(`Не пойдут как отдельные файлы: ${dropped.length}`);
        for (const d of dropped.slice(0, 20)) note(`  ${d.file.name} — ${d.reason}`);
        if (dropped.length > 20) note(`  …и ещё ${dropped.length - 20}`);
      }
      if (!files.length) {
        note('Отправлять нечего: в указанных папках не нашлось фото и видео', 'warn');
      }
      noteUnreadable(unreadable);
    })
    .catch(failJob)
    .finally(() => {
      unmirror();
      job.mode = null;
      job.finished = 'scan';
    });
}

async function startSend() {
  if (job.mode || isRunning()) throw new Error('Уже идёт другая операция');
  const unmirror = beginJob('send', 'Сканирую каталоги…');
  note(`Транспорт: бот ${config.botToken ? 'подключён' : 'не подключён'}, аккаунт ${mtprotoConfigured() ? 'подключён' : 'не подключён'}`);

  runSend({
    roots: config.scanPaths,
    hooks: {
      onScanned: ({ summary, dropped, unreadable }) => {
        job.summary = { ...summary, dropped: dropped.length, unreadable: unreadable?.length ?? 0 };
        note(`Найдено ${summary.count} файлов, ${humanSize(summary.bytes)}. Начинаю отправку…`, 'ok');
        if (dropped.length) note(`Схлопнуто дублей и пар: ${dropped.length}`);
        noteUnreadable(unreadable);
      },
      onFile: ({ index, total, file, status, error, twin, result, topicId }) => {
        const name = file.relPath || file.name;
        const size = humanSize(file.size);
        if (status === 'sent') {
          const how = result?.method === 'mtproto' ? 'через аккаунт' : 'ботом';
          note(`✓ ${index}/${total} ${name} (${size}, ${how}${topicId ? `, тема ${topicId}` : ''}, сообщение ${result?.messageId ?? '—'})`, 'ok');
        } else if (status === 'duplicate') {
          note(`⏭ ${index}/${total} ${name} — уже в архиве${twin?.name && twin.name !== file.name ? ` (как ${twin.name})` : ''}`);
        } else if (status === 'skipped') {
          note(`⏭ ${index}/${total} ${name} — пропущен: ${error}`, 'warn');
        } else if (status === 'failed') {
          note(`✗ ${index}/${total} ${name} (${size}): ${error}`, 'error');
        }
      },
      onFinish: (r) => {
        note(
          `Готово: отправлено ${r.sent} (${humanSize(r.bytesSent)}), дублей ${r.duplicates}, ошибок ${r.failed}` +
          `${r.stopped ? ' — остановлено вручную' : ''}`,
          r.failed ? 'warn' : 'ok',
        );
      },
    },
  })
    .catch(failJob)
    .finally(async () => {
      unmirror();
      job.mode = null;
      job.finished = 'send';
      await refreshSharedList('photos');
    });
}

/**
 * Приём файла, перетащенного в браузер. Тело запроса — сами байты, имя и папка
 * приходят заголовками: так не нужен разбор multipart, а файл льётся на диск
 * потоком и не держится в памяти целиком.
 */
async function receiveUpload(req, res, url) {
  if (!profileUnlocked(config.profile)) {
    res.writeHead(423, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Профиль закрыт' }));
    return;
  }

  const name = decodeURIComponent(req.headers['x-file-name'] ?? url.searchParams.get('name') ?? 'файл');
  const folder = decodeURIComponent(req.headers['x-folder'] ?? url.searchParams.get('folder') ?? '');

  await fs.mkdir(config.tmpDir, { recursive: true });
  const tmpPath = path.join(config.tmpDir, `upload-${crypto.randomBytes(8).toString('hex')}`);

  try {
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    await pipeline(req, createWriteStream(tmpPath));

    const outcome = await putUploaded({ tmpPath, name, folder: folder || null });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: outcome.status,
      name: outcome.file?.name ?? name,
      size: outcome.file?.size ?? 0,
      link: outcome.link ?? null,
      error: outcome.error ?? null,
    }));
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    const message = describeError(err);
    log.error(`Загрузка ${name}: ${message}`);
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'failed', name, error: message }));
  }
}

/**
 * Как называется чат. Числовой id человеку ничего не говорит, поэтому
 * спрашиваем у Telegram название и аватар и запоминаем их в профиле:
 * при следующем открытии панель не ждёт сети.
 *
 * Помним про все чаты сразу: у диска свой, у снимков свой, и шапка каждого
 * хранилища показывает название своего.
 */
async function rememberChat(chatId) {
  if (!chatId || !botConfigured()) return null;
  const id = String(chatId);

  try {
    const chat = await getChat(id);
    const info = {
      id,
      title: chat.title ?? chat.username ?? id,
      photo: chat.photo?.small_file_id ?? null,
      isForum: Boolean(chat.is_forum),
      type: chat.type,
    };
    writeProfileStore({ chats: { ...readProfileStore().chats, [id]: info } });
    return info;
  } catch {
    return readProfileStore().chats?.[id] ?? null;
  }
}

/** То, что уже известно про чат, без похода в сеть. */
function knownChat(chatId) {
  if (!chatId) return null;
  const id = String(chatId);
  const store = readProfileStore();

  const saved = store.chats?.[id] ?? (store.driveChat?.id === id ? store.driveChat : null);
  if (saved) return saved;
  // Про чат снимков название знали и раньше — до того, как завели общий список
  if (id === String(config.chatId) && store.chatTitle) return { id, title: store.chatTitle, photo: null };
  return { id, title: '', photo: null };
}

/** Названия всех чатов, которые сейчас используются хранилищами. */
function storageChats() {
  const out = {};
  for (const id of [config.chatId, config.driveChatId]) {
    if (id) out[String(id)] = knownChat(id);
  }
  return out;
}

/**
 * Дотягивает названия чатов, которых ещё не знаем. Чат мог попасть в .env
 * руками, минуя выбор в окне, — тогда спросить Telegram больше некому.
 * Ходим в сеть только за незнакомыми, поэтому обычное открытие страницы
 * никуда не ходит вовсе.
 */
async function ensureChatNames() {
  for (const id of [config.chatId, config.driveChatId]) {
    if (id && !knownChat(id).title) await rememberChat(id).catch(() => null);
  }
}

/** Страница диска: сводка плюс порция записей со ссылками на сообщения. */
function drivePage({ query = '', status = '', offset = 0, folder = null } = {}) {
  // При поиске папку не сужаем: искать логично по всему диску
  const inFolder = String(query ?? '').trim() ? null : folder;
  const page = searchFiles({
    bucket: 'drive',
    query: String(query ?? ''),
    status: String(status ?? ''),
    limit: 100,
    offset: Number(offset) || 0,
    folder: inFolder,
  });
  return {
    ...driveOverview(),
    // Подпапки берём той папки, в которой стоим, — иначе в «Договорах»
    // показывался бы весь корень диска
    ...driveFolders(inFolder ?? ''),
    ...page,
    chat: knownChat(driveOverview().chatId),
    folder: inFolder,
    rows: withLinks(page.rows),
  };
}

/**
 * Держит общий список свежим после отправки. Сам собой список не заводится:
 * пока человек ни разу не выложил его вручную, мы не решаем за него, что
 * содержимое его архива можно показывать всем в чате.
 */
async function refreshSharedList(storage) {
  if (!syncState(storage)?.messageId) return;
  try {
    const r = await publishSnapshot(storage);
    note(`Общий список обновлён: ${r.rows} ${r.rows === 1 ? 'запись' : 'записей'}`, 'ok');
  } catch (err) {
    note(`Общий список обновить не вышло: ${describeError(err, { kind: 'bot' })}`, 'warn');
  }
}

/** Загрузка на диск — та же фоновая работа, что скан и отправка. */
async function startDriveUpload(paths, folder) {
  if (job.mode || isRunning()) throw new Error('Уже идёт другая операция');
  if (!paths?.length) throw new Error('Не выбрано, что загружать');

  const unmirror = beginJob('drive', 'Кладу на диск…', paths);
  note(`Чат диска: ${driveOverview().chatId || 'не выбран'}`);

  putMany({
    paths,
    folder,
    hooks: {
      onFile: ({ index, total, status, file, error, folder: where, link, method }) => {
        const size = humanSize(file?.size ?? 0);
        if (status === 'sent') {
          note(`✓ ${index}/${total} ${file.name} (${size}${where ? `, папка ${where}` : ''}, ${method === 'mtproto' ? 'через аккаунт' : 'ботом'})`, 'ok');
        } else if (status === 'duplicate') {
          note(`⏭ ${index}/${total} ${file.name} — уже на диске`);
        } else {
          note(`✗ ${index}/${total} ${file.name} (${size}): ${error}`, 'error');
        }
      },
      onFinish: (r) => {
        job.summary = { count: r.sent, bytes: r.bytes, photos: r.sent, videos: 0, dropped: r.duplicates };
        note(
          `Готово: загружено ${r.sent} (${humanSize(r.bytes)}), уже было ${r.duplicates}, ошибок ${r.failed}`,
          r.failed ? 'warn' : 'ok',
        );
      },
    },
  })
    .catch(failJob)
    .finally(async () => {
      unmirror();
      job.mode = null;
      job.finished = 'drive';
      await refreshSharedList('drive');
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
  await ensureChatNames();

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
      chats: storageChats(),
      sendDelayMs: config.sendDelayMs,
      driveChatId: config.driveChatId,
      driveFolders: config.driveFolders,
      driveDownloadDir: config.driveDownloadDir,
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
          result.chat = { ok: false, problem: describeError(err, { kind: 'bot' }) };
        }
      }
    } catch (err) {
      result.bot = { ok: false, problem: describeError(err, { kind: 'bot' }) };
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
      result.account = { ok: false, problem: describeError(err, { kind: 'mtproto' }) };
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

  // Уже выбранные чаты в списке нужны всегда — и чат снимков, и чат диска.
  // Писать в группу могли последний раз год назад, а архив в ней живой:
  // пропасть из списка она не должна ни при каких обстоятельствах
  for (const id of [config.chatId, config.driveChatId]) {
    if (!id || found.has(String(id))) continue;
    found.set(String(id), {
      id: String(id),
      title: knownChat(id).title || String(id),
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
      'DRIVE_CHAT_ID', 'DRIVE_FOLDERS', 'DRIVE_DOWNLOAD_DIR',
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
    // Сменили чат диска — узнаём, как он называется
    if (patch.DRIVE_CHAT_ID !== undefined) await rememberChat(config.driveChatId);
    if (patch.TELEGRAM_CHAT_ID !== undefined) await rememberChat(config.chatId);
    return buildState();
  },

  /** Включить бота: он сразу напишет владельцу, что готов к работе. */
  'POST /api/bot/start': async () => startBot(),

  'POST /api/bot/stop': async () => {
    stopBot();
    return botState();
  },

  /* ── диск ───────────────────────────────────────────────────────────── */

  /** Одним запросом всё, что нужно главному экрану. */
  'GET /api/home': async () => {
    const db = stats();
    const drive = driveOverview();
    const guests = listGuests({ chatId: drive.chatId }).filter((g) => !g.removed_at);
    return {
      photos: db.total ?? { n: 0, bytes: 0 },
      drive: { files: drive.files, bytes: drive.bytes, chatId: drive.chatId },
      access: { guests: guests.length },
    };
  },

  'GET /api/drive': async () => drivePage({}),

  'POST /api/drive/search': async (body) => drivePage(body ?? {}),

  'POST /api/drive/upload': async (body) => {
    const paths = (body?.paths ?? []).map(String).filter(Boolean);
    await startDriveUpload(paths, body?.folder ? String(body.folder).slice(0, 60) : null);
    return { started: true };
  },

  'POST /api/drive/download': async (body) => {
    const result = await getFileBack(Number(body?.id), { destDir: body?.destDir || undefined });
    return result;
  },

  'POST /api/drive/remove': async (body) => removeFromDrive(Number(body?.id)),

  'POST /api/drive/folders': async (body) => driveFolders(body?.parent ?? ''),

  'POST /api/drive/folder': async (body) => {
    const created = await createFolder(body?.name, body?.parent ?? '');
    return { created, ...driveFolders(created.path.split('/').slice(0, -1).join('/')) };
  },

  /* ── общий список для совместной работы ─────────────────────────────── */

  'POST /api/sync': async (body) => {
    const id = String(body?.storage ?? 'drive');
    return { ...syncState(id), targets: syncTargets() };
  },

  'POST /api/sync/publish': async (body) => {
    const r = await publishSnapshot(String(body?.storage ?? 'drive'));
    return { ...r, ...syncState(String(body?.storage ?? 'drive')) };
  },

  'POST /api/sync/pull': async (body) => {
    const id = String(body?.storage ?? 'drive');
    const r = await pullSnapshot(id, body?.messageId);
    return { ...r, ...syncState(id) };
  },

  'POST /api/drive/note': async (body) => {
    await setNote(Number(body?.id), body?.note ?? '');
    return drivePage({ folder: body?.from || null });
  },

  'POST /api/drive/remove-folder': async (body) => {
    const r = await removeFolder(String(body?.path ?? ''));
    return { removed: r, ...drivePage({ folder: body?.from || null }) };
  },

  'POST /api/drive/move': async (body) => {
    moveFile(Number(body?.id), body?.folder ?? null);
    return drivePage({ folder: body?.from ?? null });
  },

  /* ── доступ к диску ─────────────────────────────────────────────────── */

  // Доступ всегда спрашивают про конкретное хранилище: «пустить в диск»
  // и «пустить в снимки» — это разные чаты и разные списки гостей
  'POST /api/access': async (body) => accessOverview(body?.chatId),

  'POST /api/access/link': async (body) => {
    const invite = await createAccessLink({
      chatId: body?.chatId,
      name: body?.name ? String(body.name).slice(0, 32) : undefined,
      accessPreset: body?.preset ?? 'week',
      linkHours: body?.linkHours === null ? null : Number(body?.linkHours) || 48,
      memberLimit: body?.memberLimit === null ? null : Number(body?.memberLimit) || 1,
      joinRequest: Boolean(body?.joinRequest),
    });
    return { invite, ...(await accessOverview(body?.chatId)) };
  },

  'POST /api/access/revoke': async (body) => {
    await revokeAccessLink(String(body?.link ?? ''));
    return accessOverview(body?.chatId);
  },

  'POST /api/access/kick': async (body) => {
    await removeGuest(String(body?.userId ?? ''), body?.chatId ? String(body.chatId) : undefined);
    return accessOverview(body?.chatId);
  },

  'POST /api/access/extend': async (body) => {
    extendGuest(
      String(body?.userId ?? ''),
      body?.preset === 'forever' ? null : presetHours(body?.preset ?? 'week'),
      body?.chatId ? String(body.chatId) : undefined,
    );
    return accessOverview(body?.chatId);
  },

  'POST /api/access/sweep': async (body) => {
    const r = await expireGuests();
    return { ...r, ...(await accessOverview(body?.chatId)) };
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

    // Свой цвет или переход между двумя: хранится тремя числами, места не занимает
    if (type === 'own') {
      const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v ?? '')) ? String(v).toLowerCase() : null);
      const from = hex(body?.from);
      if (!from) throw new Error('Нужен цвет вида #a1b2c3');

      const to = body?.to === null || body?.to === undefined ? null : hex(body.to);
      if (body?.to && !to) throw new Error('Второй цвет должен быть вида #a1b2c3');

      const angle = Number(body?.angle);
      await removeWallpaperFile();
      writeProfileStore({
        wallpaper: { type: 'own', from, to, angle: Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : 160 },
      });
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
    // Инструкции отдаём сразу все, а показываем ту, что подходит этой системе
    return { mounts, phones: await detectPhones(), connect: connectGuides() };
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
 * «Картинки нет» — не ошибка: у половины людей просто не стоит аватарка.
 * 404 браузер пишет в консоль красным на каждого такого, поэтому отвечаем
 * 204: запрос удался, показывать нечего. Пустой ответ всё равно вызовет
 * onerror у <img>, и на месте картинки останется буква.
 */
function noPicture(res) {
  res.writeHead(204, { 'cache-control': 'max-age=600' }).end();
}

/**
 * Аватар группы или канала — по одному на строку списка, то есть единицы
 * запросов за открытие списка. Миниатюры снимков сюда не ходят: их на страницу
 * приходило до сотни разом, и Telegram за такой поток сажает бота на flood
 * limit — вместе с отправкой архива.
 */
async function serveChatPhoto(req, res, url) {
  const fileId = url.searchParams.get('file');
  if (!fileId || !config.botToken) {
    noPicture(res);
    return;
  }

  const cached = memoryImages.get(fileId);
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

    rememberImage(fileId, buffer);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
    res.end(buffer);
  } catch {
    noPicture(res);
  }
}

/** Аватар участника — тоже мимо диска, прямо из Telegram в браузер. */
async function serveUserPhoto(req, res, url) {
  const id = url.searchParams.get('id');
  if (!id || !mtprotoConfigured()) {
    noPicture(res);
    return;
  }

  const key = `user:${id}`;
  const cached = memoryImages.get(key);
  if (cached) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
    res.end(cached);
    return;
  }

  try {
    const buffer = await downloadUserPhoto(id);
    if (!buffer) throw new Error('нет фото');
    rememberImage(key, buffer);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
    res.end(buffer);
  } catch {
    noPicture(res);
  }
}

/** Обои рабочей области, если пользователь загрузил свою картинку. */
async function serveWallpaper(req, res, url) {
  const name = url.searchParams.get('name') || config.profile;
  const store = readProfileStore(name);
  if (store.wallpaper?.type !== 'custom' || !store.wallpaper.file) {
    noPicture(res);
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
    noPicture(res);
  }
}

/** Аватар профиля отдаём как обычную картинку. */
async function serveAvatar(req, res, url) {
  const name = url.searchParams.get('name') || config.profile;
  const file = avatarPath(name);
  if (!file) {
    noPicture(res);
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
    if (req.method === 'GET' && url.pathname === '/api/chat-photo') {
      if (!profileUnlocked(config.profile)) {
        res.writeHead(423).end();
        return;
      }
      await serveChatPhoto(req, res, url);
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
    // Загрузку читаем потоком, поэтому она идёт мимо общего разбора тела
    if (req.method === 'POST' && url.pathname === '/api/drive/receive') {
      await receiveUpload(req, res, url);
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
      // Наружу отдаём причину целиком: «fetch failed» пользователю ничего не говорит
      const message = describeError(err);
      log.error(`${key}: ${message}`);
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
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
