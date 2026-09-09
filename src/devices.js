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

/* ── как подключить телефон ──────────────────────────────────────────────── */

/**
 * Инструкции по шагам — свои у каждой системы и у каждого вида телефона.
 * Команду в шаге пользователь копирует кнопкой, остальное делает руками.
 */
const GUIDES = {
  darwin: {
    ios: {
      title: 'iPhone на macOS',
      lead: 'Как флешка iPhone не подключается — Apple так решила. Есть два пути: простой через готовое приложение и разовый через терминал.',
      steps: [
        { text: 'Подключите iPhone кабелем и на телефоне нажмите «Доверять этому компьютеру».' },
        { text: 'Откройте «Захват изображений» (Image Capture) — он уже есть в macOS, искать в Launchpad.' },
        { text: 'Слева выберите iPhone, внизу укажите папку, куда сохранять, и нажмите «Импортировать все».' },
        { text: 'Когда выгрузка закончится, добавьте эту папку в список папок для отправки.' },
      ],
      alt: {
        title: 'Если хочется без копирования — смонтировать телефон как диск',
        steps: [
          { text: 'Установите два инструмента (нужен Homebrew):', command: 'brew install libimobiledevice ifuse' },
          { text: 'Создайте папку и подключите к ней телефон:', command: 'mkdir -p ~/iphone && ifuse ~/iphone' },
          { text: 'Добавьте в список папок ~/iphone/DCIM. Отключить телефон потом:', command: 'umount ~/iphone' },
        ],
      },
    },
    android: {
      title: 'Android на macOS',
      lead: 'Finder телефон не покажет: Android говорит по протоколу MTP, а macOS его не понимает. Нужен посредник.',
      steps: [
        { text: 'Подключите телефон кабелем.' },
        { text: 'На телефоне опустите шторку, нажмите на уведомление о зарядке и выберите «Передача файлов» (MTP).' },
        { text: 'Скачайте и откройте Android File Transfer с android.com/filetransfer (или OpenMTP — он удобнее).' },
        { text: 'Скопируйте из телефона папку DCIM в любую папку на компьютере и добавьте её в список.' },
      ],
      alt: {
        title: 'Через терминал, если так привычнее',
        steps: [
          { text: 'Поставьте инструменты Android:', command: 'brew install android-platform-tools' },
          { text: 'На телефоне включите «Отладку по USB» в разделе «Для разработчиков».' },
          { text: 'Скопируйте снимки:', command: 'adb pull /sdcard/DCIM ~/android-photos' },
        ],
      },
    },
  },

  win32: {
    ios: {
      title: 'iPhone на Windows',
      lead: 'Windows показывает iPhone как камеру. Снимки нужно скопировать на диск — читать их прямо с телефона программа не умеет.',
      steps: [
        { text: 'Подключите iPhone кабелем и на телефоне нажмите «Доверять этому компьютеру».' },
        { text: 'Если телефон не появился, установите iTunes (или Apple Devices) — вместе с ним ставятся драйверы.' },
        { text: 'Откройте Проводник → «Этот компьютер» → Apple iPhone → Internal Storage → DCIM.' },
        { text: 'Скопируйте папку DCIM на диск, например в «Изображения», и добавьте эту папку в список.' },
      ],
      alt: {
        title: 'Если фото лежат в iCloud, а не на телефоне',
        steps: [
          { text: 'Откройте iCloud для Windows и включите «Фото» → «Загружать новые фото на этот компьютер».' },
          { text: 'Дождитесь выгрузки и добавьте папку iCloud Photos в список.' },
        ],
      },
    },
    android: {
      title: 'Android на Windows',
      lead: 'Телефон подключается по MTP: в Проводнике он виден, но обычной буквы диска у него нет. Снимки нужно скопировать.',
      steps: [
        { text: 'Подключите телефон кабелем.' },
        { text: 'На телефоне опустите шторку, нажмите на уведомление о зарядке и выберите «Передача файлов» (MTP), а не «Только зарядка».' },
        { text: 'Откройте Проводник → «Этот компьютер» → ваш телефон → Internal Storage → DCIM.' },
        { text: 'Скопируйте DCIM на диск и добавьте эту папку в список.' },
      ],
      alt: {
        title: 'Заодно стоит забрать снимки из мессенджеров',
        steps: [
          { text: 'Рядом с DCIM лежат папки Pictures, Movies и Download — фото из WhatsApp и Telegram обычно там.' },
          { text: 'Скопируйте и их, если хотите сохранить и эти снимки.' },
        ],
      },
    },
  },

  linux: {
    ios: {
      title: 'iPhone на Linux',
      lead: 'iPhone подключается через libimobiledevice — тогда он становится обычной папкой.',
      steps: [
        { text: 'Установите пакеты:', command: 'sudo apt install libimobiledevice6 libimobiledevice-utils ifuse' },
        { text: 'Подключите iPhone кабелем и на телефоне нажмите «Доверять этому компьютеру».' },
        { text: 'Подтвердите пару:', command: 'idevicepair pair' },
        { text: 'Смонтируйте телефон в папку:', command: 'mkdir -p ~/iphone && ifuse ~/iphone' },
        { text: 'Добавьте в список папок ~/iphone/DCIM. Отключить телефон потом:', command: 'fusermount -u ~/iphone' },
      ],
    },
    android: {
      title: 'Android на Linux',
      lead: 'Обычно телефон появляется в файловом менеджере сам — тогда программа найдёт его без вашей помощи.',
      steps: [
        { text: 'Подключите телефон кабелем.' },
        { text: 'На телефоне опустите шторку, нажмите на уведомление о зарядке и выберите «Передача файлов» (MTP).' },
        { text: 'Откройте файловый менеджер: телефон должен появиться в списке устройств.' },
        { text: 'Дальше программа найдёт путь вида /run/user/1000/gvfs/mtp:host=… сама: «Показать диски и телефоны» в мастере или npm run devices.' },
      ],
      alt: {
        title: 'Если телефон так и не появился',
        steps: [
          { text: 'Поставьте adb:', command: 'sudo apt install android-tools-adb' },
          { text: 'На телефоне включите «Отладку по USB» в разделе «Для разработчиков».' },
          { text: 'Скопируйте снимки в папку:', command: 'adb pull /sdcard/DCIM ~/android-photos' },
        ],
      },
    },
  },
};

const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** Инструкции для всех систем сразу плюс та, что стоит показать первой. */
export function connectGuides() {
  const platform = os.platform();
  return {
    platform: GUIDES[platform] ? platform : 'linux',
    detected: PLATFORM_NAMES[platform] ?? platform,
    known: Boolean(GUIDES[platform]),
    names: PLATFORM_NAMES,
    guides: GUIDES,
  };
}

/** Тот же текст для терминала: в CLI окошек нет. */
export function mountHint() {
  const { platform, detected } = connectGuides();
  const guide = GUIDES[platform];
  const lines = [`Как подключить телефон (${detected}):`];

  for (const kind of ['ios', 'android']) {
    const part = guide[kind];
    lines.push('', part.title, `  ${part.lead}`);
    part.steps.forEach((step, i) => {
      lines.push(`  ${i + 1}. ${step.text}`);
      if (step.command) lines.push(`     ${step.command}`);
    });
    if (part.alt) {
      lines.push(`  ${part.alt.title}`);
      part.alt.steps.forEach((step, i) => {
        lines.push(`    ${i + 1}. ${step.text}`);
        if (step.command) lines.push(`       ${step.command}`);
      });
    }
  }

  return lines.join('\n');
}
