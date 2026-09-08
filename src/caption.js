import { config } from './config.js';
import { formatDate, formatDateHuman, monthTag } from './dates.js';
import { humanSize } from './logger.js';
import { stemOf } from './naming.js';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Хештег из имени файла: только буквы, цифры и подчёркивания. */
function stemTag(name) {
  const stem = stemOf(name);
  return /^[A-Za-zА-Яа-яЁё0-9_]+$/.test(stem) ? `#${stem}` : null;
}

function tagsFor(file, { live }) {
  const d = new Date(file.takenAt ?? file.mtime);
  const tags = [`#${d.getFullYear()}`, `#${monthTag(file.takenAt ?? file.mtime)}`];
  if (live) tags.push('#live');
  else if (file.kind === 'video') tags.push('#видео');
  const stem = stemTag(file.name);
  if (stem) tags.push(stem);
  return tags.join(' ');
}

function metaParts(file, { live, note }) {
  const parts = [];
  if (file.camera) parts.push(file.camera);
  parts.push(humanSize(file.size));
  if (live) parts.push('Live Photo');
  if (note) parts.push(note);
  return parts;
}

/**
 * Подпись к сообщению.
 * @returns {{text:string, parseMode:'HTML'|null}}
 */
export function buildCaption(file, { live = false, note = null } = {}) {
  const when = file.takenAt ?? file.mtime;
  // «≈» — достоверной даты съёмки нет, взяли из файловой системы
  const approx = file.dateSource === 'fs' ? '≈ ' : '';
  const icon = live ? '📷' : file.kind === 'video' ? '🎬' : '📷';
  const style = config.captionStyle;

  if (style === 'plain') {
    const lines = [
      `📅 ${approx}${formatDate(when)}`,
      file.relPath || file.name,
      [...metaParts(file, { live, note }), file.sha256 ? `sha:${file.sha256.slice(0, 16)}` : null]
        .filter(Boolean)
        .join(' · '),
    ];
    return { text: lines.join('\n'), parseMode: null };
  }

  if (style === 'minimal') {
    return {
      text: `${icon} ${approx}${formatDateHuman(when)}\n${tagsFor(file, { live })}`,
      parseMode: null,
    };
  }

  // pretty: заголовок — дата, техническая часть спрятана в раскрывающуюся цитату
  const lines = [
    `${icon} <b>${approx}${escapeHtml(formatDateHuman(when))}</b>`,
    `<i>${escapeHtml(metaParts(file, { live, note }).join(' · '))}</i>`,
    tagsFor(file, { live }),
    `<blockquote expandable>${escapeHtml(file.relPath || file.name)}` +
      (file.sha256 ? `\n<code>sha:${file.sha256.slice(0, 16)}</code>` : '') +
      '</blockquote>',
  ];
  return { text: lines.join('\n'), parseMode: 'HTML' };
}
