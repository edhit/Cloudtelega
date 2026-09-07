import fs from 'node:fs/promises';
import path from 'node:path';
import { isMedia, kindOf, extOf } from './media.js';

// Служебные каталоги, которые встречаются на USB-дисках и на iPhone.
const SKIP_DIRS = new Set([
  '.Trashes', '.Spotlight-V100', '.fseventsd', '.TemporaryItems', '.DocumentRevisions-V100',
  '$RECYCLE.BIN', 'System Volume Information', '.git', 'node_modules', '@eaDir', '.thumbnails',
  '.Trash', '.Trash-1000', 'lost+found',
]);

const SKIP_FILE_PREFIXES = ['._', '.DS_Store'];

function isSkippedName(name) {
  return SKIP_FILE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Рекурсивно обходит каталог и возвращает список медиафайлов.
 * @param {string} root
 * @param {{minSize?:number, since?:number, onProgress?:(n:number)=>void}} opts
 */
export async function scanDir(root, opts = {}) {
  const { minSize = 1, since = 0, onProgress } = opts;
  const results = [];
  const stack = [root];
  let seen = 0;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Нет прав / устройство отключилось — идём дальше, не роняем обход.
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile()) continue;
      if (isSkippedName(entry.name)) continue;
      if (!isMedia(entry.name)) continue;

      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.size < minSize) continue;
      const mtime = Math.floor(st.mtimeMs);
      if (since && mtime < since) continue;

      results.push({
        absPath: full,
        relPath: path.relative(root, full),
        name: entry.name,
        size: st.size,
        mtime,
        ext: extOf(entry.name),
        kind: kindOf(entry.name),
        root,
      });

      seen += 1;
      if (onProgress && seen % 200 === 0) onProgress(seen);
    }
  }

  return results;
}

/** Сканирует несколько корней и отдаёт единый список, отсортированный по дате съёмки (mtime). */
export async function scanAll(roots, opts = {}) {
  const all = [];
  for (const root of roots) {
    try {
      const st = await fs.stat(root);
      if (!st.isDirectory()) {
        continue;
      }
    } catch {
      throw new Error(`Каталог недоступен: ${root}`);
    }
    const files = await scanDir(root, opts);
    all.push(...files);
  }
  // «По порядку» = хронологически, от старых к новым.
  all.sort((a, b) => a.mtime - b.mtime || a.absPath.localeCompare(b.absPath));
  return all;
}

export function summarize(files) {
  const byExt = new Map();
  let bytes = 0;
  let photos = 0;
  let videos = 0;
  let big = 0;

  for (const f of files) {
    bytes += f.size;
    if (f.kind === 'video') videos += 1;
    else photos += 1;
    if (f.size > 50 * 1024 * 1024) big += 1;
    const cur = byExt.get(f.ext) ?? { n: 0, bytes: 0 };
    cur.n += 1;
    cur.bytes += f.size;
    byExt.set(f.ext, cur);
  }

  return {
    count: files.length,
    bytes,
    photos,
    videos,
    big,
    byExt: [...byExt.entries()].sort((a, b) => b[1].n - a[1].n),
  };
}
