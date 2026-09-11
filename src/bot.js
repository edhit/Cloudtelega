import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { log, humanSize } from './logger.js';
import { describeError } from './errors.js';
import { formatDate } from './dates.js';
import {
  fileIdCoverage, getMeta, lastSent, listFailed, listTopics, randomSent,
  resetFailed, searchSent, setMeta, stats,
} from './db.js';
import { detectPhones, inspectMount, listMountPoints } from './devices.js';
import { collect, isRunning, requestStop, runSend, sendState } from './pipeline.js';
import { messageLink } from './links.js';
import { cleanupStrayLiveVideos, describeStray } from './cleanup.js';
import { accessOverview, createAccessLink, expireGuests, noteJoin, removeGuest, timeLeft } from './sharing.js';
import { ingestUpdates } from './ingest.js';
import { driveOverview } from './drive.js';
import {
  copyMessage, editMessageText, getUpdates, sendByFileId, sendLivePhotoByFileId,
  sendMessage, setMyCommands,
} from './telegram/botApi.js';

const COMMANDS = [
  { command: 'status', description: 'что сейчас происходит и что в базе' },
  { command: 'scan', description: 'посмотреть, что нового на диске' },
  { command: 'send', description: 'отправить всё новое' },
  { command: 'stop', description: 'остановить отправку' },
  { command: 'devices', description: 'подключённые диски и iPhone' },
  { command: 'find', description: 'найти файл в архиве по имени' },
  { command: 'get', description: 'прислать файл из архива' },
  { command: 'random', description: 'случайный кадр (можно указать год)' },
  { command: 'last', description: 'последние отправленные' },
  { command: 'stats', description: 'статистика по годам' },
  { command: 'topics', description: 'топики-годы' },
  { command: 'retry', description: 'повторить упавшие' },
  { command: 'cleanup', description: 'убрать лишние видео Live Photo' },
  { command: 'share', description: 'ссылка на диск: /share день|неделя|месяц' },
  { command: 'guests', description: 'кому открыт доступ к диску' },
  { command: 'kick', description: 'закрыть доступ гостю: /kick <id>' },
  { command: 'drive', description: 'что лежит на диске' },
  { command: 'id', description: 'узнать свой id' },
  { command: 'help', description: 'список команд' },
];

const HELP = [
  'Cloudtelega — управление архивом.',
  '',
  '/status — идёт ли отправка, что уже в базе',
  '/scan [путь] — посмотреть, что нового (ничего не отправляет)',
  '/send [путь] — отправить всё новое; прогресс появится тут же',
  '/stop — остановить отправку после текущего файла',
  '/devices — какие диски и iPhone видны сейчас',
  '/find <текст> — найти в архиве по имени или пути',
  '/get <текст|sha> — прислать файл сюда (мгновенно, по file_id)',
  '/random [год] — случайный кадр из архива',
  '/last [n] — последние отправленные',
  '/stats — сколько всего и по годам',
  '/topics — топики-годы и их id',
  '/retry — вернуть упавшие файлы в очередь',
  '/cleanup — найти лишние видео Live Photo (/cleanup yes — удалить их сообщения)',
  '',
  'Диск и доступ:',
  '/drive — сколько файлов на диске и куда он сложен',
  '/share [день|неделя|месяц|год|навсегда] — ссылка-приглашение на диск',
  '/guests — кто внутри и сколько ему осталось',
  '/kick <id> — закрыть доступ (человек не банится, сможет войти снова)',
].join('\n');

/* ── доступ и пути ───────────────────────────────────────────────────────── */

function isAdmin(userId) {
  return config.adminIds.includes(String(userId));
}

/** Каталог разрешён, если он лежит внутри SCAN_PATHS или смонтированного диска. */
async function allowedRoot(requested) {
  const target = path.resolve(requested.startsWith('~') ? path.join(os.homedir(), requested.slice(1)) : requested);
  if (config.botAllowAnyPath) return target;

  const allowed = [...config.scanPaths.map((p) => path.resolve(p)), ...(await listMountPoints())];
  const ok = allowed.some((base) => target === base || target.startsWith(`${base}${path.sep}`));
  if (!ok) {
    throw new Error(
      `Каталог ${target} не разрешён. Разрешены SCAN_PATHS и смонтированные диски ` +
        '(или включите BOT_ALLOW_ANY_PATH=true).',
    );
  }
  return target;
}

async function rootsFrom(arg) {
  if (arg) return [await allowedRoot(arg)];
  if (!config.scanPaths.length) throw new Error('SCAN_PATHS пуст — укажите каталог: /send /Volumes/USB');
  return config.scanPaths.map((p) => path.resolve(p));
}

/* ── вспомогательное ─────────────────────────────────────────────────────── */

function describe(row) {
  const when = row.taken_at ? formatDate(row.taken_at) : '—';
  const link = messageLink(row);
  return `${when} · ${row.rel_path || row.name} · ${humanSize(row.size)}${link ? `\n${link}` : ''}`;
}

/** Отправляет файл из архива обратно в чат: по file_id, иначе копией сообщения. */
async function resend(chatId, row) {
  if (row.file_type === 'live_photo' && row.file_id && row.video_file_id) {
    return sendLivePhotoByFileId(chatId, row.file_id, row.video_file_id, { caption: describe(row) });
  }
  if (row.file_id) {
    return sendByFileId(chatId, row.file_type ?? 'document', row.file_id, { caption: describe(row) });
  }
  if (row.message_id) {
    // Файл ушёл через аккаунт — file_id у бота нет, копируем сообщение из хранилища
    return copyMessage(chatId, row.chat_id ?? config.chatId, row.message_id);
  }
  throw new Error('у записи нет ни file_id, ни message_id');
}

function statusText() {
  const s = sendState();
  const db = stats();
  const sent = db.byStatus.find((r) => r.status === 'sent');
  const failed = db.byStatus.find((r) => r.status === 'failed');
  const cover = fileIdCoverage();

  const lines = [];
  if (s.running && !s.total) {
    lines.push('⏳ Сканирую каталоги (считаю хеши и даты съёмки)…', 'Остановить: /stop', '');
  } else if (s.running) {
    const mins = Math.round((Date.now() - s.startedAt) / 60000);
    lines.push(
      `⏳ Идёт отправка: ${s.processed}/${s.total} (${s.sent} отправлено, ${s.duplicates} дублей, ${s.failed} ошибок)`,
      `Сейчас: ${s.current ?? '—'}`,
      `В работе ${mins} мин. Остановить: /stop`,
      '',
    );
  } else {
    lines.push('💤 Отправка не идёт', '');
  }

  lines.push(
    `В архиве: ${sent?.n ?? 0} файлов, ${humanSize(sent?.bytes ?? 0)}`,
    `С file_id (можно переслать мгновенно): ${cover?.with_file_id ?? 0} из ${cover?.total ?? 0}`,
  );
  if (failed?.n) lines.push(`Ошибок в базе: ${failed.n} — /retry`);
  return lines.join('\n');
}

/* ── команды ─────────────────────────────────────────────────────────────── */

async function cmdSendFiles(chatId, arg) {
  if (isRunning()) return sendMessage(chatId, 'Отправка уже идёт. /status покажет прогресс, /stop остановит.');

  const roots = await rootsFrom(arg);
  const progress = await sendMessage(chatId, `Сканирую ${roots.join(', ')}…`);
  let lastEdit = 0;

  // Запускаем в фоне: бот должен продолжать отвечать на команды во время отправки.
  runSend({
    roots,
    hooks: {
      onScanned: async ({ summary, dropped }) => {
        const parts = [
          `Найдено ${summary.count} файлов, ${humanSize(summary.bytes)}`,
          `фото ${summary.photos}, видео ${summary.videos}, больше 50 МБ ${summary.big}`,
        ];
        if (summary.livePhotos) parts.push(`Live Photo: ${summary.livePhotos}`);
        if (dropped.length) parts.push(`дубликатов по имени отсеяно: ${dropped.length}`);
        await editMessageText(chatId, progress.message_id, `${parts.join('\n')}\n\nНачинаю отправку…`);
      },
      onFile: async () => {
        const now = Date.now();
        if (now - lastEdit < 4000) return; // Telegram не любит частых правок
        lastEdit = now;
        const s = sendState();
        await editMessageText(
          chatId,
          progress.message_id,
          `⏳ ${s.processed}/${s.total} · отправлено ${s.sent} (${humanSize(s.bytesSent)}) · дублей ${s.duplicates} · ошибок ${s.failed}\n${s.current ?? ''}`,
        ).catch(() => {});
      },
      onFinish: async (r) => {
        const head = r.stopped ? '⏹ Остановлено' : '✅ Готово';
        await editMessageText(
          chatId,
          progress.message_id,
          `${head}: отправлено ${r.sent} (${humanSize(r.bytesSent)}), дублей ${r.duplicates}, ошибок ${r.failed}` +
            (r.failed ? '\nПовторить: /retry' : ''),
        ).catch(() => {});
      },
    },
  }).catch((err) => {
    log.error(`Отправка упала: ${describeError(err)}`);
    sendMessage(chatId, `Отправка прервалась: ${err.message}`).catch(() => {});
  });

  return null;
}

async function cmdScanOnly(chatId, arg) {
  const roots = await rootsFrom(arg);
  await sendMessage(chatId, `Сканирую ${roots.join(', ')}… это может занять пару минут.`);
  const { summary, dropped } = await collect({ roots });

  const lines = [
    `Найдено ${summary.count} файлов, ${humanSize(summary.bytes)}`,
    `фото ${summary.photos}, видео ${summary.videos}, больше 50 МБ ${summary.big}`,
  ];
  if (summary.livePhotos) lines.push(`Live Photo: ${summary.livePhotos}`);
  if (dropped.length) lines.push(`дубликатов по имени: ${dropped.length}`);
  lines.push('', 'По годам:');
  for (const [year, n] of summary.byYear) lines.push(`  ${year}: ${n}`);
  lines.push('', `Источник даты: ${summary.bySource.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  lines.push('', 'Отправить: /send');
  return sendMessage(chatId, lines.join('\n'));
}

async function cmdDevices(chatId) {
  const phones = await detectPhones();
  const mounts = await listMountPoints();
  const lines = [];

  lines.push(phones.length ? `Телефоны: ${phones.map((d) => d.name).join(', ')}` : 'Телефонов по кабелю не видно');
  lines.push('', 'Смонтировано:');
  for (const m of mounts) {
    const info = await inspectMount(m);
    const tag = info.looksLikeIPhone ? ' ← iPhone' : info.looksLikeAndroid ? ' ← Android' : info.hasDcim ? ' ← есть DCIM' : '';
    lines.push(`  ${m}${tag}`);
  }
  if (!mounts.length) lines.push('  (ничего)');
  return sendMessage(chatId, lines.join('\n'));
}

async function cmdStats(chatId) {
  const s = stats();
  const lines = [`Всего в базе: ${s.total.n}, ${humanSize(s.total.bytes)}`];
  for (const row of s.byStatus) lines.push(`  ${row.status}: ${row.n} (${humanSize(row.bytes)})`);
  if (s.byYear.length) {
    lines.push('', 'Отправлено по годам:');
    for (const row of s.byYear) lines.push(`  ${row.year}: ${row.n} (${humanSize(row.bytes)})`);
  }
  const failed = listFailed(5);
  if (failed.length) {
    lines.push('', 'Последние ошибки:');
    for (const f of failed) lines.push(`  ${f.name}: ${String(f.last_error).slice(0, 80)}`);
  }
  return sendMessage(chatId, lines.join('\n'));
}

async function cmdFind(chatId, query) {
  if (!query) return sendMessage(chatId, 'Что искать? Например: /find IMG_0042');
  const rows = searchSent(query, 10);
  if (!rows.length) return sendMessage(chatId, `Ничего не нашлось по «${query}»`);
  const lines = rows.map((r, i) => `${i + 1}. ${describe(r)}`);
  lines.push('', 'Прислать сюда: /get ' + query);
  return sendMessage(chatId, lines.join('\n'));
}

async function cmdGet(chatId, query) {
  if (!query) return sendMessage(chatId, 'Что прислать? Например: /get IMG_0042');
  const rows = searchSent(query, 1);
  if (!rows.length) return sendMessage(chatId, `Ничего не нашлось по «${query}»`);
  try {
    await resend(chatId, rows[0]);
  } catch (err) {
    await sendMessage(chatId, `Не получилось прислать ${rows[0].name}: ${err.message}`);
  }
  return null;
}

async function cmdRandom(chatId, arg) {
  const year = /^(19|20)\d{2}$/.test(arg ?? '') ? arg : null;
  const row = randomSent(year);
  if (!row) return sendMessage(chatId, year ? `За ${year} ничего нет` : 'Архив пока пуст');
  try {
    await resend(chatId, row);
  } catch (err) {
    await sendMessage(chatId, `Не получилось прислать ${row.name}: ${err.message}`);
  }
  return null;
}

async function cmdLast(chatId, arg) {
  const n = Math.min(Math.max(Number.parseInt(arg ?? '5', 10) || 5, 1), 20);
  const rows = lastSent(n);
  if (!rows.length) return sendMessage(chatId, 'Пока ничего не отправлено');
  return sendMessage(chatId, rows.map((r, i) => `${i + 1}. ${describe(r)}`).join('\n'));
}

async function cmdCleanup(chatId, arg) {
  const apply = ['yes', 'да', 'удалить'].includes((arg ?? '').toLowerCase());
  const r = await cleanupStrayLiveVideos({ apply });

  if (!r.found) return sendMessage(chatId, 'Лишних видео Live Photo не нашлось.');

  const lines = [`Видео Live Photo, ушедших отдельным сообщением: ${r.found}`, ''];
  for (const row of r.rows.slice(0, 15)) lines.push(`• ${describeStray(row)}`);
  if (r.found > 15) lines.push(`… ещё ${r.found - 15}`);

  if (!apply) {
    lines.push('', 'Удалить эти сообщения: /cleanup yes');
  } else {
    lines.push('', `Удалено: ${r.deleted}`);
    for (const f of r.failed) lines.push(`не вышло: ${f.name} — ${f.error}`);
  }
  return sendMessage(chatId, lines.join('\n'));
}

async function cmdTopics(chatId) {
  const rows = listTopics(config.chatId);
  if (!rows.length) return sendMessage(chatId, 'Топиков пока нет (TOPIC_MODE=year создаст их при отправке)');
  return sendMessage(chatId, rows.map((t) => `${t.title} → ${t.topic_id}`).join('\n'));
}

/* ── диск и доступ ───────────────────────────────────────────────────────── */

const SHARE_WORDS = {
  день: 'day', сутки: 'day', day: 'day',
  неделя: 'week', неделю: 'week', week: 'week',
  месяц: 'month', month: 'month',
  год: 'year', year: 'year',
  навсегда: 'forever', forever: 'forever',
};

async function cmdDrive(chatId) {
  const d = driveOverview();
  if (!d.chatId) return sendMessage(chatId, 'Диск ещё не настроен — выберите для него чат в мастере.');
  return sendMessage(
    chatId,
    [
      `📁 На диске: ${d.files} ${plural(d.files, 'файл', 'файла', 'файлов')}, ${humanSize(d.bytes)}`,
      d.separateChat ? 'Хранится в отдельном чате — архив снимков гостям не виден' : 'Лежит в том же чате, что и снимки',
      d.folders ? 'Папки раскладываются по темам' : 'Всё одной лентой',
    ].join('\n'),
  );
}

async function cmdShare(chatId, arg) {
  const word = (arg || '').trim().toLowerCase();
  const preset = SHARE_WORDS[word] ?? 'week';
  const invite = await createAccessLink({ accessPreset: preset, memberLimit: 1 });
  return sendMessage(
    chatId,
    [
      `🔗 Ссылка на диск (${invite.name}):`,
      invite.link,
      '',
      'Одноразовая: войти по ней сможет один человек.',
      invite.access_ms
        ? `Через ${timeLeft(Date.now() + invite.access_ms)} доступ закроется сам — гость будет убран, но не забанен.`
        : 'Доступ бессрочный.',
    ].join('\n'),
  );
}

async function cmdGuests(chatId) {
  const { guests, members } = await accessOverview();
  if (!guests.length) return sendMessage(chatId, 'На диске пока нет гостей.');

  const lines = guests.map((g) => {
    const who = g.username ? `@${g.username}` : g.name;
    return `• ${who} — ${g.expired ? 'срок истёк' : g.left} (id ${g.user_id})`;
  });
  if (members) lines.push('', `Всего участников в чате: ${members}`);
  return sendMessage(chatId, ['👥 Доступ к диску:', ...lines].join('\n'));
}

async function cmdKick(chatId, arg) {
  const id = (arg || '').match(/\d{5,}/)?.[0];
  if (!id) return sendMessage(chatId, 'Кого убрать? Например: /kick 123456789 (id виден в /guests)');
  await removeGuest(id);
  return sendMessage(chatId, `Готово: ${id} убран с диска. Не забанен — сможет войти по новой ссылке.`);
}

/* ── разбор команд ───────────────────────────────────────────────────────── */

async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();
  const arg = rest.join(' ').trim();

  if (cmd === '/id') {
    return sendMessage(chatId, `Ваш id: ${msg.from.id}\nЧтобы управлять ботом, добавьте его в TELEGRAM_ADMIN_IDS.`);
  }

  if (!isAdmin(msg.from.id)) {
    log.warn(`Команда ${cmd} от постороннего: ${msg.from.id} (${msg.from.username ?? '—'})`);
    return sendMessage(chatId, `Доступ только для владельца. Ваш id: ${msg.from.id}`);
  }

  switch (cmd) {
    case '/start':
    case '/help': return sendMessage(chatId, HELP);
    case '/status': return sendMessage(chatId, statusText());
    case '/stats': return cmdStats(chatId);
    case '/scan': return cmdScanOnly(chatId, arg);
    case '/send': return cmdSendFiles(chatId, arg);
    case '/stop':
      return sendMessage(chatId, requestStop() ? 'Останавливаюсь после текущего файла…' : 'Сейчас ничего не отправляется');
    case '/devices': return cmdDevices(chatId);
    case '/find': return cmdFind(chatId, arg);
    case '/get': return cmdGet(chatId, arg);
    case '/random': return cmdRandom(chatId, arg);
    case '/last': return cmdLast(chatId, arg);
    case '/topics': return cmdTopics(chatId);
    case '/cleanup': return cmdCleanup(chatId, arg);
    case '/drive': return cmdDrive(chatId);
    case '/share': return cmdShare(chatId, arg);
    case '/guests': return cmdGuests(chatId);
    case '/kick': return cmdKick(chatId, arg);
    case '/retry': {
      const n = resetFailed();
      return sendMessage(chatId, n ? `Вернул в очередь: ${n}. Запустить: /send` : 'Упавших файлов нет');
    }
    default:
      return sendMessage(chatId, `Не знаю команду ${cmd}. /help — список.`);
  }
}

/* ── приветствие ─────────────────────────────────────────────────────────── */

const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

/** Что бот пишет владельцу, как только начал слушать команды. */
function greeting() {
  const sent = stats().byStatus.find((r) => r.status === 'sent')?.n ?? 0;
  const archive = sent
    ? `В архиве уже ${sent} ${plural(sent, 'файл', 'файла', 'файлов')}.`
    : 'Архив пока пуст — отправьте первую партию командой /send.';

  return [
    'Готов к работе — командуйте прямо отсюда, к компьютеру подходить не нужно.',
    '',
    archive,
    '',
    'Самое нужное:',
    '/send — отправить всё новое с диска или телефона',
    '/status — что сейчас происходит',
    '/random — случайный кадр из архива',
    '',
    '/help — весь список команд',
  ].join('\n');
}

/* ── цикл long polling ───────────────────────────────────────────────────── */

let stopped = false;
// Кого и что бот видел с момента запуска: из этого мастер берёт список групп
// и людей, не дёргая getUpdates второй раз (Telegram разрешает только один).
const seen = { chats: new Map(), people: new Map() };
const botStatus = { running: false, startedAt: 0, error: null, greeted: 0 };
// Через него обрываем висящий запрос к Telegram, когда бота выключают
let poll = null;
// Номер запуска: старый цикл, догорая после перезапуска, не должен гасить новый
let generation = 0;
// Как часто смотреть, у кого вышел срок доступа к диску
const GUEST_SWEEP_MS = 5 * 60 * 1000;

export function botState() {
  return { ...botStatus, chats: seen.chats.size, people: seen.people.size };
}

export function botRunning() {
  return botStatus.running;
}

/** Группы и каналы, где бот что-то видел за эту сессию. */
export function seenChats() {
  return [...seen.chats.values()];
}

/** Люди, писавшие боту в личку за эту сессию. */
export function seenPeople() {
  return [...seen.people.values()];
}

/** Запоминает, откуда и от кого пришёл апдейт — для списков в мастере. */
function remember(update) {
  const chat =
    update.channel_post?.chat ?? update.message?.chat ??
    update.my_chat_member?.chat ?? update.edited_channel_post?.chat;

  if (chat && chat.type !== 'private') {
    seen.chats.set(String(chat.id), {
      id: String(chat.id),
      title: chat.title ?? String(chat.id),
      type: chat.type,
      isForum: Boolean(chat.is_forum),
    });
  }

  const from = update.message?.from ?? update.edited_message?.from;
  if (from && !from.is_bot && update.message?.chat?.type === 'private') {
    seen.people.set(String(from.id), {
      id: String(from.id),
      name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Пользователь',
      username: from.username ?? null,
    });
  }
}

/**
 * Останавливает бота сразу: висящий long polling обрывается, иначе цикл жил бы
 * ещё до полминуты и мешал бы новому запуску (Telegram разрешает только один
 * getUpdates на бота).
 */
export function stopBot() {
  stopped = true;
  poll?.abort();
  poll = null;
  botStatus.running = false;
}

/**
 * Слушает команды в личке. Возвращает управление только когда бота остановили,
 * поэтому мастер запускает её без await и глушит через stopBot().
 */
export async function runBot({ greet = true } = {}) {
  if (!config.botToken) throw new Error('TELEGRAM_BOT_TOKEN не задан — команды принимать нечем');
  if (!config.adminIds.length) {
    log.warn('TELEGRAM_ADMIN_IDS пуст: бот будет отвечать только на /id, пока вы не добавите свой id в .env');
  }

  stopped = false;
  poll = new AbortController();
  generation += 1;
  const mine = generation;
  botStatus.running = true;
  botStatus.startedAt = Date.now();
  botStatus.error = null;

  await setMyCommands(COMMANDS).catch((err) => log.warn(`Не удалось объявить команды боту: ${describeError(err, { kind: 'bot' })}`));

  // «Я на связи» — чтобы не гадать, работает бот или нет
  if (greet) {
    for (const id of config.adminIds) {
      // Со звуком: это единственное сообщение, которое бот шлёт сам, и его ждут
      await sendMessage(id, greeting(), { disable_notification: false })
        .catch((err) => log.warn(`Не смог поздороваться с ${id}: ${describeError(err, { kind: 'bot' })}`));
    }
    botStatus.greeted = Date.now();
  }

  let offset = Number.parseInt(getMeta('bot_update_offset') ?? '0', 10) || 0;
  log.ok('Бот слушает команды. Ctrl+C — выход. Напишите ему /help');

  // Просроченных гостей убираем сами: Telegram умеет только гасить ссылку,
  // а выгонять того, кто уже вошёл, приходится нам.
  const sweeper = setInterval(() => {
    expireGuests().catch((err) => log.warn(`Проверка сроков доступа: ${describeError(err)}`));
  }, GUEST_SWEEP_MS);
  // Первый проход сразу: пока бот стоял, сроки могли выйти
  expireGuests().catch(() => {});

  try {
    while (!stopped && generation === mine) {
      let updates;
      try {
        updates = await getUpdates(offset, 30, { signal: poll?.signal });
        if (generation !== mine) break; // нас перезапустили, пока мы ждали
        botStatus.error = null;
      } catch (err) {
        if (stopped || generation !== mine || err.name === 'AbortError') break;
        botStatus.error = err.message;
        log.warn(`Бот не смог получить команды: ${describeError(err, { kind: 'bot' })}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // Файлы, выложенные в чат диска прямо из Telegram, забираем в базу:
      // иначе список в окне и содержимое чата расходятся
      try {
        const added = ingestUpdates(updates);
        if (added) log.ok(`Из чата подхвачено файлов: ${added}`);
      } catch (err) {
        log.warn(`Подхват файлов из чата не удался: ${describeError(err)}`);
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        setMeta('bot_update_offset', offset);
        remember(update);

        // Кто-то вошёл или вышел из диска — запоминаем срок его доступа
        if (update.chat_member || update.chat_join_request) {
          try {
            noteJoin(update);
          } catch (err) {
            log.warn(`Не удалось записать гостя: ${describeError(err)}`);
          }
        }

        const msg = update.message;
        if (!msg?.text?.startsWith('/')) continue;
        // Команды принимаем только в личке с ботом, не в самом хранилище
        if (msg.chat.type !== 'private') continue;

        try {
          await handleCommand(msg);
        } catch (err) {
          log.error(`Команда «${msg.text}»: ${describeError(err)}`);
          await sendMessage(msg.chat.id, `Ошибка: ${err.message}`).catch(() => {});
        }
      }
    }
  } finally {
    clearInterval(sweeper);
    // Гасим только если нас не сменил новый запуск
    if (generation === mine) botStatus.running = false;
  }
}
