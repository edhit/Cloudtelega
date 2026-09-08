import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { log, humanSize } from './logger.js';
import { formatDate } from './dates.js';
import {
  fileIdCoverage, getMeta, lastSent, listFailed, listTopics, randomSent,
  resetFailed, searchSent, setMeta, stats,
} from './db.js';
import { detectIosDevices, inspectMount, listMountPoints } from './devices.js';
import { collect, isRunning, requestStop, runSend, sendState } from './pipeline.js';
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

/** Ссылка на сообщение в приватном канале/супергруппе. */
function messageLink(row) {
  const chat = String(row.chat_id ?? config.chatId);
  if (!chat.startsWith('-100') || !row.message_id) return null;
  return `https://t.me/c/${chat.slice(4)}/${row.message_id}`;
}

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
    log.error(`Отправка упала: ${err.message}`);
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
  const ios = await detectIosDevices();
  const mounts = await listMountPoints();
  const lines = [];

  lines.push(ios.length ? `Apple: ${ios.map((d) => d.name).join(', ')}` : 'Устройств Apple не видно');
  lines.push('', 'Смонтировано:');
  for (const m of mounts) {
    const info = await inspectMount(m);
    const tag = info.looksLikeIPhone ? ' ← iPhone/камера' : info.hasDcim ? ' ← есть DCIM' : '';
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

async function cmdTopics(chatId) {
  const rows = listTopics(config.chatId);
  if (!rows.length) return sendMessage(chatId, 'Топиков пока нет (TOPIC_MODE=year создаст их при отправке)');
  return sendMessage(chatId, rows.map((t) => `${t.title} → ${t.topic_id}`).join('\n'));
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
    case '/retry': {
      const n = resetFailed();
      return sendMessage(chatId, n ? `Вернул в очередь: ${n}. Запустить: /send` : 'Упавших файлов нет');
    }
    default:
      return sendMessage(chatId, `Не знаю команду ${cmd}. /help — список.`);
  }
}

/* ── цикл long polling ───────────────────────────────────────────────────── */

let stopped = false;

export function stopBot() {
  stopped = true;
}

export async function runBot() {
  if (!config.botToken) throw new Error('TELEGRAM_BOT_TOKEN не задан — команды принимать нечем');
  if (!config.adminIds.length) {
    log.warn('TELEGRAM_ADMIN_IDS пуст: бот будет отвечать только на /id, пока вы не добавите свой id в .env');
  }

  await setMyCommands(COMMANDS).catch((err) => log.warn(`setMyCommands: ${err.message}`));

  let offset = Number.parseInt(getMeta('bot_update_offset') ?? '0', 10) || 0;
  log.ok('Бот слушает команды. Ctrl+C — выход. Напишите ему /help');

  while (!stopped) {
    let updates;
    try {
      updates = await getUpdates(offset, 30);
    } catch (err) {
      log.warn(`getUpdates: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      setMeta('bot_update_offset', offset);

      const msg = update.message;
      if (!msg?.text?.startsWith('/')) continue;
      // Команды принимаем только в личке с ботом, не в самом хранилище
      if (msg.chat.type !== 'private') continue;

      try {
        await handleCommand(msg);
      } catch (err) {
        log.error(`Команда «${msg.text}»: ${err.message}`);
        await sendMessage(msg.chat.id, `Ошибка: ${err.message}`).catch(() => {});
      }
    }
  }
}
