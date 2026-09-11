/**
 * Доступ к диску: ссылки-приглашения со сроком и автоматическое закрытие
 * доступа, когда срок вышел.
 *
 * Два разных срока, которые легко перепутать:
 *  • срок жизни ССЫЛКИ  — до какого момента по ней вообще можно войти;
 *  • срок ДОСТУПА       — сколько человек остаётся в чате после входа.
 * Первый умеет сам Telegram (expire_date), второй он не умеет вовсе:
 * приходится помнить в базе и выгонять самим.
 *
 * Выгоняем без бана: в Bot API «kick» — это ban + сразу unban. Без разбана
 * человек остаётся в чёрном списке и не сможет войти даже по новой ссылке.
 */
import { config } from './config.js';
import { log, humanSize } from './logger.js';
import { describeError } from './errors.js';
import {
  addGuest, addInvite, bumpInviteUsage, getGuest, getInvite, guestsToExpire,
  listGuests, listInvites, markGuestRemoved, markInviteRevoked, setGuestExpiry,
} from './db.js';
import {
  createChatInviteLink, getChatMemberCount, kickWithoutBan, revokeChatInviteLink,
} from './telegram/botApi.js';

/** Готовые сроки: то, что обычно и нужно, без ввода чисел руками. */
export const ACCESS_PRESETS = [
  { id: 'day', label: 'На день', hours: 24 },
  { id: 'week', label: 'На неделю', hours: 24 * 7 },
  { id: 'month', label: 'На месяц', hours: 24 * 30 },
  { id: 'year', label: 'На год', hours: 24 * 365 },
  { id: 'forever', label: 'Навсегда', hours: null },
];

const HOUR = 3600 * 1000;

export function presetHours(id) {
  const preset = ACCESS_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Неизвестный срок: ${id}`);
  return preset.hours;
}

/**
 * Хранилища, к которым вообще можно кого-то пустить. Их два, и у каждого
 * свой чат: диск и архив снимков. Если чат один на двоих, хранилище тоже
 * одно — пускать «в диск, но не в снимки» в таком чате невозможно,
 * и обещать этого нельзя.
 */
export function shareTargets() {
  const out = [];
  if (config.driveChatId) out.push({ id: 'drive', chatId: String(config.driveChatId), title: 'Диск' });
  if (config.chatId && String(config.chatId) !== String(config.driveChatId)) {
    out.push({ id: 'photos', chatId: String(config.chatId), title: 'Фотоархив' });
  }
  if (!out.length && config.chatId) {
    out.push({ id: 'both', chatId: String(config.chatId), title: 'Диск и снимки' });
  }
  return out;
}

/** Куда пускаем по умолчанию: у диска свой чат, если он задан, иначе общий. */
export function shareChatId() {
  return config.driveChatId || config.chatId;
}

/**
 * Новая ссылка-приглашение.
 * @param {{name?:string, accessPreset?:string, accessHours?:number|null,
 *          linkHours?:number|null, memberLimit?:number|null, joinRequest?:boolean}} opts
 */
export async function createAccessLink({
  chatId: wantChat,
  name,
  accessPreset = 'week',
  accessHours,
  linkHours = 48,
  memberLimit = 1,
  joinRequest = false,
} = {}) {
  const chatId = wantChat ? String(wantChat) : shareChatId();
  if (!chatId) throw new Error('Не выбран чат для диска — укажите его на шаге «Диск»');

  const access = accessHours === undefined ? presetHours(accessPreset) : accessHours;
  const linkExpires = linkHours ? Date.now() + linkHours * HOUR : null;

  const result = await createChatInviteLink({
    chatId,
    name: name || describeAccess(access),
    expireDate: linkExpires,
    memberLimit: joinRequest ? null : memberLimit,
    joinRequest,
  });

  const row = addInvite({
    chatId,
    link: result.invite_link,
    name: name || describeAccess(access),
    expiresAt: linkExpires,
    accessMs: access === null ? null : access * HOUR,
    memberLimit: joinRequest ? null : memberLimit,
    joinRequest,
  });

  log.ok(`Ссылка на диск готова: ${row.name} (${describeAccess(access)})`);
  return row;
}

export async function revokeAccessLink(link) {
  const invite = getInvite(link);
  const chatId = invite?.chat_id ?? shareChatId();
  try {
    await revokeChatInviteLink(link, chatId);
  } catch (err) {
    // Ссылку могли отозвать вручную в Telegram — в базе всё равно закрываем
    log.warn(`Отозвать ссылку в Telegram не вышло: ${describeError(err, { kind: 'bot' })}`);
  }
  markInviteRevoked(link);
  return true;
}

/** Словами: «на день», «на месяц», «навсегда». */
export function describeAccess(hours) {
  if (hours === null || hours === undefined) return 'Навсегда';
  const preset = ACCESS_PRESETS.find((p) => p.hours === hours);
  if (preset) return preset.label;
  if (hours % 24 === 0) return `На ${hours / 24} дн.`;
  return `На ${hours} ч.`;
}

/**
 * Кто-то вошёл в чат. Из апдейта chat_member берём и человека, и ссылку —
 * по ней понятно, на какой срок ему открыт доступ.
 */
export function noteJoin(update) {
  const member = update.chat_member ?? update.chat_join_request;
  if (!member) return null;

  const chatId = String(member.chat?.id ?? '');
  const user = member.from ?? member.new_chat_member?.user;
  const status = member.new_chat_member?.status;

  // Интересует именно переход в участники: остальные события пропускаем
  if (update.chat_member && status !== 'member') {
    if (status === 'left' || status === 'kicked') {
      if (user && getGuest(chatId, user.id)) {
        markGuestRemoved(chatId, user.id, status === 'kicked' ? 'manual' : 'left');
      }
    }
    return null;
  }
  if (!user) return null;

  const link = member.invite_link?.invite_link ?? null;
  const invite = link ? getInvite(link) : null;
  const expiresAt = invite?.access_ms ? Date.now() + invite.access_ms : null;

  if (link) bumpInviteUsage(link);

  const guest = addGuest({
    chatId,
    userId: user.id,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Гость',
    username: user.username ?? null,
    inviteLink: link,
    inviteName: invite?.name ?? member.invite_link?.name ?? null,
    expiresAt,
  });

  log.ok(
    `В диск вошёл ${guest.name}${guest.username ? ` (@${guest.username})` : ''}` +
    `${expiresAt ? `, доступ до ${new Date(expiresAt).toLocaleString('ru-RU')}` : ' — бессрочно'}`,
  );
  return guest;
}

/**
 * Закрывает доступ тем, у кого срок вышел. Вызывается по таймеру из бота
 * и из мастера — чтобы не зависеть от того, что именно сейчас запущено.
 * @returns {Promise<{checked:number, removed:object[], failed:object[]}>}
 */
export async function expireGuests() {
  const due = guestsToExpire();
  const removed = [];
  const failed = [];

  for (const guest of due) {
    try {
      await kickWithoutBan(guest.user_id, { chatId: guest.chat_id });
      markGuestRemoved(guest.chat_id, guest.user_id, 'expired');
      removed.push(guest);
      log.ok(`Доступ закончился: ${guest.name} убран из диска (не забанен — сможет войти снова)`);
    } catch (err) {
      failed.push({ guest, error: describeError(err, { kind: 'bot' }) });
      log.warn(`Не удалось убрать ${guest.name}: ${describeError(err, { kind: 'bot' })}`);
    }
  }

  return { checked: due.length, removed, failed };
}

/** Убрать гостя вручную — тоже без бана. */
export async function removeGuest(userId, chatId = shareChatId()) {
  await kickWithoutBan(userId, { chatId });
  markGuestRemoved(chatId, userId, 'manual');
  return true;
}

/** Продлить доступ уже вошедшему. */
export function extendGuest(userId, hours, chatId = shareChatId()) {
  const guest = getGuest(chatId, userId);
  if (!guest) throw new Error('Такого гостя нет в списке');
  const base = Math.max(Date.now(), guest.expires_at ?? Date.now());
  return setGuestExpiry(chatId, userId, hours === null ? null : base + hours * HOUR);
}

/** Сколько осталось словами: «3 дн. 4 ч.», «истёк». */
export function timeLeft(expiresAt) {
  if (!expiresAt) return 'бессрочно';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'истёк';
  const hours = Math.floor(ms / HOUR);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days} дн. ${hours % 24} ч.`;
  if (hours >= 1) return `${hours} ч.`;
  return `${Math.max(1, Math.round(ms / 60000))} мин.`;
}

/** Всё для панели доступа: ссылки, гости, сколько всего участников в чате. */
export async function accessOverview(wantChat) {
  const chatId = wantChat ? String(wantChat) : shareChatId();
  const invites = listInvites({ chatId }).map((i) => ({
    ...i,
    accessLabel: describeAccess(i.access_ms ? i.access_ms / HOUR : null),
    linkLeft: timeLeft(i.expires_at),
    dead: Boolean(i.expires_at && i.expires_at <= Date.now()),
  }));

  const guests = listGuests({ chatId }).map((g) => ({
    ...g,
    left: timeLeft(g.expires_at),
    expired: Boolean(g.expires_at && g.expires_at <= Date.now()),
  }));

  let members = null;
  if (chatId) members = await getChatMemberCount(chatId).catch(() => null);

  return { chatId, invites, guests, members, presets: ACCESS_PRESETS, targets: shareTargets() };
}

/** Короткая сводка для бота. */
export function accessSummary() {
  const chatId = shareChatId();
  const guests = listGuests({ chatId });
  const invites = listInvites({ chatId });
  const soon = guests.filter((g) => g.expires_at && g.expires_at - Date.now() < 24 * HOUR).length;
  return { guests: guests.length, invites: invites.length, soon, humanSize };
}
