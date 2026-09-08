import fs from 'node:fs/promises';
import path from 'node:path';
import { isMedia, kindOf, extOf, PHOTO_EXT, VIDEO_EXT } from './media.js';
import { detectCaptureDate } from './dates.js';
import { normalizeStem } from './naming.js';

// Служебные каталоги, которые встречаются на USB-дисках и на iPhone.
const SKIP_DIRS = new Set([
  '.Trashes', '.Spotlight-V100', '.fseventsd', '.TemporaryItems', '.DocumentRevisions-V100',
  '$RECYCLE.BIN', 'System Volume Information', '.git', 'node_modules', '@eaDir', '.thumbnails',
  '.Trash', '.Trash-1000', 'lost+found',
]);

const SKIP_FILE_PREFIXES = ['._', '.DS_Store'];

// Чем «оригинальнее» формат, тем раньше он в списке.
const PREFER_ORIGINAL = ['.dng', '.cr3', '.cr2', '.nef', '.arw', '.orf', '.rw2', '.raw',
  '.heic', '.heif', '.tif', '.tiff', '.png', '.webp', '.avif', '.jpg', '.jpeg', '.gif', '.bmp'];
// Чем удобнее для ленты (не требует конвертации), тем раньше.
const PREFER_JPEG = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff',
  '.dng', '.cr3', '.cr2', '.nef', '.arw', '.orf', '.rw2', '.raw', '.gif', '.bmp'];
const PREFER_VIDEO = ['.mov', '.mp4', '.m4v', '.hevc', '.mkv', '.avi', '.webm', '.mpg', '.mpeg', '.3gp', '.mts', '.wmv'];

function isSkippedName(name) {
  return SKIP_FILE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Ключ группировки «это один и тот же кадр»: каталог + имя без расширения.
 * Служебный суффикс видео Live Photo отбрасывается, поэтому
 * IMG_0373.jpg и IMG_0373_HEVC.MOV попадают в одну группу.
 */
export function stemKey(absPath) {
  return `${path.dirname(absPath)}::${normalizeStem(path.basename(absPath))}`;
}

/** Рекурсивный обход каталога: только медиафайлы, со stat. */
export async function scanDir(root, opts = {}) {
  const { minSize = 1, onProgress } = opts;
  const results = [];
  const stack = [root];
  let seen = 0;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
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
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (isSkippedName(entry.name) || !isMedia(entry.name)) continue;

      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.size < minSize) continue;

      results.push({
        absPath: full,
        relPath: path.relative(root, full),
        name: entry.name,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        ext: extOf(entry.name),
        kind: kindOf(entry.name),
        stemKey: stemKey(full),
        stat: st,
        root,
      });

      seen += 1;
      if (onProgress && seen % 200 === 0) onProgress(seen);
    }
  }

  return results;
}

/** Определяет дату съёмки каждого файла (EXIF / атомы видео / имя / файловая система). */
export async function enrichWithDates(files, onProgress) {
  let done = 0;
  for (const f of files) {
    const { takenAt, source, camera } = await detectCaptureDate(f.absPath, f.stat);
    f.takenAt = takenAt;
    f.dateSource = source;
    f.camera = camera ?? null;
    delete f.stat;
    done += 1;
    if (onProgress && done % 100 === 0) onProgress(done, files.length);
  }
  return files;
}

function pickBest(candidates, order) {
  return [...candidates].sort((a, b) => {
    const ia = order.indexOf(a.ext);
    const ib = order.indexOf(b.ext);
    const ra = ia === -1 ? order.length : ia;
    const rb = ib === -1 ? order.length : ib;
    if (ra !== rb) return ra - rb;
    return b.size - a.size; // при равном приоритете берём более «полный» файл
  })[0];
}

// Видео Live Photo длится пару секунд; всё, что заметно больше, — самостоятельный ролик.
const LIVE_PHOTO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Схлопывает файлы с одинаковым именем в одном каталоге (IMG_0001.HEIC + IMG_0001.JPG).
 * @param {object[]} files
 * @param {{prefer:'original'|'jpeg', livePhotoVideos:'live'|'skip'|'send'}} opts
 * @returns {{files:object[], dropped:{file:object, reason:string}[]}}
 */
export function collapseDuplicatesByName(files, opts) {
  const { prefer = 'original', livePhotoVideos = 'live' } = opts ?? {};
  const photoOrder = prefer === 'jpeg' ? PREFER_JPEG : PREFER_ORIGINAL;

  const groups = new Map();
  for (const f of files) {
    const g = groups.get(f.stemKey) ?? [];
    g.push(f);
    groups.set(f.stemKey, g);
  }

  const kept = [];
  const dropped = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }

    const photos = group.filter((f) => PHOTO_EXT.has(f.ext));
    const videos = group.filter((f) => VIDEO_EXT.has(f.ext));

    let bestPhoto = null;
    if (photos.length) {
      bestPhoto = pickBest(photos, photoOrder);
      kept.push(bestPhoto);
      for (const f of photos) {
        if (f !== bestPhoto) dropped.push({ file: f, reason: `то же фото, что ${bestPhoto.name}` });
      }
    }

    if (videos.length) {
      const bestVideo = pickBest(videos, PREFER_VIDEO);
      const isLivePhoto = Boolean(bestPhoto) && bestVideo.size <= LIVE_PHOTO_MAX_BYTES;

      if (isLivePhoto && livePhotoVideos === 'live') {
        // .MOV рядом с фото того же имени — это Live Photo: отправим их одним сообщением.
        bestPhoto.livePhoto = bestVideo;
        for (const f of videos) {
          if (f !== bestVideo) dropped.push({ file: f, reason: `то же видео, что ${bestVideo.name}` });
        }
      } else if (isLivePhoto && livePhotoVideos === 'skip') {
        for (const f of videos) dropped.push({ file: f, reason: `Live Photo к ${bestPhoto.name}` });
      } else {
        kept.push(bestVideo);
        for (const f of videos) {
          if (f !== bestVideo) dropped.push({ file: f, reason: `то же видео, что ${bestVideo.name}` });
        }
      }
    }
  }

  return { files: kept, dropped };
}

/** Сканирует несколько корней, проставляет даты, схлопывает дубликаты и сортирует по дате съёмки. */
export async function scanAll(roots, opts = {}) {
  const { since = 0, onDateProgress, prefer, livePhotoVideos } = opts;
  const all = [];

  for (const root of roots) {
    try {
      const st = await fs.stat(root);
      if (!st.isDirectory()) continue;
    } catch {
      throw new Error(`Каталог недоступен: ${root}`);
    }
    all.push(...(await scanDir(root, opts)));
  }

  await enrichWithDates(all, onDateProgress);

  const filtered = since ? all.filter((f) => f.takenAt >= since) : all;
  const { files, dropped } = collapseDuplicatesByName(filtered, { prefer, livePhotoVideos });

  // «По порядку» = по дате съёмки, от старых к новым.
  files.sort((a, b) => a.takenAt - b.takenAt || a.absPath.localeCompare(b.absPath));
  return { files, dropped };
}

export function summarize(files) {
  const byExt = new Map();
  const byYear = new Map();
  const bySource = new Map();
  let bytes = 0;
  let photos = 0;
  let videos = 0;
  let big = 0;
  let livePhotos = 0;

  for (const f of files) {
    bytes += f.size;
    if (f.livePhoto) {
      livePhotos += 1;
      bytes += f.livePhoto.size;
    }
    if (f.kind === 'video') videos += 1;
    else photos += 1;
    if (f.size > 50 * 1024 * 1024) big += 1;

    const ext = byExt.get(f.ext) ?? { n: 0, bytes: 0 };
    ext.n += 1;
    ext.bytes += f.size;
    byExt.set(f.ext, ext);

    const year = String(new Date(f.takenAt ?? f.mtime).getFullYear());
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
    bySource.set(f.dateSource ?? 'fs', (bySource.get(f.dateSource ?? 'fs') ?? 0) + 1);
  }

  return {
    count: files.length,
    bytes,
    photos,
    videos,
    big,
    livePhotos,
    byExt: [...byExt.entries()].sort((a, b) => b[1].n - a[1].n),
    byYear: [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    bySource: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
  };
}
