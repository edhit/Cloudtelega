import fsp from 'node:fs/promises';
import path from 'node:path';
import { VIDEO_EXT, extOf } from './media.js';

// Секунды между 1904-01-01 (эпоха QuickTime/MP4) и 1970-01-01 (эпоха Unix).
const MP4_EPOCH_OFFSET = 2082844800;

const MIN_VALID = Date.UTC(1990, 0, 1);
const maxValid = () => Date.now() + 7 * 24 * 3600 * 1000;

const plausible = (ms) => Number.isFinite(ms) && ms > MIN_VALID && ms < maxValid();

/* ── EXIF (jpeg, heic, png, tiff, dng…) ──────────────────────────────────── */

async function fromExif(absPath) {
  try {
    const { default: exifr } = await import('exifr');
    const tags = await exifr.parse(absPath, {
      tiff: true,
      ifd0: true,
      exif: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Make', 'Model'],
      reviveValues: true,
    });
    if (!tags) return null;

    let takenAt = null;
    for (const key of ['DateTimeOriginal', 'CreateDate', 'ModifyDate']) {
      const v = tags[key];
      const ms = v instanceof Date ? v.getTime() : Date.parse(v ?? '');
      if (plausible(ms)) {
        takenAt = ms;
        break;
      }
    }
    return { takenAt, camera: cameraName(tags) };
  } catch {
    // Нет EXIF, битый файл, неподдерживаемый формат — не считаем ошибкой.
    return null;
  }
}

/** «Apple» + «iPhone 11 Pro» → «iPhone 11 Pro»; лишнее дублирование убираем. */
function cameraName(tags) {
  const make = String(tags.Make ?? '').trim();
  const model = String(tags.Model ?? '').trim();
  if (!model) return make || null;
  if (!make || model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return `${make} ${model}`;
}

/* ── MP4 / MOV: атом moov → mvhd → creation_time ─────────────────────────── */

async function readBox(fh, pos, limit) {
  const header = Buffer.alloc(16);
  const { bytesRead } = await fh.read(header, 0, 16, pos);
  if (bytesRead < 8) return null;

  let size = header.readUInt32BE(0);
  const type = header.toString('latin1', 4, 8);
  let headerSize = 8;

  if (size === 1) {
    if (bytesRead < 16) return null;
    size = Number(header.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - pos; // бокс до конца файла
  }
  if (size < headerSize || pos + size > limit) return null;
  return { type, size, headerSize, dataStart: pos + headerSize };
}

async function readMvhd(fh, start, end) {
  let pos = start;
  while (pos < end) {
    const box = await readBox(fh, pos, end);
    if (!box) return null;

    if (box.type === 'mvhd') {
      const buf = Buffer.alloc(24);
      await fh.read(buf, 0, 24, box.dataStart);
      const version = buf.readUInt8(0);
      const seconds = version === 1 ? Number(buf.readBigUInt64BE(4)) : buf.readUInt32BE(4);
      const ms = (seconds - MP4_EPOCH_OFFSET) * 1000;
      return plausible(ms) ? ms : null;
    }
    pos += box.size;
  }
  return null;
}

async function fromVideoAtoms(absPath) {
  let fh;
  try {
    fh = await fsp.open(absPath, 'r');
    const { size } = await fh.stat();
    let pos = 0;
    while (pos < size) {
      const box = await readBox(fh, pos, size);
      if (!box) break;
      if (box.type === 'moov') return await readMvhd(fh, box.dataStart, pos + box.size);
      pos += box.size;
    }
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
  return null;
}

/* ── Имя файла: IMG_20230715_123456, 2023-07-15 14.32.11, PXL_20230715… ──── */

const NAME_RE =
  /(?<y>19\d{2}|20\d{2})[-_.]?(?<mo>0[1-9]|1[0-2])[-_.]?(?<d>0[1-9]|[12]\d|3[01])(?:[-_.tT ]?(?<h>[01]\d|2[0-3])[-_.:]?(?<mi>[0-5]\d)(?:[-_.:]?(?<s>[0-5]\d))?)?/;

function fromFileName(name) {
  const m = NAME_RE.exec(path.basename(name));
  if (!m?.groups) return null;
  const g = m.groups;
  const ms = Date.UTC(
    Number(g.y),
    Number(g.mo) - 1,
    Number(g.d),
    Number(g.h ?? 12),
    Number(g.mi ?? 0),
    Number(g.s ?? 0),
  );
  return plausible(ms) ? ms : null;
}

/* ── Файловая система ────────────────────────────────────────────────────── */

function fromStat(stat) {
  const candidates = [stat.mtimeMs, stat.birthtimeMs].map(Math.floor).filter(plausible);
  // Копирование обычно сохраняет mtime, но не дату создания — берём более раннюю.
  return candidates.length ? Math.min(...candidates) : Math.floor(stat.mtimeMs);
}

/**
 * Дата съёмки файла: EXIF → атомы видео → имя файла → файловая система.
 * @returns {Promise<{takenAt:number, source:'exif'|'video'|'filename'|'fs'}>}
 */
export async function detectCaptureDate(absPath, stat) {
  const isVideo = VIDEO_EXT.has(extOf(absPath));
  let camera = null;

  if (!isVideo) {
    const exif = await fromExif(absPath);
    camera = exif?.camera ?? null;
    if (exif?.takenAt) return { takenAt: exif.takenAt, source: 'exif', camera };
  } else {
    const atom = await fromVideoAtoms(absPath);
    if (atom) return { takenAt: atom, source: 'video', camera };
  }

  const byName = fromFileName(absPath);
  if (byName) return { takenAt: byName, source: 'filename', camera };

  return { takenAt: fromStat(stat), source: 'fs', camera };
}

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const MONTHS_TAG = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/** «12 марта 2020, 23:16» */
export function formatDateHuman(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Хештег месяца: #март2020 */
export function monthTag(ms) {
  const d = new Date(ms);
  return `${MONTHS_TAG[d.getMonth()]}${d.getFullYear()}`;
}

export function yearOf(ms) {
  return String(new Date(ms).getFullYear());
}

/** Дата для подписи: 15.07.2023 14:32 (локальное время файла). */
export function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
