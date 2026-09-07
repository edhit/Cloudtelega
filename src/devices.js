import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function subdirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Кандидаты точек монтирования для текущей ОС. */
export async function listMountPoints() {
  const platform = os.platform();
  const points = [];

  if (platform === 'darwin') {
    points.push(...(await subdirs('/Volumes')));
  } else if (platform === 'linux') {
    for (const base of ['/media', '/run/media', '/mnt']) {
      for (const d of await subdirs(base)) {
        // /media/<user>/<label> — заглядываем на уровень глубже
        const inner = await subdirs(d);
        if (inner.length && (base === '/media' || base === '/run/media')) points.push(...inner);
        points.push(d);
      }
    }
  } else if (platform === 'win32') {
    for (let c = 67; c <= 90; c += 1) {
      const drive = `${String.fromCharCode(c)}:\\`;
      if (fs.existsSync(drive)) points.push(drive);
    }
  }

  // Домашние каталоги с фото — тоже валидный источник (например, выгрузка из iCloud).
  const home = os.homedir();
  for (const extra of ['Pictures', 'DCIM']) {
    const p = path.join(home, extra);
    if (await exists(p)) points.push(p);
  }

  return [...new Set(points)];
}

/** Похоже ли содержимое на камеру iPhone (DCIM/100APPLE и т.п.). */
export async function inspectMount(mount) {
  const info = { path: mount, hasDcim: false, looksLikeIPhone: false, dcimPath: null, sample: [] };
  const dcim = path.join(mount, 'DCIM');
  if (await exists(dcim)) {
    info.hasDcim = true;
    info.dcimPath = dcim;
    const dirs = await subdirs(dcim);
    info.sample = dirs.slice(0, 5).map((d) => path.basename(d));
    info.looksLikeIPhone = dirs.some((d) => /\d{3}(APPLE|CLOUD)/i.test(path.basename(d)));
  }
  return info;
}

/** Проверяет, виден ли iPhone через libimobiledevice (idevice_id). */
export async function detectIosDevices() {
  try {
    const { stdout } = await exec('idevice_id', ['-l'], { timeout: 5000 });
    const udids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const devices = [];
    for (const udid of udids) {
      let name = 'iPhone';
      try {
        const { stdout: n } = await exec('ideviceinfo', ['-u', udid, '-k', 'DeviceName'], { timeout: 5000 });
        name = n.trim() || name;
      } catch {
        /* имя не критично */
      }
      devices.push({ udid, name });
    }
    return devices;
  } catch {
    return []; // libimobiledevice не установлен или устройство не подключено
  }
}

export function mountHint() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return [
      'macOS: iPhone не монтируется как диск. Варианты:',
      '  1) Image Capture (Захват изображений) → выгрузить DCIM в папку → указать её в SCAN_PATHS;',
      '  2) brew install libimobiledevice ifuse && ifuse ~/iphone → SCAN_PATHS=~/iphone/DCIM',
    ].join('\n');
  }
  if (platform === 'linux') {
    return [
      'Linux: sudo apt install libimobiledevice6 libimobiledevice-utils ifuse',
      '  idevicepair pair && mkdir -p ~/iphone && ifuse ~/iphone',
      '  затем SCAN_PATHS=~/iphone/DCIM (размонтировать: fusermount -u ~/iphone)',
      'Либо GVFS-монтирование: /run/user/1000/gvfs/afc:host=<UDID>/DCIM',
    ].join('\n');
  }
  if (platform === 'win32') {
    return [
      'Windows: iPhone виден как MTP-устройство «Apple iPhone» — Node не читает MTP напрямую.',
      '  Скопируйте DCIM в обычную папку (Проводник → Этот компьютер → Apple iPhone → Internal Storage → DCIM)',
      '  и укажите путь в SCAN_PATHS.',
    ].join('\n');
  }
  return '';
}
