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

/** Точки, куда gvfs монтирует телефоны: mtp:host=… (Android) и afc:host=… (iPhone). */
async function gvfsMounts() {
  const base = `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}/gvfs`;
  return subdirs(base);
}

/** Кандидаты точек монтирования для текущей ОС. */
export async function listMountPoints() {
  const platform = os.platform();
  const points = [];

  if (platform === 'darwin') {
    points.push(...(await subdirs('/Volumes')));
  } else if (platform === 'linux') {
    points.push(...(await gvfsMounts()));
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

/**
 * Что за устройство перед нами: iPhone раскладывает снимки по папкам 100APPLE,
 * Android — в DCIM/Camera (плюс Pictures и Movies рядом).
 */
export async function inspectMount(mount) {
  const info = {
    path: mount,
    hasDcim: false,
    looksLikeIPhone: false,
    looksLikeAndroid: false,
    dcimPath: null,
    extraPaths: [],
    sample: [],
  };

  const dcim = path.join(mount, 'DCIM');
  if (await exists(dcim)) {
    info.hasDcim = true;
    info.dcimPath = dcim;
    const dirs = await subdirs(dcim);
    info.sample = dirs.slice(0, 5).map((d) => path.basename(d));
    info.looksLikeIPhone = dirs.some((d) => /\d{3}(APPLE|CLOUD)/i.test(path.basename(d)));
    info.looksLikeAndroid = dirs.some((d) => /^(Camera|Screenshots|100ANDRO|OpenCamera)$/i.test(path.basename(d)));
  }

  // На Android снимки из мессенджеров и скриншоты лежат вне DCIM
  for (const extra of ['Pictures', 'Movies', 'Download']) {
    const p = path.join(mount, extra);
    if (await exists(p)) {
      info.extraPaths.push(p);
      if (extra !== 'Download') info.looksLikeAndroid = true;
    }
  }

  if (/mtp:host=/i.test(mount)) info.looksLikeAndroid = true;
  if (/afc:host=/i.test(mount)) info.looksLikeIPhone = true;

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

/** Android по кабелю: adb показывает устройство, даже когда MTP не смонтирован. */
export async function detectAndroidDevices() {
  try {
    const { stdout } = await exec('adb', ['devices', '-l'], { timeout: 5000 });
    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('*') && / device\b/.test(line))
      .map((line) => {
        const [serial] = line.split(/\s+/);
        const model = /model:(\S+)/.exec(line)?.[1]?.replace(/_/g, ' ');
        return { serial, name: model || 'Android', kind: 'android' };
      });
  } catch {
    return []; // adb не установлен или устройство не подключено
  }
}

/** Все подключённые телефоны: и Apple, и Android. */
export async function detectPhones() {
  const [apple, android] = await Promise.all([detectIosDevices(), detectAndroidDevices()]);
  return [...apple.map((d) => ({ ...d, kind: 'ios' })), ...android];
}

export function mountHint() {
  const platform = os.platform();

  if (platform === 'darwin') {
    return [
      'iPhone на macOS не монтируется как флешка:',
      '  • «Захват изображений» (Image Capture) → выгрузить всё в папку → указать её здесь;',
      '  • или brew install libimobiledevice ifuse, затем ifuse ~/iphone → ~/iphone/DCIM',
      '',
      'Android на macOS: Finder телефон не показывает, нужен посредник:',
      '  • приложение Android File Transfer (или OpenMTP) → скопировать DCIM в папку;',
      '  • или brew install android-platform-tools, затем adb pull /sdcard/DCIM ~/android-photos',
    ].join('\n');
  }

  if (platform === 'linux') {
    return [
      'iPhone: sudo apt install libimobiledevice6 libimobiledevice-utils ifuse',
      '  idevicepair pair && mkdir -p ~/iphone && ifuse ~/iphone   (отключить: fusermount -u ~/iphone)',
      '',
      'Android: телефон обычно сам появляется в файловом менеджере (MTP) —',
      '  тогда путь вида /run/user/1000/gvfs/mtp:host=… программа найдёт сама.',
      '  Если нет: sudo apt install android-tools-adb, включить «Отладку по USB»,',
      '  затем adb pull /sdcard/DCIM ~/android-photos',
      '',
      'На телефоне при подключении выберите режим «Передача файлов» (MTP), а не «Только зарядка».',
    ].join('\n');
  }

  if (platform === 'win32') {
    return [
      'И iPhone, и Android Windows показывает как MTP-устройство — напрямую Node их не читает.',
      '  Проводник → «Этот компьютер» → ваш телефон → Internal Storage → DCIM,',
      '  скопируйте папку на диск и укажите её здесь.',
      'На телефоне разрешите доступ: iPhone — «Доверять этому компьютеру»,',
      'Android — режим подключения «Передача файлов» (MTP).',
    ].join('\n');
  }

  return '';
}
