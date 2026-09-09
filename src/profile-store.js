import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDefaultProfile, profileDir, profileName } from './profiles.js';

/**
 * Личные настройки профиля: как он выглядит и как защищён.
 * Лежат рядом с базой, отдельно от .env — это не секреты Telegram, а оформление.
 */
const FILE = 'profile.json';

export function profileStateDir(name = profileName()) {
  return isDefaultProfile(name) ? path.resolve('data') : profileDir(name);
}

function storePath(name = profileName()) {
  return path.join(profileStateDir(name), FILE);
}

const DEFAULTS = {
  displayName: '',
  accent: '#007aff',
  theme: 'auto', // auto | light | dark
  avatar: null, // имя файла рядом с profile.json
  telegram: null, // кэш данных аккаунта: имя, username, аватар, Premium
  lock: { type: 'none', autoLockMinutes: 30 },
  lastLoginAt: null,
};

export function readProfileStore(name = profileName()) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(name), 'utf8'));
    return { ...DEFAULTS, ...raw, lock: { ...DEFAULTS.lock, ...(raw.lock ?? {}) } };
  } catch {
    return { ...DEFAULTS, lock: { ...DEFAULTS.lock } };
  }
}

export function writeProfileStore(patch, name = profileName()) {
  const dir = profileStateDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...readProfileStore(name), ...patch };
  fs.writeFileSync(storePath(name), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/* ── защита профиля ──────────────────────────────────────────────────────── */

/** scrypt с солью: подобрать пин по файлу нельзя, сравнение без утечки времени. */
function hashSecret(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32).toString('hex');
}

export function setProfileLock(type, secret, name = profileName()) {
  if (!['none', 'pin', 'password', 'telegram'].includes(type)) {
    throw new Error(`Неизвестный способ защиты: ${type}`);
  }

  const store = readProfileStore(name);
  const lock = { ...store.lock, type };

  if (type === 'pin' || type === 'password') {
    const value = String(secret ?? '');
    if (type === 'pin' && !/^\d{4,8}$/.test(value)) throw new Error('PIN — от 4 до 8 цифр');
    if (type === 'password' && value.length < 6) throw new Error('Пароль — минимум 6 символов');
    lock.salt = crypto.randomBytes(16).toString('hex');
    lock.hash = hashSecret(value, lock.salt);
  } else {
    delete lock.salt;
    delete lock.hash;
  }

  return writeProfileStore({ lock }, name);
}

export function verifyProfileSecret(secret, name = profileName()) {
  const { lock } = readProfileStore(name);
  if (!lock.salt || !lock.hash) return false;
  const candidate = Buffer.from(hashSecret(secret ?? '', lock.salt), 'hex');
  const stored = Buffer.from(lock.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

export function isProfileLocked(name = profileName()) {
  return readProfileStore(name).lock.type !== 'none';
}

export function markProfileLogin(name = profileName()) {
  return writeProfileStore({ lastLoginAt: Date.now() }, name);
}

/* ── аватар ──────────────────────────────────────────────────────────────── */

export function avatarPath(name = profileName()) {
  const { avatar } = readProfileStore(name);
  if (!avatar) return null;
  const file = path.join(profileStateDir(name), avatar);
  return fs.existsSync(file) ? file : null;
}

export function saveAvatar(buffer, ext = '.jpg', name = profileName()) {
  const dir = profileStateDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const file = `avatar${ext}`;
  fs.writeFileSync(path.join(dir, file), buffer);
  writeProfileStore({ avatar: file }, name);
  return file;
}
