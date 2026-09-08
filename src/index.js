#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, ensureDirs, assertChat, heicMode, livePhotoMode, pairPrefer, BOT_UPLOAD_LIMIT } from './config.js';
import { log, humanSize } from './logger.js';
import { closeDb, fileIdCoverage, listFailed, listTopics, resetFailed, searchFiles, sqliteDriver, stats } from './db.js';
import { messageLink } from './links.js';
import { summarize } from './scanner.js';
import { formatDate } from './dates.js';
import { detectPhones, inspectMount, listMountPoints, mountHint } from './devices.js';
import { collect, requestStop, runSend } from './pipeline.js';
import { cleanupStrayLiveVideos, describeStray } from './cleanup.js';
import { runBot, stopBot } from './bot.js';
import { runWeb } from './web/server.js';
import { listProfiles } from './profiles.js';
import { botConfigured, getChat, getMe } from './telegram/botApi.js';
import { canLogin, disconnect, login, mtprotoConfigured, whoAmI } from './telegram/mtproto.js';

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

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  stopBot();
  if (requestStop()) log.warn('Останавливаюсь после текущего файла… (ещё раз Ctrl+C — выход сразу)');
  else process.exit(130);
});

/* ── общий вывод сканирования ────────────────────────────────────────────── */

function reportScan({ summary, dropped }) {
  log.ok(`К отправке ${summary.count} файлов, ${humanSize(summary.bytes)} (фото ${summary.photos}, видео ${summary.videos}, >50 МБ: ${summary.big})`);
  if (summary.livePhotos) {
    const how = livePhotoMode() === 'live' ? 'уйдут одним сообщением (Live Photo)' : 'видео уйдут отдельно';
    log.info(`Live Photo: ${summary.livePhotos} — ${how}`);
  }
  if (dropped.length) {
    log.info(`Отсеяно как дубликаты по имени: ${dropped.length}`);
    for (const d of dropped.slice(0, 5)) log.plain(`    ${d.file.name} — ${d.reason}`);
    if (dropped.length > 5) log.plain(`    … ещё ${dropped.length - 5}`);
  }
}

const onDateProgress = (done, total) => process.stdout.write(`\r  даты съёмки: ${done}/${total}`);
const clearLine = () => process.stdout.write('\r\x1b[2K');

/* ── команды ─────────────────────────────────────────────────────────────── */

async function cmdDevices() {
  log.info(`Платформа: ${os.platform()}`);
  const phones = await detectPhones();
  if (phones.length) {
    log.ok(`Подключены телефоны: ${phones.map((d) => `${d.name} (${d.udid ?? d.serial})`).join(', ')}`);
  } else {
    log.info('Телефонов по кабелю не видно. Для iPhone нужен libimobiledevice, для Android — adb.');
  }

  const mounts = await listMountPoints();
  if (!mounts.length) log.warn('Смонтированных дисков не найдено.');

  for (const m of mounts) {
    const info = await inspectMount(m);
    const tag = info.looksLikeIPhone ? 'iPhone' : info.looksLikeAndroid ? 'Android' : info.hasDcim ? 'есть DCIM' : '';
    log.plain(`  ${m}${tag ? `  ← ${tag}` : ''}${info.sample.length ? `  [${info.sample.join(', ')}]` : ''}`);
  }

  log.plain('');
  log.plain(mountHint());
}

async function cmdScan(args) {
  const roots = resolveRoots(args);
  log.info(`Сканирую: ${roots.join(', ')}`);
  const scanned = await collect({ roots, since: parseSince(args.since), onDateProgress });
  clearLine();
  reportScan(scanned);

  const { summary } = scanned;
  for (const [ext, v] of summary.byExt) {
    log.plain(`  ${ext.padEnd(6)} ${String(v.n).padStart(6)}  ${humanSize(v.bytes)}`);
  }
  log.plain('  по годам:');
  for (const [year, n] of summary.byYear) log.plain(`    ${year}: ${n}`);
  log.plain(`  источник даты: ${summary.bySource.map(([k, n]) => `${k}=${n}`).join(', ')}`);

  if (summary.big > 0 && !mtprotoConfigured()) {
    log.warn(`${summary.big} файл(ов) больше 50 МБ — для них нужен вход в аккаунт: npm run login`);
  }
}

async function cmdSend(args) {
  assertChat();
  ensureDirs();

  const roots = resolveRoots(args);
  const dryRun = args['dry-run'] === 'true';
  log.info(`Сканирую: ${roots.join(', ')}`);

  await runSend({
    roots,
    since: parseSince(args.since),
    limit: args.limit ? Number(args.limit) : Infinity,
    dryRun,
    hooks: {
      onDateProgress,
      onScanned: (scanned) => {
        clearLine();
        reportScan(scanned);
        log.info(
          `Режим: ${config.sendAsDocument ? 'документы (без сжатия)' : 'лента (фото с превью)'}, ` +
            `HEIC: ${heicMode()}, Live Photo: ${livePhotoMode()}, ` +
            `топики: ${config.topicMode === 'year' ? 'по годам' : 'нет'}`,
        );
        if (dryRun) log.warn('Режим --dry-run: ничего не отправляю.');
      },
      onFile: ({ index, total, file, status, twin, error, result, topicId }) => {
        const num = `${index}/${total}`;
        const when = formatDate(file.takenAt);
        const size = humanSize(file.size);

        if (status === 'planned') {
          const via = file.size > BOT_UPLOAD_LIMIT ? 'аккаунт' : 'бот';
          const live = file.livePhoto ? `, + ${file.livePhoto.name}` : '';
          log.plain(`${num} →  ${when}  ${file.relPath}${live} (${size}, ${via}, дата: ${file.dateSource})`);
        } else if (status === 'duplicate') {
          const same = twin.name.toLowerCase() === file.name.toLowerCase() ? 'уже отправлен' : `тот же кадр, что ${twin.name}`;
          log.plain(`${num} ⏭  ${file.relPath} — ${same} (msg ${twin.message_id})`);
        } else if (status === 'sent') {
          log.ok(
            `${num} ✓ ${when}  ${file.relPath} (${size}, ${result.method}` +
              `${topicId ? `, топик ${topicId}` : ''}, msg ${result.messageId})`,
          );
        } else if (status === 'skipped') {
          log.warn(`${num} ${file.relPath} — пропуск, ${error}`);
        } else {
          log.error(`${num} ✗ ${file.relPath}: ${error}`);
        }
      },
      onFinish: (r) => {
        log.plain('');
        log.ok(`Готово. Отправлено: ${r.sent} (${humanSize(r.bytesSent)}), дубликатов: ${r.duplicates}, ошибок: ${r.failed}`);
        if (r.failed) log.info('Повторить неудачные: npm run start -- retry');
      },
    },
  });
}

function cmdFind(args) {
  const query = args._.slice(1).join(' ').trim();
  if (!query) {
    log.error('Что искать? Например: npm run start -- find IMG_0373');
    process.exitCode = 1;
    return;
  }

  const { rows, total } = searchFiles({ query, limit: Number(args.limit) || 20 });
  if (!total) {
    log.info(`Ничего не нашлось по «${query}»`);
    return;
  }

  log.ok(`Найдено: ${total}${total > rows.length ? `, показываю ${rows.length}` : ''}`);
  for (const row of rows) {
    const when = row.taken_at ? formatDate(row.taken_at) : '—';
    const link = messageLink(row);
    log.plain(`  ${when}  ${row.rel_path || row.name}  ${humanSize(row.size)}  [${row.status}]`);
    if (link) log.plain(`      ${link}`);
  }
}

function cmdProfiles() {
  const profiles = listProfiles();
  log.plain('Профили (у каждого свой бот, своя группа, свой аккаунт и своя база):');
  for (const p of profiles) {
    const mark = p.active ? '●' : ' ';
    const state = p.configured ? `настроен${p.chatId ? `, чат ${p.chatId}` : ''}` : 'не настроен';
    log.plain(`  ${mark} ${p.name.padEnd(16)} ${state}, база ${humanSize(p.dbSize)}`);
  }
  log.plain('');
  log.plain('Работать в другом профиле:  npm run start -- send --profile=имя');
  log.plain('Создать новый профиль:      откройте npm run setup и нажмите «+» рядом с профилем');
}

async function cmdCleanup(args) {
  const apply = args.yes === 'true';
  const r = await cleanupStrayLiveVideos({ apply });

  if (!r.found) {
    log.ok('Лишних видео Live Photo в архиве не нашлось.');
    return;
  }

  log.info(`Видео Live Photo, ушедших отдельным сообщением: ${r.found}`);
  for (const row of r.rows.slice(0, 20)) log.plain(`  ${describeStray(row)}`);
  if (r.found > 20) log.plain(`  … ещё ${r.found - 20}`);

  if (!apply) {
    log.warn('Это предпросмотр. Удалить эти сообщения: npm run start -- cleanup --yes');
    return;
  }

  log.ok(`Удалено сообщений: ${r.deleted}`);
  for (const f of r.failed) log.error(`  ${f.name}: ${f.error}`);
  if (r.failed.length) {
    log.info('Бот удаляет только там, где он админ с правом «Удаление сообщений».');
  }
}

async function cmdStats() {
  const s = stats();
  const cover = fileIdCoverage();

  if (!s.total.n) {
    log.info(`База пуста: ${config.dbPath}`);
    log.plain('  Ещё ничего не отправлено. Запустите: npm run start -- send');
    return;
  }

  log.plain(`База: ${config.dbPath}`);
  log.plain(`Всего записей: ${s.total.n}, ${humanSize(s.total.bytes)}`);
  for (const row of s.byStatus) {
    log.plain(`  ${row.status.padEnd(8)} ${String(row.n).padStart(6)}  ${humanSize(row.bytes)}`);
  }
  for (const row of s.byMethod) log.plain(`  через ${row.method}: ${row.n}`);
  log.plain(`  с file_id: ${cover?.with_file_id ?? 0} из ${cover?.total ?? 0}`);

  if (s.byYear.length) {
    log.plain('\nОтправлено по годам:');
    for (const row of s.byYear) log.plain(`  ${row.year}: ${row.n} (${humanSize(row.bytes)})`);
  }

  const topics = listTopics(config.chatId);
  if (topics.length) {
    log.plain('\nТопики:');
    for (const t of topics) log.plain(`  ${t.title} → ${t.topic_id}`);
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
  log.info(`Профиль: ${config.profile}`);
  log.info(`База: ${config.dbPath} (${sqliteDriver()})`);
  log.info(`Чат: ${config.chatId || '— не задан —'}${config.topicId ? ` (топик ${config.topicId})` : ''}`);
  log.info(
    `Режим отправки: ${config.sendAsDocument ? 'документы' : 'лента (фото)'}, ` +
      `HEIC: ${heicMode()}, пары: ${pairPrefer()}, Live Photo: ${livePhotoMode()}`,
  );
  log.info(config.adminIds.length ? `Админы бота: ${config.adminIds.join(', ')}` : 'TELEGRAM_ADMIN_IDS не задан — команды бота работать не будут');

  if (botConfigured()) {
    try {
      const me = await getMe();
      log.ok(`Бот: @${me.username}`);
      if (config.chatId) {
        const chat = await getChat();
        log.ok(`Чат: ${chat.title ?? chat.username ?? chat.id} (${chat.type}${chat.is_forum ? ', форум' : ''})`);
        if (config.topicMode === 'year' && !chat.is_forum) {
          log.error('TOPIC_MODE=year, но в чате не включены темы. Нужна супергруппа с включённым форумом.');
        }
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

  for (const r of config.scanPaths) log.plain(`  ${fs.existsSync(expand(r)) ? '✓' : '✗'} ${r}`);
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
  npm run start -- check           проверить .env, бота, аккаунт, чат и каталоги
  npm run start -- login           вход в аккаунт (нужен для файлов > 50 МБ)
  npm run start -- scan  [опции]   что лежит на диске: форматы, годы, источники дат
  npm run start -- send  [опции]   отправить всё новое в канал/группу
  npm run setup                    настройка в браузере — самый простой путь
  npm run start -- bot             режим команд: управлять архивом из Telegram
  npm run start -- stats           статистика по базе отправленного
  npm run start -- retry           повторить файлы, упавшие с ошибкой
  npm run start -- cleanup         найти лишние видео Live Photo в архиве
                                   (--yes — удалить эти сообщения)
  npm run start -- profiles        список профилей (у каждого свой архив)
  npm run start -- find <текст>    найти в архиве + ссылки на сообщения

Опции:
  --path=/Volumes/USB      каталог для сканирования (можно повторять)
  --since=2024-01-01       только файлы, снятые позже указанной даты
  --limit=100              обработать не больше N файлов за запуск
  --dry-run                показать план, ничего не отправляя
  --profile=имя            работать в другом профиле (свой бот, группа и база)
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
      case 'bot': await runBot(); break;
      case 'setup':
      case 'web':
        await runWeb({ port: Number(args.port) || 8787, open: args['no-open'] !== 'true' });
        break;
      case 'login': await cmdLogin(); break;
      case 'stats': await cmdStats(); break;
      case 'retry': await cmdRetry(args); break;
      case 'cleanup': await cmdCleanup(args); break;
      case 'profiles': cmdProfiles(); break;
      case 'find': cmdFind(args); break;
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
