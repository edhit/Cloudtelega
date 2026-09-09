const COLORS = {
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
};

const stamp = () => new Date().toISOString().slice(11, 19);

// Кто ещё хочет видеть строки лога: мастер настройки показывает их в браузере,
// чтобы не пришлось лезть в терминал за причиной ошибки.
const listeners = new Set();

/**
 * Подписаться на лог. Возвращает функцию отписки.
 * @param {(entry: {level: string, text: string, at: number}) => void} fn
 */
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function broadcast(level, args) {
  if (!listeners.size) return;
  const entry = { level, text: args.map(String).join(' '), at: Date.now() };
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* подписчик сломался — лог из-за этого ронять нельзя */
    }
  }
}

function write(level, color, args) {
  const prefix = `${COLORS.dim}${stamp()}${COLORS.reset} ${color}${level.padEnd(5)}${COLORS.reset}`;
  console.log(prefix, ...args);
  broadcast(level, args);
}

export const log = {
  info: (...a) => write('info', COLORS.info, a),
  ok: (...a) => write('ok', COLORS.ok, a),
  warn: (...a) => write('warn', COLORS.warn, a),
  error: (...a) => write('error', COLORS.error, a),
  plain: (...a) => {
    console.log(...a);
    broadcast('plain', a);
  },
};

export function humanSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function progressBar(ratio, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${(ratio * 100).toFixed(0)}%`;
}
