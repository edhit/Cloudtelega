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

/** sha256 с кэшем по (path, size, mtime) — повторные запуски не перечитывают диск. */
export async function sha256Cached(absPath, size, mtime) {
  const cached = getCachedHash(absPath, size, mtime);
  if (cached) return cached;
  const digest = await sha256File(absPath);
  putCachedHash(absPath, size, mtime, digest);
  return digest;
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
