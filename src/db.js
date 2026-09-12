import { openDatabase } from './sqlite.js';
import { config, ensureDirs } from './config.js';
import { normalizeStem } from './naming.js';

let db;
let driver = null;

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
  file_id     TEXT,   -- переиспользуемый идентификатор Bot API
  file_unique_id TEXT,
  file_type   TEXT,   -- photo | video | document | live_photo | ...
  video_file_id  TEXT,-- видео Live Photo
  thumb_file_id  TEXT, -- миниатюра, которую хранит сам Telegram
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

-- Группы и каналы, где бот что-то видел. Раньше этот список жил только
-- в памяти и пропадал при каждом перезапуске: группа с готовым архивом
-- исчезала из выбора, и вернуть её было нечем — Telegram отдаёт чат только
-- вместе со свежим сообщением в нём, а прав администратора для этого мало.
CREATE TABLE IF NOT EXISTS seen_chats (
  id       TEXT PRIMARY KEY,
  title    TEXT,
  type     TEXT,
  is_forum INTEGER NOT NULL DEFAULT 0,
  seen_at  INTEGER NOT NULL
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

-- Ссылки-приглашения на диск: у каждой свой срок жизни и свой срок доступа
-- для тех, кто по ней вошёл.
CREATE TABLE IF NOT EXISTS invites (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT    NOT NULL,
  link         TEXT    NOT NULL UNIQUE,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,          -- когда ссылка перестаёт пускать (null — бессрочно)
  access_ms    INTEGER,          -- сколько держать доступ вошедшему (null — навсегда)
  member_limit INTEGER,
  join_request INTEGER NOT NULL DEFAULT 0,
  used         INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER
);

-- Кто вошёл по ссылке и до какого момента ему открыт доступ.
CREATE TABLE IF NOT EXISTS guests (
  id          INTEGER PRIMARY KEY,
  chat_id     TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  name        TEXT,
  username    TEXT,
  invite_link TEXT,
  invite_name TEXT,
  joined_at   INTEGER NOT NULL,
  expires_at  INTEGER,           -- когда выгонять (null — доступ бессрочный)
  removed_at  INTEGER,
  removed_why TEXT,              -- expired | manual | left
  UNIQUE (chat_id, user_id)
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
  add('files', 'file_id', 'TEXT');
  add('files', 'file_unique_id', 'TEXT');
  add('files', 'file_type', 'TEXT');
  add('files', 'video_file_id', 'TEXT');
  add('files', 'thumb_file_id', 'TEXT');
  add('hash_cache', 'name', 'TEXT');
  // bucket: photos — личный архив снимков, drive — файловый диск
  add('files', 'bucket', "TEXT NOT NULL DEFAULT 'photos'");
  // folder — папка диска, в которой лежит файл (пусто = корень)
  add('files', 'folder', 'TEXT');
  // bucket у темы: год снимков и папка диска живут в одной таблице, но это
  // разные вещи. Без пометки диск показывал годовые темы архива как свои
  // папки — пустые, потому что снимки лежат в другом bucket.
  add('topics', 'bucket', "TEXT NOT NULL DEFAULT 'photos'");
  // note — заметка к файлу. Живёт подписью в самом сообщении Telegram,
  // здесь лежит копия: чтобы показать её в списке, не спрашивая Telegram
  add('files', 'note', 'TEXT');

  // У тем, заведённых до появления этой пометки, bucket выставился в 'photos'
  // по умолчанию — вместе с папками диска. Год съёмки выглядит как «2026»,
  // всё остальное заводил диск: по этому и разбираем старые записи.
  const topicVersion = d.prepare('SELECT value FROM meta WHERE key = ?').get('topic_bucket')?.value;
  if (topicVersion !== '1') {
    d.prepare(`UPDATE topics SET bucket = 'drive' WHERE key NOT GLOB '[0-9][0-9][0-9][0-9]'`).run();
    d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('topic_bucket', '1');
  }

  // Пересчитываем stem_name: раньше суффикс _HEVC у видео Live Photo не отбрасывался,
  // из-за чего IMG_0373.jpg и IMG_0373_HEVC.MOV считались разными кадрами.
  const stemVersion = d.prepare('SELECT value FROM meta WHERE key = ?').get('stem_norm')?.value;
  if (stemVersion !== '2') {
    const rows = d.prepare('SELECT id, name FROM files').all();
    const update = d.prepare('UPDATE files SET stem_name = ? WHERE id = ?');
    for (const row of rows) update.run(normalizeStem(row.name), row.id);
    d.prepare(`INSERT INTO meta (key, value) VALUES ('stem_norm', '2')
               ON CONFLICT(key) DO UPDATE SET value = '2'`).run();
  }

  // Индексы создаём после ALTER TABLE — на базе от прошлой версии колонок ещё нет.
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_status   ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_abs_path ON files(abs_path);
    CREATE INDEX IF NOT EXISTS idx_files_name     ON files(name);
    CREATE INDEX IF NOT EXISTS idx_files_identity ON files(name, size);
    CREATE INDEX IF NOT EXISTS idx_files_stem     ON files(stem_name, taken_at);
    CREATE INDEX IF NOT EXISTS idx_hash_identity  ON hash_cache(name, size, mtime);
    CREATE INDEX IF NOT EXISTS idx_files_bucket   ON files(bucket, status);
    CREATE INDEX IF NOT EXISTS idx_files_folder   ON files(bucket, folder);
    CREATE INDEX IF NOT EXISTS idx_guests_expiry  ON guests(expires_at, removed_at);
  `);
}

export function openDb() {
  if (db) return db;
  ensureDirs();
  const opened = openDatabase(config.dbPath);
  db = opened.db;
  driver = opened.driver;
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Какой драйвер SQLite используется: node:sqlite или better-sqlite3. */
export function sqliteDriver() {
  openDb();
  return driver;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
    driver = null;
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
      `INSERT INTO files (sha256, name, abs_path, rel_path, size, mtime, taken_at, date_source, stem_key, stem_name, ext, kind, bucket, folder, status, created_at)
       VALUES (@sha256, @name, @absPath, @relPath, @size, @mtime, @takenAt, @dateSource, @stemKey, @stemName, @ext, @kind, @bucket, @folder, 'pending', @now)
       ON CONFLICT(sha256) DO UPDATE SET
         abs_path    = excluded.abs_path,
         rel_path    = excluded.rel_path,
         name        = excluded.name,
         taken_at    = excluded.taken_at,
         date_source = excluded.date_source,
         stem_key    = excluded.stem_key,
         stem_name   = excluded.stem_name,
         bucket      = excluded.bucket,
         folder      = excluded.folder`,
    )
    .run({
      sha256: file.sha256,
      name: file.name,
      absPath: file.absPath ?? null,
      relPath: file.relPath ?? null,
      size: file.size,
      mtime: file.mtime ?? null,
      takenAt: file.takenAt ?? null,
      dateSource: file.dateSource ?? null,
      stemKey: file.stemKey ?? null,
      stemName: file.stemName ?? null,
      ext: file.ext ?? null,
      kind: file.kind ?? null,
      bucket: file.bucket ?? 'photos',
      folder: file.folder ?? null,
      now,
    });
  return findByHash(file.sha256);
}

export function markSent(sha256, { method, chatId, topicId, messageId, fileId, fileUniqueId, fileType, videoFileId, thumbFileId }) {
  openDb()
    .prepare(
      `UPDATE files
          SET status = 'sent', method = ?, chat_id = ?, topic_id = ?, message_id = ?, sent_at = ?,
              file_id = ?, file_unique_id = ?, file_type = ?, video_file_id = ?, thumb_file_id = ?,
              last_error = NULL
        WHERE sha256 = ?`,
    )
    .run(
      method,
      String(chatId),
      topicId ?? null,
      messageId ?? null,
      Date.now(),
      fileId ?? null,
      fileUniqueId ?? null,
      fileType ?? null,
      videoFileId ?? null,
      thumbFileId ?? null,
      sha256,
    );
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
    byStatus: d.prepare(`SELECT status, COUNT(*) n, COALESCE(SUM(size), 0) bytes
                           FROM files WHERE bucket = 'photos' GROUP BY status`).all(),
    byMethod: d.prepare(`SELECT method, COUNT(*) n FROM files WHERE status = 'sent' GROUP BY method`).all(),
    byYear: d
      .prepare(
        `SELECT strftime('%Y', taken_at / 1000, 'unixepoch') year, COUNT(*) n, COALESCE(SUM(size), 0) bytes
           FROM files WHERE status = 'sent' AND taken_at IS NOT NULL GROUP BY year ORDER BY year`,
      )
      .all(),
    total: d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM files WHERE bucket = 'photos'`).get(),
  };
}

export function listFailed(limit = 50) {
  return openDb()
    .prepare(`SELECT * FROM files WHERE status = 'failed' ORDER BY attempts DESC, id ASC LIMIT ?`)
    .all(limit);
}

export function resetFailed() {
  const { changes } = openDb()
    .prepare(`UPDATE files SET status = 'pending', last_error = NULL WHERE status = 'failed'`)
    .run();
  return Number(changes);
}

/* ── выборки для бота ────────────────────────────────────────────────────── */

/** Поиск по имени и пути среди отправленного. */
export function searchSent(query, limit = 10) {
  const like = `%${String(query).trim().toLowerCase()}%`;
  return openDb()
    .prepare(
      `SELECT * FROM files
        WHERE status = 'sent' AND (lower(name) LIKE ? OR lower(rel_path) LIKE ? OR sha256 LIKE ?)
        ORDER BY taken_at DESC
        LIMIT ?`,
    )
    .all(like, like, `${String(query).trim().toLowerCase()}%`, limit);
}

/** Случайный отправленный файл — опционально за конкретный год. */
export function randomSent(year) {
  const d = openDb();
  if (year) {
    return (
      d
        .prepare(
          `SELECT * FROM files
            WHERE status = 'sent' AND strftime('%Y', taken_at / 1000, 'unixepoch') = ?
            ORDER BY RANDOM() LIMIT 1`,
        )
        .get(String(year)) ?? null
    );
  }
  return d.prepare(`SELECT * FROM files WHERE status = 'sent' ORDER BY RANDOM() LIMIT 1`).get() ?? null;
}

/** Последние отправленные файлы. */
export function lastSent(limit = 5) {
  return openDb()
    .prepare(`SELECT * FROM files WHERE status = 'sent' ORDER BY sent_at DESC LIMIT ?`)
    .all(limit);
}

/**
 * Видео Live Photo, которые ушли отдельным сообщением, хотя их кадр уже в архиве.
 * Совпадает нормализованное имя и дата съёмки, но сообщения разные.
 */
export function strayLiveVideos(limit = 500) {
  return openDb()
    .prepare(
      `SELECT v.id, v.sha256, v.name, v.rel_path, v.size, v.taken_at, v.chat_id, v.message_id,
              p.name AS photo_name, p.message_id AS photo_message_id
         FROM files v
         JOIN files p ON p.stem_name = v.stem_name
                     AND p.id <> v.id
                     AND p.status = 'sent'
                     AND p.kind = 'photo'
                     AND abs(COALESCE(p.taken_at, 0) - COALESCE(v.taken_at, 0)) <= 2000
        WHERE v.status = 'sent'
          AND v.kind = 'video'
          AND v.message_id IS NOT NULL
          AND (p.message_id IS NULL OR p.message_id <> v.message_id)
        ORDER BY v.taken_at
        LIMIT ?`,
    )
    .all(limit);
}

/**
 * Страница записей — база может быть на сотни тысяч файлов,
 * поэтому список отдаётся порциями, а не целиком.
 */
export function listFiles({ limit = 100, offset = 0, bucket = 'photos' } = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 100));
  const from = Math.max(0, Number(offset) || 0);
  return openDb()
    .prepare(
      `SELECT id, name, rel_path, size, kind, bucket, status, taken_at, sent_at, message_id, chat_id, topic_id,
              file_type, file_id, thumb_file_id, last_error
         FROM files WHERE bucket = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(bucket, size, from);
}

export function countFiles(bucket = 'photos') {
  return Number(openDb().prepare('SELECT COUNT(*) n FROM files WHERE bucket = ?').get(bucket)?.n ?? 0);
}

/**
 * Поиск по архиву с постраничной выдачей.
 * LIKE в SQLite различает регистр за пределами латиницы, поэтому ищем сразу
 * по нескольким написаниям запроса.
 */
// По чему можно сортировать. Список закрытый: имя столбца уходит в SQL,
// и подставлять туда что попало из запроса нельзя
const SORT_COLUMNS = {
  date: 'COALESCE(sent_at, taken_at, id)',
  name: 'name COLLATE NOCASE',
  size: 'size',
};

export function searchFiles({
  query = '', status = '', limit = 100, offset = 0, bucket = 'photos', folder = null,
  sort = 'date', dir = 'desc',
} = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 100));
  const from = Math.max(0, Number(offset) || 0);

  const where = ['bucket = ?'];
  const params = [bucket];

  const q = String(query).trim();
  if (q) {
    const variants = [...new Set([q, q.toLowerCase(), q.toUpperCase(), q[0].toUpperCase() + q.slice(1).toLowerCase()])];
    const clauses = variants.map(() => '(name LIKE ? OR rel_path LIKE ?)');
    where.push(`(${clauses.join(' OR ')})`);
    for (const v of variants) params.push(`%${v}%`, `%${v}%`);
  }

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  // folder === null — не фильтруем вовсе; '' — корень диска
  if (folder !== null && folder !== undefined) {
    if (folder === '') where.push("(folder IS NULL OR folder = '')");
    else {
      where.push('folder = ?');
      params.push(folder);
    }
  }

  const filter = `WHERE ${where.join(' AND ')}`;
  const d = openDb();
  const total = Number(d.prepare(`SELECT COUNT(*) n FROM files ${filter}`).get(...params)?.n ?? 0);
  const column = SORT_COLUMNS[sort] ?? SORT_COLUMNS.date;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const rows = d
    .prepare(
      `SELECT id, name, rel_path, size, kind, bucket, folder, note, status, method, taken_at, sent_at,
              message_id, chat_id, topic_id, file_type, file_id, thumb_file_id, last_error
         FROM files ${filter} ORDER BY ${column} ${order}, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, size, from);

  return { rows, total, offset: from, limit: size, sort, dir: order.toLowerCase() };
}

/** Сколько отправленного мы можем переиспользовать по file_id. */
export function fileIdCoverage() {
  return openDb()
    .prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN file_id IS NOT NULL THEN 1 ELSE 0 END) with_file_id
         FROM files WHERE status = 'sent'`,
    )
    .get();
}

/* ── топики ──────────────────────────────────────────────────────────────── */

export function getTopic(chatId, key) {
  return (
    openDb().prepare('SELECT topic_id FROM topics WHERE chat_id = ? AND key = ?').get(String(chatId), key)?.topic_id ??
    null
  );
}

export function putTopic(chatId, key, topicId, title, bucket = 'photos') {
  openDb()
    .prepare(
      `INSERT INTO topics (chat_id, key, topic_id, title, bucket) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, key) DO UPDATE SET
         topic_id = excluded.topic_id, title = excluded.title, bucket = excluded.bucket`,
    )
    .run(String(chatId), key, topicId, title ?? key, bucket);
}

/* ── чаты, которые программа когда-либо видела ───────────────────────────── */

/** Запоминает чат навсегда: список выбора не должен зависеть от перезапуска. */
export function putSeenChat({ id, title, type, isForum }) {
  if (!id) return;
  openDb()
    .prepare(
      `INSERT INTO seen_chats (id, title, type, is_forum, seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = COALESCE(excluded.title, seen_chats.title),
         type = COALESCE(excluded.type, seen_chats.type),
         is_forum = excluded.is_forum,
         seen_at = excluded.seen_at`,
    )
    .run(String(id), title ?? null, type ?? null, isForum ? 1 : 0, Date.now());
}

export function listSeenChats() {
  return openDb()
    .prepare('SELECT id, title, type, is_forum FROM seen_chats ORDER BY seen_at DESC')
    .all()
    .map((r) => ({ id: r.id, title: r.title || r.id, type: r.type || 'supergroup', isForum: Boolean(r.is_forum) }));
}

export function forgetSeenChat(id) {
  openDb().prepare('DELETE FROM seen_chats WHERE id = ?').run(String(id));
}

/** Обратный поиск: по номеру темы — её ключ, то есть путь папки. */
export function getTopicKey(chatId, topicId, bucket = 'drive') {
  return openDb()
    .prepare('SELECT key FROM topics WHERE chat_id = ? AND topic_id = ? AND bucket = ?')
    .get(String(chatId), Number(topicId), bucket)?.key ?? null;
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

/* ── диск: файлы отдельного «ведра» ──────────────────────────────────────── */

/** Сколько всего лежит на диске и какого объёма. */
export function driveStats(bucket = 'drive') {
  return openDb()
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) sent
         FROM files WHERE bucket = ?`,
    )
    .get(bucket);
}

/** Одна запись по id — для скачивания обратно и для ссылки на сообщение. */
export function fileById(id) {
  return openDb().prepare('SELECT * FROM files WHERE id = ?').get(Number(id)) ?? null;
}

/* ── ссылки-приглашения ──────────────────────────────────────────────────── */

export function addInvite({ chatId, link, name, expiresAt, accessMs, memberLimit, joinRequest }) {
  const now = Date.now();
  openDb()
    .prepare(
      `INSERT INTO invites (chat_id, link, name, created_at, expires_at, access_ms, member_limit, join_request)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(link) DO UPDATE SET
         name = excluded.name, expires_at = excluded.expires_at, access_ms = excluded.access_ms`,
    )
    .run(
      String(chatId), link, name ?? null, now,
      expiresAt ?? null, accessMs ?? null, memberLimit ?? null, joinRequest ? 1 : 0,
    );
  return getInvite(link);
}

export function getInvite(link) {
  return openDb().prepare('SELECT * FROM invites WHERE link = ?').get(link) ?? null;
}

export function listInvites({ chatId, includeRevoked = false } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (chatId) {
    where.push('chat_id = ?');
    params.push(String(chatId));
  }
  if (!includeRevoked) where.push('revoked_at IS NULL');
  return openDb()
    .prepare(`SELECT * FROM invites WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
    .all(...params);
}

export function markInviteRevoked(link) {
  openDb().prepare('UPDATE invites SET revoked_at = ? WHERE link = ?').run(Date.now(), link);
}

export function bumpInviteUsage(link) {
  openDb().prepare('UPDATE invites SET used = used + 1 WHERE link = ?').run(link);
}

/* ── гости: кто вошёл и до какого момента ────────────────────────────────── */

export function addGuest({ chatId, userId, name, username, inviteLink, inviteName, expiresAt }) {
  const now = Date.now();
  openDb()
    .prepare(
      `INSERT INTO guests (chat_id, user_id, name, username, invite_link, invite_name, joined_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET
         name = excluded.name, username = excluded.username,
         invite_link = excluded.invite_link, invite_name = excluded.invite_name,
         joined_at = excluded.joined_at, expires_at = excluded.expires_at,
         removed_at = NULL, removed_why = NULL`,
    )
    .run(String(chatId), String(userId), name ?? null, username ?? null,
         inviteLink ?? null, inviteName ?? null, now, expiresAt ?? null);
  return getGuest(chatId, userId);
}

export function getGuest(chatId, userId) {
  return openDb()
    .prepare('SELECT * FROM guests WHERE chat_id = ? AND user_id = ?')
    .get(String(chatId), String(userId)) ?? null;
}

export function listGuests({ chatId, includeRemoved = false } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (chatId) {
    where.push('chat_id = ?');
    params.push(String(chatId));
  }
  if (!includeRemoved) where.push('removed_at IS NULL');
  return openDb()
    .prepare(`SELECT * FROM guests WHERE ${where.join(' AND ')} ORDER BY joined_at DESC`)
    .all(...params);
}

/** Кому пора закрывать доступ: срок вышел, а из чата ещё не убрали. */
export function guestsToExpire(now = Date.now()) {
  return openDb()
    .prepare('SELECT * FROM guests WHERE removed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?')
    .all(now);
}

export function markGuestRemoved(chatId, userId, why = 'expired') {
  openDb()
    .prepare('UPDATE guests SET removed_at = ?, removed_why = ? WHERE chat_id = ? AND user_id = ?')
    .run(Date.now(), why, String(chatId), String(userId));
}

export function setGuestExpiry(chatId, userId, expiresAt) {
  openDb()
    .prepare('UPDATE guests SET expires_at = ? WHERE chat_id = ? AND user_id = ?')
    .run(expiresAt ?? null, String(chatId), String(userId));
  return getGuest(chatId, userId);
}

/* ── папки диска ─────────────────────────────────────────────────────────── */

/**
 * Все папки, о которых что-то известно: и те, где лежат файлы, и пустые,
 * заведённые вручную (о них помнит таблица topics). Путь папки хранится
 * целиком — «Договоры/2026/Аренда», — поэтому вложенность достаётся
 * разбором строки, без отдельной таблицы дерева.
 */
function knownFolderPaths(chatId, bucket) {
  const d = openDb();
  const known = new Map();

  for (const row of d
    .prepare(
      `SELECT folder AS path, COUNT(*) n, COALESCE(SUM(size), 0) bytes
         FROM files
        WHERE bucket = ? AND folder IS NOT NULL AND folder <> ''
        GROUP BY folder`,
    )
    .all(bucket)) {
    known.set(row.path, { path: row.path, n: row.n, bytes: row.bytes, topicId: null });
  }

  if (chatId) {
    const topics = d
      .prepare('SELECT key, topic_id FROM topics WHERE chat_id = ? AND bucket = ?')
      .all(String(chatId), bucket);
    for (const t of topics) {
      const entry = known.get(t.key) ?? { path: t.key, n: 0, bytes: 0, topicId: null };
      entry.topicId = t.topic_id;
      known.set(t.key, entry);
    }
    // Папка «Договоры/2026» означает, что есть и «Договоры», даже если
    // в ней самой ничего не лежит и темы под неё никто не заводил
    for (const path of [...known.keys()]) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const branch = parts.slice(0, i).join('/');
        if (!known.has(branch)) known.set(branch, { path: branch, n: 0, bytes: 0, topicId: null });
      }
    }
  }

  return known;
}

/**
 * Папки, лежащие непосредственно внутри `parent` (пусто — корень).
 * Счётчики суммируют всё, что внутри, вместе с вложенными папками:
 * человек ждёт от папки «Договоры» числа всех договоров, а не только тех,
 * что валяются прямо в ней.
 */
export function listDriveFolders(chatId, bucket = 'drive', parent = '') {
  const prefix = parent ? `${parent}/` : '';
  const children = new Map();

  for (const entry of knownFolderPaths(chatId, bucket).values()) {
    if (parent && !entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (!rest) continue;

    const name = rest.split('/')[0];
    const path = prefix + name;
    const child = children.get(path) ?? { name, path, n: 0, bytes: 0, topicId: null, folders: 0 };
    child.n += entry.n;
    child.bytes += entry.bytes;
    if (entry.path === path) child.topicId = entry.topicId;
    else child.folders += 1;
    children.set(path, child);
  }

  return [...children.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/**
 * Все папки хранилища разом, отсортированные по пути. Нужны окну «куда
 * переложить»: дерево там раскрывают и сворачивают, и тянуть каждый уровень
 * отдельным запросом было бы и медленно, и заметно глазу.
 */
export function listAllFolders(chatId, bucket = 'drive') {
  return [...knownFolderPaths(chatId, bucket).values()]
    .map((e) => ({
      path: e.path,
      name: e.path.split('/').at(-1),
      depth: e.path.split('/').length - 1,
      n: e.n,
      bytes: e.bytes,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, 'ru'));
}

/** Сколько файлов лежит прямо в этой папке (пусто — корень диска). */
export function driveRootCount(bucket = 'drive', folder = '') {
  const d = openDb();
  if (!folder) {
    return Number(
      d.prepare(`SELECT COUNT(*) n FROM files WHERE bucket = ? AND (folder IS NULL OR folder = '')`).get(bucket)?.n ?? 0,
    );
  }
  return Number(d.prepare('SELECT COUNT(*) n FROM files WHERE bucket = ? AND folder = ?').get(bucket, folder)?.n ?? 0);
}

/**
 * Забывает тему и всё, что в ней лежало. Возвращает удалённые записи —
 * по ним наверху стирают сами сообщения в Telegram.
 */
export function dropFolder(chatId, bucket, path) {
  const d = openDb();
  const like = `${path}/%`;
  const rows = d
    .prepare('SELECT id, name, chat_id, message_id, method FROM files WHERE bucket = ? AND (folder = ? OR folder LIKE ?)')
    .all(bucket, path, like);

  d.prepare('DELETE FROM files WHERE bucket = ? AND (folder = ? OR folder LIKE ?)').run(bucket, path, like);
  const topics = d
    .prepare('SELECT key, topic_id FROM topics WHERE chat_id = ? AND bucket = ? AND (key = ? OR key LIKE ?)')
    .all(String(chatId), bucket, path, like);
  d.prepare('DELETE FROM topics WHERE chat_id = ? AND bucket = ? AND (key = ? OR key LIKE ?)')
    .run(String(chatId), bucket, path, like);

  return { files: rows, topics };
}

/* ── общий список для совместной работы ──────────────────────────────────── */

// Поля, которыми участники обмениваются. Пути на компьютере сюда не входят
// намеренно: их незачем знать тем, кого пустили в чат
const SHARED_FIELDS = [
  'sha256', 'name', 'rel_path', 'size', 'mtime', 'taken_at', 'date_source',
  'stem_key', 'stem_name', 'ext', 'kind', 'bucket', 'folder', 'note',
  'status', 'method', 'chat_id', 'topic_id', 'message_id',
  'file_id', 'file_unique_id', 'file_type', 'video_file_id', 'thumb_file_id',
  'sent_at', 'created_at',
];

/** Записи одного хранилища — то, что уходит другим участникам. */
export function exportRows(bucket) {
  return openDb()
    .prepare(`SELECT ${SHARED_FIELDS.join(', ')} FROM files WHERE bucket = ? AND status = 'sent' ORDER BY id`)
    .all(bucket);
}

/**
 * Подмешивает чужие записи. Только добавляет: у чего отпечаток уже известен,
 * то остаётся как есть — так у слияния нет проигравших.
 * @returns {number} сколько записей добавилось
 */
export function importRows(rows, bucket) {
  const d = openDb();
  const insert = d.prepare(
    `INSERT OR IGNORE INTO files (${SHARED_FIELDS.join(', ')})
     VALUES (${SHARED_FIELDS.map((f) => `@${f}`).join(', ')})`,
  );

  let added = 0;
  d.exec('BEGIN');
  try {
    for (const row of rows) {
      if (!row?.sha256 || row.bucket !== bucket) continue;
      const values = {};
      for (const field of SHARED_FIELDS) values[field] = row[field] ?? null;
      values.bucket = bucket;
      values.created_at = Number(row.created_at) || Date.now();
      values.size = Number(row.size) || 0;
      added += insert.run(values).changes;
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return added;
}

/** Заметка к файлу — та же подпись, что стоит под ним в Telegram. */
export function setFileNote(id, note) {
  openDb().prepare('UPDATE files SET note = ? WHERE id = ?').run(note || null, Number(id));
  return fileById(id);
}

/** Переложить файл в другую папку (в самом Telegram сообщение не двигается). */
export function setFileFolder(id, folder) {
  openDb().prepare('UPDATE files SET folder = ? WHERE id = ?').run(folder || null, Number(id));
  return fileById(id);
}
