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

  heicMode: (process.env.HEIC_MODE || 'document').toLowerCase(),
  heicQuality: int(process.env.HEIC_JPEG_QUALITY, 92),
  sendAsDocument: bool(process.env.SEND_AS_DOCUMENT, true),

  sendDelayMs: int(process.env.SEND_DELAY_MS, 1200),
  maxAttempts: int(process.env.MAX_ATTEMPTS, 3),
};

// Bot API не принимает файлы больше 50 МБ (если не поднят локальный Bot API server).
export const BOT_UPLOAD_LIMIT = 50 * 1024 * 1024;
// MTProto: 2 ГБ для обычного аккаунта, 4 ГБ для Premium.
export const MTPROTO_UPLOAD_LIMIT = 2000 * 1024 * 1024;

export function ensureDirs() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
}

export function assertChat() {
  if (!config.chatId) {
    throw new Error('Не задан TELEGRAM_CHAT_ID (см. .env.example)');
  }
}
