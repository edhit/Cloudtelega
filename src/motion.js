import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Motion Photo — это обычный JPEG, к которому в хвост дописан MP4.
// Так снимают Pixel («Движение»), Samsung («Живое фото») и другие Android-камеры.
const HINTS = [
  'GCamera:MotionPhoto',
  'MotionPhotoVersion',
  'MicroVideoOffset',
  'MotionPhoto_Data',
  'Item:Mime="video/mp4"',
  'Item:Mime="video/quicktime"',
];

const HEAD_BYTES = 256 * 1024;
const MAX_FILE = 64 * 1024 * 1024;

/** Быстрая проверка по началу файла: есть ли вообще смысл читать его целиком. */
async function hasMotionHint(absPath) {
  let fh;
  try {
    fh = await fs.open(absPath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString('latin1');
    return HINTS.some((hint) => head.includes(hint));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/** Смещение видео из XMP: MicroVideoOffset считается от конца файла. */
function offsetFromXmp(text, fileLength) {
  const micro = /GCamera:MicroVideoOffset\s*=\s*"(\d+)"/.exec(text)?.[1];
  if (micro) {
    const start = fileLength - Number(micro);
    if (start > 0 && start < fileLength) return start;
  }
  // Motion Photo v1: длина видео указана в Container:Directory
  const length = /Item:Mime="video\/(?:mp4|quicktime)"[^>]*Item:Length="(\d+)"/.exec(text)?.[1]
    ?? /Item:Length="(\d+)"[^>]*Item:Mime="video\/(?:mp4|quicktime)"/.exec(text)?.[1];
  if (length) {
    const start = fileLength - Number(length);
    if (start > 0 && start < fileLength) return start;
  }
  return null;
}

/** Начало MP4 ищем по боксу ftyp после конца картинки (маркер FFD9). */
function findMp4Start(buffer) {
  const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]));
  const from = eoi === -1 ? 0 : eoi + 2;

  let at = buffer.indexOf('ftyp', from, 'latin1');
  while (at !== -1) {
    const boxStart = at - 4;
    if (boxStart >= from) {
      const size = buffer.readUInt32BE(boxStart);
      // Разумный размер бокса — признак настоящего заголовка, а не совпадения байтов
      if (size >= 8 && size <= buffer.length - boxStart) return boxStart;
    }
    at = buffer.indexOf('ftyp', at + 4, 'latin1');
  }
  return null;
}

/**
 * Разбирает Motion Photo на кадр и видео.
 * @returns {Promise<null|{still:{path:string,size:number,name:string}, video:{path:string,size:number,name:string}}>}
 */
export async function splitMotionPhoto(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!['.jpg', '.jpeg'].includes(ext)) return null;

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (stat.size > MAX_FILE) return null;
  if (!(await hasMotionHint(absPath))) return null;

  const buffer = await fs.readFile(absPath);
  const text = buffer.subarray(0, Math.min(HEAD_BYTES, buffer.length)).toString('latin1');

  let start = offsetFromXmp(text, buffer.length);
  // Проверяем, что по заявленному смещению действительно начинается MP4
  if (start !== null && buffer.subarray(start + 4, start + 8).toString('latin1') !== 'ftyp') start = null;
  start ??= findMp4Start(buffer);
  if (start === null || start < 1024) return null;

  const base = path.basename(absPath, ext);
  const stamp = Date.now();
  const stillPath = path.join(config.tmpDir, `${stamp}-${base}.jpg`);
  const videoPath = path.join(config.tmpDir, `${stamp}-${base}.mp4`);

  await fs.writeFile(stillPath, buffer.subarray(0, start));
  await fs.writeFile(videoPath, buffer.subarray(start));

  return {
    still: { path: stillPath, size: start, name: `${base}.jpg` },
    video: { path: videoPath, size: buffer.length - start, name: `${base}.mp4` },
  };
}
