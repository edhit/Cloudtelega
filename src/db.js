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
  ext         TEXT,
  kind        TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  method      TEXT,                                -- bot | mtproto
  chat_id     TEXT,
  message_id  INTEGER,
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_status   ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_abs_path ON files(abs_path);
CREATE INDEX IF NOT EXISTS idx_files_name     ON files(name);

-- Кэш хешей, чтобы не пересчитывать sha256 при каждом запуске.
CREATE TABLE IF NOT EXISTS hash_cache (
  abs_path TEXT PRIMARY KEY,
  size     INTEGER NOT NULL,
  mtime    INTEGER NOT NULL,
  sha256   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb() {
  if (db) return db;
  ensureDirs();
  db = new Database(config.dbPath);
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

/* ── хеш-кэш ─────────────────────────────────────────────────────────────── */

export function getCachedHash(absPath, size, mtime) {
  const row = openDb()
    .prepare('SELECT sha256 FROM hash_cache WHERE abs_path = ? AND size = ? AND mtime = ?')
    .get(absPath, size, mtime);
  return row?.sha256 ?? null;
}

export function putCachedHash(absPath, size, mtime, sha256) {
  openDb()
    .prepare(
      `INSERT INTO hash_cache (abs_path, size, mtime, sha256) VALUES (?, ?, ?, ?)
       ON CONFLICT(abs_path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256`,
    )
    .run(absPath, size, mtime, sha256);
}

/* ── файлы ───────────────────────────────────────────────────────────────── */

export function findByHash(sha256) {
  return openDb().prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256) ?? null;
}

export function upsertPending(file) {
  const now = Date.now();
  openDb()
    .prepare(
      `INSERT INTO files (sha256, name, abs_path, rel_path, size, mtime, ext, kind, status, created_at)
       VALUES (@sha256, @name, @absPath, @relPath, @size, @mtime, @ext, @kind, 'pending', @now)
       ON CONFLICT(sha256) DO UPDATE SET
         abs_path = excluded.abs_path,
         rel_path = excluded.rel_path,
         name     = excluded.name`,
    )
    .run({ ...file, now });
  return findByHash(file.sha256);
}

export function markSent(sha256, { method, chatId, messageId }) {
  openDb()
    .prepare(
      `UPDATE files
          SET status = 'sent', method = ?, chat_id = ?, message_id = ?, sent_at = ?, last_error = NULL
        WHERE sha256 = ?`,
    )
    .run(method, String(chatId), messageId ?? null, Date.now(), sha256);
}

export function markFailed(sha256, error) {
  openDb()
    .prepare(
      `UPDATE files
          SET status = 'failed', attempts = attempts + 1, last_error = ?
        WHERE sha256 = ?`,
    )
    .run(String(error).slice(0, 1000), sha256);
}

export function markSkipped(sha256, reason) {
  openDb()
    .prepare(`UPDATE files SET status = 'skipped', last_error = ? WHERE sha256 = ?`)
    .run(String(reason).slice(0, 1000), sha256);
}

export function stats() {
  const d = openDb();
  const byStatus = d.prepare('SELECT status, COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM files GROUP BY status').all();
  const byMethod = d.prepare(`SELECT method, COUNT(*) n FROM files WHERE status = 'sent' GROUP BY method`).all();
  const total = d.prepare('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM files').get();
  return { byStatus, byMethod, total };
}

export function listFailed(limit = 50) {
  return openDb()
    .prepare(`SELECT * FROM files WHERE status = 'failed' ORDER BY attempts DESC, id ASC LIMIT ?`)
    .all(limit);
}

export function resetFailed() {
  return openDb().prepare(`UPDATE files SET status = 'pending', last_error = NULL WHERE status = 'failed'`).run().changes;
}

export function getMeta(key) {
  return openDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(key, value) {
  openDb()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, String(value));
}
