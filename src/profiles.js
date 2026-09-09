import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('profiles');
export const DEFAULT_PROFILE = 'default';

/** Имя папки: без разделителей пути и точек в начале. */
export function sanitizeName(raw) {
  const name = String(raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 40);
  if (!name) throw new Error('Пустое имя профиля');
  return name;
}

/**
 * Активный профиль: сначала --profile= в командной строке, затем переменная
 * окружения. Читается до загрузки настроек, поэтому смотрим argv напрямую.
 */
export function profileName() {
  const fromArgv = process.argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length);
  const raw = fromArgv || process.env.CLOUDTELEGA_PROFILE || DEFAULT_PROFILE;
  return raw.trim() || DEFAULT_PROFILE;
}

export function isDefaultProfile(name = profileName()) {
  return name === DEFAULT_PROFILE;
}

/** Папка профиля. У профиля по умолчанию это корень программы — чтобы старые установки не сломались. */
export function profileDir(name = profileName()) {
  return isDefaultProfile(name) ? path.resolve('.') : path.join(ROOT, sanitizeName(name));
}

export function profileEnvPath(name = profileName()) {
  return isDefaultProfile(name) ? path.resolve('.env') : path.join(profileDir(name), 'config.env');
}

/** Куда по умолчанию складывать базу и временные файлы профиля. */
export function profileDefaults(name = profileName()) {
  if (isDefaultProfile(name)) {
    return { dbPath: './data/cloudtelega.db', tmpDir: './tmp' };
  }
  const dir = profileDir(name);
  return { dbPath: path.join(dir, 'archive.db'), tmpDir: path.join(dir, 'tmp') };
}

export function setActiveProfile(name) {
  const clean = name === DEFAULT_PROFILE ? DEFAULT_PROFILE : sanitizeName(name);
  process.env.CLOUDTELEGA_PROFILE = clean;
  // Аргумент командной строки перебивал бы переменную окружения — убираем его.
  const idx = process.argv.findIndex((a) => a.startsWith('--profile='));
  if (idx !== -1) process.argv[idx] = `--profile=${clean}`;
  return clean;
}

export function createProfile(rawName) {
  const name = sanitizeName(rawName);
  if (name === DEFAULT_PROFILE) throw new Error('Профиль «default» уже есть');
  const dir = profileDir(name);
  if (fs.existsSync(dir)) throw new Error(`Профиль «${name}» уже существует`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(profileEnvPath(name), '', { mode: 0o600 });
  return name;
}

/** Все профили с коротким описанием: настроен ли, есть ли база. */
export function listProfiles() {
  const names = [DEFAULT_PROFILE];
  try {
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) names.push(entry.name);
    }
  } catch {
    /* папки профилей ещё нет — это нормально */
  }

  const active = profileName();
  return names.map((name) => {
    const envPath = profileEnvPath(name);
    let configured = false;
    let chatId = '';
    try {
      const text = fs.readFileSync(envPath, 'utf8');
      configured = /^TELEGRAM_BOT_TOKEN=.+$/m.test(text);
      chatId = /^TELEGRAM_CHAT_ID=(.+)$/m.exec(text)?.[1]?.trim() ?? '';
    } catch {
      /* профиль ещё не настроен */
    }

    const { dbPath } = profileDefaults(name);
    let dbSize = 0;
    for (const file of [dbPath, `${dbPath}-wal`]) {
      try {
        dbSize += fs.statSync(file).size;
      } catch {
        /* базы может не быть */
      }
    }

    return { name, active: name === active, configured, chatId, envPath, dbPath, dbSize };
  });
}

/**
 * Читает настройки чужого профиля, не переключаясь на него.
 * Нужно, например, чтобы отправить код входа ботом того профиля.
 */
export function readProfileEnv(name) {
  const result = {};
  try {
    const text = fs.readFileSync(profileEnvPath(name), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) result[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch {
    /* профиль не настроен */
  }
  return result;
}

export function deleteProfile(rawName) {
  const name = sanitizeName(rawName);
  if (name === DEFAULT_PROFILE) throw new Error('Профиль по умолчанию удалить нельзя');
  if (name === profileName()) throw new Error('Нельзя удалить профиль, в котором сейчас работаете');
  fs.rmSync(profileDir(name), { recursive: true, force: true });
  return name;
}
