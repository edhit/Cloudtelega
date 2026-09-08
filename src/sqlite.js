import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let warningsPatched = false;

/** Гасит ExperimentalWarning про node:sqlite, остальные предупреждения оставляет. */
function silenceSqliteWarning() {
  if (warningsPatched) return;
  warningsPatched = true;
  const defaults = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    for (const fn of defaults) fn(w);
  });
}

function loadNodeSqlite() {
  try {
    silenceSqliteWarning();
    return require('node:sqlite').DatabaseSync;
  } catch {
    // Node старее 22.5 или сборка без node:sqlite
    return null;
  }
}

function loadBetterSqlite() {
  try {
    return require('better-sqlite3');
  } catch {
    // Пакет не установлен — это нормально, он не в зависимостях
    return null;
  }
}

/**
 * Открывает базу. По умолчанию — встроенный в Node модуль `node:sqlite`
 * (никакой нативной сборки, ничего компилировать не нужно).
 * Если он недоступен, используется better-sqlite3, когда тот установлен вручную.
 * Переопределить выбор: CLOUDTELEGA_SQLITE=node|better
 */
export function openDatabase(filePath) {
  const forced = (process.env.CLOUDTELEGA_SQLITE || '').toLowerCase();

  if (forced !== 'better') {
    const DatabaseSync = loadNodeSqlite();
    if (DatabaseSync) return { db: new DatabaseSync(filePath), driver: 'node:sqlite' };
    if (forced === 'node') {
      throw new Error('node:sqlite недоступен в этой версии Node. Нужен Node 22.5+ (лучше 24).');
    }
  }

  const Database = loadBetterSqlite();
  if (Database) return { db: new Database(filePath), driver: 'better-sqlite3' };

  throw new Error(
    'Нет доступного SQLite. Обновите Node до 22.5+ (в нём есть встроенный node:sqlite) ' +
      'или установите пакет better-sqlite3: npm i better-sqlite3',
  );
}
