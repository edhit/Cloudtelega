import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.resolve('.env');
const EXAMPLE_PATH = path.resolve('.env.example');

/** Значение нужно закавычить, если в нём есть пробелы, решётка или кавычки. */
function quote(value) {
  const v = String(value ?? '');
  return /[\s#"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

export function envExists() {
  return fs.existsSync(ENV_PATH);
}

/**
 * Обновляет .env, сохраняя комментарии и порядок строк.
 * Если файла нет, он создаётся из .env.example — вместе с пояснениями.
 */
export function updateEnv(patch) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf8');
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

  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
  return ENV_PATH;
}

export function envPath() {
  return ENV_PATH;
}
