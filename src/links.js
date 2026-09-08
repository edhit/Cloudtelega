import { config } from './config.js';

/**
 * Ссылка на сообщение в Telegram. Строится из того, что уже лежит в базе:
 * ничего заново отправлять не нужно, ссылки появляются у всего старого архива.
 */
export function messageLink(row) {
  const messageId = row?.message_id;
  if (!messageId) return null;

  const chat = String(row.chat_id || config.chatId || '').trim();
  if (!chat) return null;

  // Публичный канал: t.me/username/123
  if (chat.startsWith('@')) return `https://t.me/${chat.slice(1)}/${messageId}`;

  // Приватная группа или канал: -1001234567890 → t.me/c/1234567890/123
  const internal = /^-100(\d+)$/.exec(chat)?.[1];
  if (!internal) return null;

  // В группе с темами ссылка ведёт внутрь нужной темы
  return row.topic_id
    ? `https://t.me/c/${internal}/${row.topic_id}/${messageId}`
    : `https://t.me/c/${internal}/${messageId}`;
}
