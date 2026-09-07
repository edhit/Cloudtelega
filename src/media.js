import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { sha256Buffer } from './hash.js';

export const PHOTO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff',
  '.heic', '.heif', '.avif', '.dng', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2',
]);

export const VIDEO_EXT = new Set([
  '.mov', '.mp4', '.m4v', '.avi', '.mkv', '.3gp', '.mpg', '.mpeg', '.wmv', '.webm', '.hevc', '.mts',
]);

export const HEIC_EXT = new Set(['.heic', '.heif']);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.dng': 'image/x-adobe-dng',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp', '.webm': 'video/webm', '.mts': 'video/mp2t',
};

export const extOf = (p) => path.extname(p).toLowerCase();

export function isMedia(p) {
  const e = extOf(p);
  return PHOTO_EXT.has(e) || VIDEO_EXT.has(e);
}

export function kindOf(p) {
  const e = extOf(p);
  if (VIDEO_EXT.has(e)) return 'video';
  if (PHOTO_EXT.has(e)) return 'photo';
  return 'other';
}

export function isHeic(p) {
  return HEIC_EXT.has(extOf(p));
}

export function mimeOf(p) {
  return MIME[extOf(p)] ?? 'application/octet-stream';
}

/**
 * Конвертирует HEIC/HEIF в JPEG. Возвращает { path, size, sha256, name } временного файла.
 * heic-convert — чистый JS, никаких системных зависимостей.
 */
export async function convertHeicToJpeg(absPath) {
  const { default: convert } = await import('heic-convert');
  const input = await fs.readFile(absPath);
  const output = await convert({
    buffer: input,
    format: 'JPEG',
    quality: Math.max(1, Math.min(100, config.heicQuality)) / 100,
  });
  const buf = Buffer.from(output);
  const name = `${path.basename(absPath, path.extname(absPath))}.jpg`;
  const outPath = path.join(config.tmpDir, `${Date.now()}-${name}`);
  await fs.writeFile(outPath, buf);
  return { path: outPath, size: buf.length, sha256: sha256Buffer(buf), name };
}

export async function safeUnlink(p) {
  try {
    await fs.unlink(p);
  } catch {
    /* игнорируем */
  }
}
