import Database from 'better-sqlite3';
import { config, ensureDirs } from './config.js';

let db;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  abs_path    TEXT,
  rel_path    TEXT,
  size        INTEGER NOT NULL,
  mtime       INTEGER,
  taken_at    INTEGER,
  date_source TEXT,
  stem_key    TEXT,
  stem_name   TEXT,
  ext         TEXT,
  kind        TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  method      TEXT,                                -- bot | mtproto
  chat_id     TEXT,
  topic_id    INTEGER,
  message_id  INTEGER,
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);

-- Кэш хешей, чтобы не пересчитывать sha256 при каждом запуске.
CREATE TABLE IF NOT EXISTS hash_cache (
  abs_path TEXT PRIMARY KEY,
  name     TEXT,
  size     INTEGER NOT NULL,
  mtime    INTEGER NOT NULL,
  sha256   TEXT    NOT NULL
);

-- Топики форум-супергруппы: год -> message_thread_id
CREATE TABLE IF NOT EXISTS topics (
  chat_id  TEXT    NOT NULL,
  key      TEXT    NOT NULL,
  topic_id INTEGER NOT NULL,
  title    TEXT,
  PRIMARY KEY (chat_id, key)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/** Досоздаёт колонки в базах, созданных предыдущими версиями. */
function migrate(d) {
  const add = (table, column, decl) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };
  add('files', 'taken_at', 'INTEGER');
  add('files', 'date_source', 'TEXT');
  add('files', 'stem_key', 'TEXT');
  add('files', 'stem_name', 'TEXT');
  add('files', 'topic_id', 'INTEGER');
  add('hash_cache', 'name', 'TEXT');

  // Индексы создаём после ALTER TABLE — на базе от прошлой версии колонок ещё нет.
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_status   ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_abs_path ON files(abs_path);
    CREATE INDEX IF NOT EXISTS idx_files_name     ON files(name);
    CREATE INDEX IF NOT EXISTS idx_files_identity ON files(name, size);
    CREATE INDEX IF NOT EXISTS idx_files_stem     ON files(stem_name, taken_at);
    CREATE INDEX IF NOT EXISTS idx_hash_identity  ON hash_cache(name, size, mtime);
  `);
}

export function openDb() {
  if (db) return db;
  ensureDirs();
  db = new Database(config.dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

/* ── хеш-кэш ─────────────────────────────────────────────────────────────── */

/**
 * Ищет готовый sha256. Сначала по точному пути, затем по «личности» файла
 * (имя + размер + mtime) — это важно при повторном подключении диска,
 * когда точка монтирования меняется (/Volumes/USB → /Volumes/USB-1).
 */
export function getCachedHash(absPath, size, mtime, name) {
  const d = openDb();
  const byPath = d
    .prepare('SELECT sha256 FROM hash_cache WHERE abs_path = ? AND size = ? AND mtime = ?')
    .get(absPath, size, mtime);
  if (byPath) return byPath.sha256;

  if (config.fastRemountMatch && name) {
    const byIdentity = d
      .prepare('SELECT sha256 FROM hash_cache WHERE name = ? AND size = ? AND mtime = ? LIMIT 1')
      .get(name, size, mtime);
    if (byIdentity) return byIdentity.sha256;
  }
  return null;
}

export function putCachedHash(absPath, size, mtime, sha256, name) {
  openDb()
    .prepare(
      `INSERT INTO hash_cache (abs_path, name, size, mtime, sha256) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(abs_path) DO UPDATE SET
         name = excluded.name, size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256`,
    )
    .run(absPath, name ?? null, size, mtime, sha256);
}

/* ── файлы ───────────────────────────────────────────────────────────────── */

export function findByHash(sha256) {
  return openDb().prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256) ?? null;
}

/**
 * Тот же снимок в другом формате, отправленный в один из прошлых запусков:
 * совпадает имя без расширения И дата съёмки (с допуском в пару секунд).
 * Одного имени мало — на разных устройствах имена вроде IMG_0001 повторяются.
 */
export function findSentByStemName(stemName, takenAt, toleranceMs = 2000) {
  if (!stemName || !takenAt) return null;
  return (
    openDb()
      .prepare(
        `SELECT * FROM files
          WHERE status = 'sent' AND stem_name = ? AND taken_at BETWEEN ? AND ?
          LIMIT 1`,
      )
      .get(stemName.toLowerCase(), takenAt - toleranceMs, takenAt + toleranceMs) ?? null
  );
}

export function upsertPending(file) {
  const now = Date.now();
  openDb()
    .prepare(
      `INSERT INTO files (sha256, name, abs_path, rel_path, size, mtime, taken_at, date_source, stem_key, stem_name, ext, kind, status, created_at)
       VALUES (@sha256, @name, @absPath, @relPath, @size, @mtime, @takenAt, @dateSource, @stemKey, @stemName, @ext, @kind, 'pending', @now)
       ON CONFLICT(sha256) DO UPDATE SET
         abs_path    = excluded.abs_path,
         rel_path    = excluded.rel_path,
         name        = excluded.name,
         taken_at    = excluded.taken_at,
         date_source = excluded.date_source,
         stem_key    = excluded.stem_key,
         stem_name   = excluded.stem_name`,
    )
    .run({ ...file, now });
  return findByHash(file.sha256);
}

export function markSent(sha256, { method, chatId, topicId, messageId }) {
  openDb()
    .prepare(
      `UPDATE files
          SET status = 'sent', method = ?, chat_id = ?, topic_id = ?, message_id = ?, sent_at = ?, last_error = NULL
        WHERE sha256 = ?`,
    )
    .run(method, String(chatId), topicId ?? null, messageId ?? null, Date.now(), sha256);
}

export function markFailed(sha256, error) {
  openDb()
    .prepare(`UPDATE files SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE sha256 = ?`)
    .run(String(error).slice(0, 1000), sha256);
}

export function markSkipped(sha256, reason) {
  openDb()
    .prepare(`UPDATE files SET status = 'skipped', last_error = ? WHERE sha256 = ?`)
    .run(String(reason).slice(0, 1000), sha256);
}

export function stats() {
  const d = openDb();
  return {
    byStatus: d.prepare('SELECT status, COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM files GROUP BY status').all(),
    byMethod: d.prepare(`SELECT method, COUNT(*) n FROM files WHERE status = 'sent' GROUP BY method`).all(),
    byYear: d
      .prepare(
        `SELECT strftime('%Y', taken_at / 1000, 'unixepoch') year, COUNT(*) n, COALESCE(SUM(size), 0) bytes
           FROM files WHERE status = 'sent' AND taken_at IS NOT NULL GROUP BY year ORDER BY year`,
      )
      .all(),
    total: d.prepare('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM files').get(),
  };
}

export function listFailed(limit = 50) {
  return openDb()
    .prepare(`SELECT * FROM files WHERE status = 'failed' ORDER BY attempts DESC, id ASC LIMIT ?`)
    .all(limit);
}

export function resetFailed() {
  return openDb().prepare(`UPDATE files SET status = 'pending', last_error = NULL WHERE status = 'failed'`).run().changes;
}

/* ── топики ──────────────────────────────────────────────────────────────── */

export function getTopic(chatId, key) {
  return (
    openDb().prepare('SELECT topic_id FROM topics WHERE chat_id = ? AND key = ?').get(String(chatId), key)?.topic_id ??
    null
  );
}

export function putTopic(chatId, key, topicId, title) {
  openDb()
    .prepare(
      `INSERT INTO topics (chat_id, key, topic_id, title) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, key) DO UPDATE SET topic_id = excluded.topic_id, title = excluded.title`,
    )
    .run(String(chatId), key, topicId, title ?? key);
}

export function listTopics(chatId) {
  return openDb().prepare('SELECT key, topic_id, title FROM topics WHERE chat_id = ? ORDER BY key').all(String(chatId));
}

/* ── meta ────────────────────────────────────────────────────────────────── */

export function getMeta(key) {
  return openDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(key, value) {
  openDb()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, String(value));
}
