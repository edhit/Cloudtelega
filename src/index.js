#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, ensureDirs, assertChat, BOT_UPLOAD_LIMIT } from './config.js';
import { log, humanSize } from './logger.js';
import { closeDb, findByHash, listFailed, markFailed, markSent, resetFailed, stats, upsertPending } from './db.js';
import { sha256Cached } from './hash.js';
import { scanAll, summarize } from './scanner.js';
import { detectIosDevices, inspectMount, listMountPoints, mountHint } from './devices.js';
import { buildJobs, sendJob } from './uploader.js';
import { botConfigured, getChat, getMe } from './telegram/botApi.js';
import { canLogin, disconnect, login, mtprotoConfigured, whoAmI } from './telegram/mtproto.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { _: [], paths: [] };
  for (const raw of argv) {
    if (raw.startsWith('--')) {
      const [k, v = 'true'] = raw.slice(2).split('=');
      if (k === 'path') args.paths.push(expand(v));
      else args[k] = v;
    } else {
      args._.push(raw);
    }
  }
  return args;
}

function expand(p) {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  log.warn('Останавливаюсь после текущего файла… (ещё раз Ctrl+C — выход сразу)');
});

/* ── команды ─────────────────────────────────────────────────────────────── */

async function cmdDevices() {
  log.info(`Платформа: ${os.platform()}`);
  const ios = await detectIosDevices();
  if (ios.length) {
    log.ok(`Найдены устройства Apple: ${ios.map((d) => `${d.name} (${d.udid})`).join(', ')}`);
  } else {
    log.info('libimobiledevice не видит подключённых устройств (или не установлен).');
  }

  const mounts = await listMountPoints();
  if (!mounts.length) log.warn('Смонтированных дисков не найдено.');

  for (const m of mounts) {
    const info = await inspectMount(m);
    const tag = info.looksLikeIPhone ? 'iPhone/камера' : info.hasDcim ? 'есть DCIM' : '';
    log.plain(`  ${m}${tag ? `  ← ${tag}` : ''}${info.sample.length ? `  [${info.sample.join(', ')}]` : ''}`);
  }

  log.plain('');
  log.plain(mountHint());
}

async function cmdScan(args) {
  const roots = resolveRoots(args);
  log.info(`Сканирую: ${roots.join(', ')}`);
  const files = await scanAll(roots, { since: parseSince(args.since) });
  const s = summarize(files);

  log.ok(`Найдено ${s.count} медиафайлов, ${humanSize(s.bytes)}`);
  log.plain(`  фото: ${s.photos}, видео: ${s.videos}, больше 50 МБ: ${s.big}`);
  for (const [ext, v] of s.byExt) {
    log.plain(`  ${ext.padEnd(6)} ${String(v.n).padStart(6)}  ${humanSize(v.bytes)}`);
  }
  if (s.big > 0 && !mtprotoConfigured()) {
    log.warn(`${s.big} файл(ов) больше 50 МБ — для них нужен вход в аккаунт: npm run login`);
  }
  return files;
}

async function cmdSend(args) {
  assertChat();
  ensureDirs();

  const roots = resolveRoots(args);
  const dryRun = args['dry-run'] === 'true';
  const limit = args.limit ? Number(args.limit) : Infinity;

  log.info(`Сканирую: ${roots.join(', ')}`);
  const files = await scanAll(roots, { since: parseSince(args.since) });
  const s = summarize(files);
  log.ok(`Найдено ${s.count} файлов, ${humanSize(s.bytes)} (фото ${s.photos}, видео ${s.videos}, >50 МБ: ${s.big})`);

  if (!files.length) return;
  if (dryRun) log.warn('Режим --dry-run: ничего не отправляю.');

  let sent = 0;
  let duplicates = 0;
  let failed = 0;
  let processed = 0;
  let bytesSent = 0;

  for (const file of files) {
    if (stopRequested) break;
    if (processed >= limit) {
      log.info(`Достигнут лимит --limit=${limit}`);
      break;
    }
    processed += 1;

    const num = `${processed}/${Math.min(files.length, limit === Infinity ? files.length : limit)}`;

    let sha256;
    try {
      sha256 = await sha256Cached(file.absPath, file.size, file.mtime);
    } catch (err) {
      log.error(`${num} ${file.name}: не удалось прочитать (${err.message})`);
      failed += 1;
      continue;
    }

    const existing = findByHash(sha256);
    if (existing?.status === 'sent') {
      duplicates += 1;
      log.plain(`${num} ⏭  ${file.relPath} — уже отправлен (msg ${existing.message_id})`);
      continue;
    }
    if (existing?.status === 'failed' && existing.attempts >= config.maxAttempts) {
      log.warn(`${num} ${file.relPath} — пропуск, ${existing.attempts} неудачных попыток`);
      continue;
    }

    const record = { ...file, sha256 };
    if (dryRun) {
      log.plain(`${num} →  ${file.relPath} (${humanSize(file.size)}, ${file.size > BOT_UPLOAD_LIMIT ? 'аккаунт' : 'бот'})`);
      continue;
    }

    upsertPending(record);

    try {
      const jobs = await buildJobs(record);
      let firstResult = null;
      for (const job of jobs) {
        const res = await sendJob(job);
        firstResult ??= res;
      }
      markSent(sha256, { method: firstResult.method, chatId: config.chatId, messageId: firstResult.messageId });
      sent += 1;
      bytesSent += file.size;
      log.ok(`${num} ✓ ${file.relPath} (${humanSize(file.size)}, ${firstResult.method}, msg ${firstResult.messageId})`);
    } catch (err) {
      failed += 1;
      markFailed(sha256, err.message ?? err);
      log.error(`${num} ✗ ${file.relPath}: ${err.message ?? err}`);
      if (err.code === 'NO_TRANSPORT') break;
    }

    if (config.sendDelayMs > 0) await sleep(config.sendDelayMs);
  }

  log.plain('');
  log.ok(`Готово. Отправлено: ${sent} (${humanSize(bytesSent)}), дубликатов: ${duplicates}, ошибок: ${failed}`);
  if (failed) log.info('Повторить неудачные: npm run start -- retry');
}

async function cmdStats() {
  const s = stats();
  log.plain(`Всего в базе: ${s.total.n} файлов, ${humanSize(s.total.bytes)}`);
  for (const row of s.byStatus) {
    log.plain(`  ${row.status.padEnd(8)} ${String(row.n).padStart(6)}  ${humanSize(row.bytes)}`);
  }
  for (const row of s.byMethod) {
    log.plain(`  через ${row.method}: ${row.n}`);
  }
  const failed = listFailed(10);
  if (failed.length) {
    log.plain('\nПоследние ошибки:');
    for (const f of failed) log.plain(`  ${f.name} — ${f.last_error}`);
  }
}

async function cmdRetry(args) {
  const n = resetFailed();
  log.ok(`Сброшено в очередь: ${n}`);
  if (n > 0) await cmdSend(args);
}

async function cmdLogin() {
  if (!canLogin()) {
    log.error('Заполните TELEGRAM_API_ID и TELEGRAM_API_HASH в .env (https://my.telegram.org).');
    process.exitCode = 1;
    return;
  }
  const { me } = await login();
  log.ok(`Вход выполнен: ${me.firstName ?? ''} ${me.username ? `@${me.username}` : ''}`.trim());
  log.info('Теперь файлы больше 50 МБ будут уходить от имени аккаунта.');
}

async function cmdCheck() {
  log.info(`База: ${config.dbPath}`);
  log.info(`Чат: ${config.chatId || '— не задан —'}${config.topicId ? ` (топик ${config.topicId})` : ''}`);

  if (botConfigured()) {
    try {
      const me = await getMe();
      log.ok(`Бот: @${me.username}`);
      if (config.chatId) {
        const chat = await getChat();
        log.ok(`Чат: ${chat.title ?? chat.username ?? chat.id} (${chat.type})`);
      }
    } catch (err) {
      log.error(`Бот: ${err.message}`);
    }
  } else {
    log.warn('TELEGRAM_BOT_TOKEN не задан — файлы до 50 МБ отправлять нечем.');
  }

  if (mtprotoConfigured()) {
    try {
      const me = await whoAmI();
      log.ok(`Аккаунт: ${me.firstName ?? ''} ${me.username ? `@${me.username}` : ''}`.trim());
    } catch (err) {
      log.error(`Аккаунт: ${err.message}`);
    }
  } else {
    log.warn('Аккаунт не подключён — файлы больше 50 МБ отправить не получится (npm run login).');
  }

  const roots = config.scanPaths;
  for (const r of roots) {
    log.plain(`  ${fs.existsSync(r) ? '✓' : '✗'} ${r}`);
  }
}

/* ── вспомогательное ─────────────────────────────────────────────────────── */

function resolveRoots(args) {
  const roots = args.paths.length ? args.paths : config.scanPaths.map(expand);
  if (!roots.length) {
    throw new Error('Не указаны каталоги. Используйте --path=/Volumes/USB или SCAN_PATHS в .env');
  }
  return roots;
}

function parseSince(value) {
  if (!value) return 0;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Не понимаю дату --since=${value} (нужен формат 2024-01-31)`);
  return t;
}

function usage() {
  log.plain(`
cloudtelega — Telegram как облачное хранилище для фото и видео

  npm run devices                  список дисков и iPhone, подсказки по монтированию
  npm run start -- check           проверить .env, бота, аккаунт и каталоги
  npm run start -- login           вход в аккаунт (нужен для файлов > 50 МБ)
  npm run start -- scan  [опции]   только посчитать, что лежит на диске
  npm run start -- send  [опции]   отправить всё новое в канал/группу
  npm run start -- stats           статистика по базе отправленного
  npm run start -- retry           повторить файлы, упавшие с ошибкой

Опции:
  --path=/Volumes/USB      каталог для сканирования (можно повторять)
  --since=2024-01-01       только файлы новее указанной даты
  --limit=100              обработать не больше N файлов за запуск
  --dry-run                показать план, ничего не отправляя
`);
}

/* ── точка входа ─────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'help';

  try {
    switch (cmd) {
      case 'devices': await cmdDevices(); break;
      case 'scan': await cmdScan(args); break;
      case 'send': await cmdSend(args); break;
      case 'login': await cmdLogin(); break;
      case 'stats': await cmdStats(); break;
      case 'retry': await cmdRetry(args); break;
      case 'check': await cmdCheck(); break;
      default: usage(); break;
    }
  } catch (err) {
    log.error(err.message ?? err);
    process.exitCode = 1;
  } finally {
    await disconnect();
    closeDb();
  }
}

main();
