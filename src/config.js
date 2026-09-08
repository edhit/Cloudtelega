import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const int = (v, def) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
};

const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  chatId: process.env.TELEGRAM_CHAT_ID?.trim() || '',
  topicId: int(process.env.TELEGRAM_TOPIC_ID, null),

  botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || '',
  botApiRoot: (process.env.TELEGRAM_BOT_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, ''),

  apiId: int(process.env.TELEGRAM_API_ID, 0),
  apiHash: process.env.TELEGRAM_API_HASH?.trim() || '',
  session: process.env.TELEGRAM_SESSION?.trim() || '',

  scanPaths: list(process.env.SCAN_PATHS),
  dbPath: path.resolve(process.env.DB_PATH || './data/cloudtelega.db'),
  tmpDir: path.resolve(process.env.TMP_DIR || './tmp'),

  // auto: в режиме ленты HEIC конвертируется в JPEG, в режиме документов уходит оригинал
  heicMode: (process.env.HEIC_MODE || 'auto').toLowerCase(),
  heicQuality: int(process.env.HEIC_JPEG_QUALITY, 92),
  // false — отправлять фото/видео лентой (с превью), true — документами (без сжатия)
  sendAsDocument: bool(process.env.SEND_AS_DOCUMENT, false),
  // Оставлять ли оригинал HEIC рядом с JPEG-версией в режиме ленты
  keepHeicOriginal: bool(process.env.KEEP_HEIC_ORIGINAL, false),

  // none — всё в одну ленту; year — раскладывать по топикам-годам (нужна форум-супергруппа)
  topicMode: (process.env.TOPIC_MODE || 'none').toLowerCase(),

  // Какой формат считать главным, если рядом лежат IMG_0001.HEIC и IMG_0001.JPG
  // auto — jpeg в режиме ленты, original в режиме документов
  pairPrefer: (process.env.PAIR_PREFER || 'auto').toLowerCase(),
  // .MOV рядом с фото того же имени — это Live Photo:
  // live — отправить парой одним сообщением, skip — не отправлять, send — отдельным видео
  livePhotoVideos: (process.env.LIVE_PHOTO_VIDEOS || 'live').toLowerCase(),
  // Искать готовый хеш по имени+размеру+mtime — чтобы повторное подключение диска
  // с другой точкой монтирования не перечитывало весь диск заново
  fastRemountMatch: bool(process.env.FAST_REMOUNT_MATCH, true),
  // Проверять «то же имя + та же дата съёмки» по базе прошлых запусков
  crossRunNameCheck: bool(process.env.CROSS_RUN_NAME_CHECK, true),

  // Вид подписи под сообщением: pretty (по умолчанию) | plain | minimal
  captionStyle: (process.env.CAPTION_STYLE || 'pretty').toLowerCase(),

  // Кто может управлять ботом (id через запятую); свой id покажет команда /id
  adminIds: String(process.env.TELEGRAM_ADMIN_IDS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
  // Разрешить боту сканировать любые каталоги, а не только SCAN_PATHS и точки монтирования
  botAllowAnyPath: bool(process.env.BOT_ALLOW_ANY_PATH, false),

  sendDelayMs: int(process.env.SEND_DELAY_MS, 1200),
  maxAttempts: int(process.env.MAX_ATTEMPTS, 3),
};

// Bot API не принимает файлы больше 50 МБ (если не поднят локальный Bot API server).
export const BOT_UPLOAD_LIMIT = 50 * 1024 * 1024;
// MTProto: 2 ГБ для обычного аккаунта, 4 ГБ для Premium.
export const MTPROTO_UPLOAD_LIMIT = 2000 * 1024 * 1024;
// Telegram принимает как «фото» (с превью в ленте) файлы не больше 10 МБ.
export const PHOTO_LIMIT = 10 * 1024 * 1024;

/** Эффективный режим HEIC с учётом heicMode=auto. */
export function heicMode() {
  if (config.heicMode !== 'auto') return config.heicMode;
  if (config.sendAsDocument) return 'document';
  return config.keepHeicOriginal ? 'both' : 'convert';
}

/**
 * Что делать с видео Live Photo. В архивном режиме (документами) отправлять их
 * настоящим Live Photo незачем: Telegram такое сообщение пережимает, поэтому
 * оба файла уходят как есть.
 */
export function livePhotoMode() {
  if (config.livePhotoVideos === 'live' && config.sendAsDocument) return 'send';
  return config.livePhotoVideos;
}

/** Какой формат предпочесть в паре HEIC+JPG с учётом pairPrefer=auto. */
export function pairPrefer() {
  if (config.pairPrefer !== 'auto') return config.pairPrefer;
  return config.sendAsDocument ? 'original' : 'jpeg';
}

export function ensureDirs() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
}

export function assertChat() {
  if (!config.chatId) {
    throw new Error('Не задан TELEGRAM_CHAT_ID (см. .env.example)');
  }
}
