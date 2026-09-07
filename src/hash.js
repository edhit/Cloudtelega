import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { getCachedHash, putCachedHash } from './db.js';

/** Полный sha256 по содержимому файла (потоково, без чтения целиком в память). */
export async function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(absPath, { highWaterMark: 1024 * 1024 }), hash);
  return hash.digest('hex');
}

/**
 * sha256 с кэшем по (путь, размер, mtime) и по «личности» файла (имя, размер, mtime).
 * Второе нужно, когда тот же диск смонтирован по другому пути — иначе повторное
 * подключение заставило бы перечитать все терабайты заново.
 */
export async function sha256Cached(absPath, size, mtime, name) {
  const cached = getCachedHash(absPath, size, mtime, name);
  if (cached) {
    // Запоминаем и новый путь, чтобы дальше попадать в кэш по нему напрямую.
    putCachedHash(absPath, size, mtime, cached, name);
    return cached;
  }
  const digest = await sha256File(absPath);
  putCachedHash(absPath, size, mtime, digest, name);
  return digest;
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
