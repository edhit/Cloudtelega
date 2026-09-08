import path from 'node:path';

/**
 * Суффиксы, которыми экспорт помечает видео Live Photo:
 * iCloud отдаёт IMG_0373.jpg + IMG_0373_HEVC.MOV, другие выгрузки — _LIVE, _MOTION.
 */
const LIVE_VIDEO_SUFFIX = /(?:[_-](?:hevc|live|motion|lp))+$/i;

/** Имя файла без расширения. */
export function stemOf(name) {
  return path.basename(name, path.extname(name));
}

/**
 * Ключ «это один и тот же кадр»: имя без расширения, без служебного суффикса
 * видео Live Photo, в нижнем регистре.
 */
export function normalizeStem(name) {
  return stemOf(name).replace(LIVE_VIDEO_SUFFIX, '').toLowerCase();
}
