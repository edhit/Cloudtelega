import fs from 'node:fs';
import path from 'node:path';
import { profileEnvPath } from './profiles.js';

const EXAMPLE_PATH = path.resolve('.env.example');

/** Значение нужно закавычить, если в нём есть пробелы, решётка или кавычки. */
function quote(value) {
  const v = String(value ?? '');
  return /[\s#"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

export function envExists() {
  return fs.existsSync(profileEnvPath());
}

/**
 * Обновляет .env, сохраняя комментарии и порядок строк.
 * Если файла нет, он создаётся из .env.example — вместе с пояснениями.
 */
export function updateEnv(patch) {
  const target = profileEnvPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let content = '';
  if (fs.existsSync(target)) {
    content = fs.readFileSync(target, 'utf8');
  } else if (fs.existsSync(EXAMPLE_PATH)) {
    content = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  }

  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    const line = `${key}=${quote(raw)}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content += `${content === '' || content.endsWith('\n') ? '' : '\n'}${line}\n`;
    }
  }

  fs.writeFileSync(target, content, { mode: 0o600 });
  return target;
}

export function envPath() {
  return profileEnvPath();
}
