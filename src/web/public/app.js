'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null;
let paths = [];
let poller = null;

/* ── помощники ───────────────────────────────────────────────────────────── */

async function api(path, body) {
  const options = body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({ error: 'сервер ответил непонятно' }));
  if (!res.ok || data.error) throw new Error(data.error || `ошибка ${res.status}`);
  return data;
}

/* ── модальные окна вместо alert / prompt / confirm ──────────────────────── */

let modalResolve = null;

function closeModal(value) {
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
  const resolve = modalResolve;
  modalResolve = null;
  resolve?.(value);
}

/**
 * Одно окно на все случаи: подтверждение, ввод текста, ввод кода.
 * @returns {Promise<any|null>} null — если отменили
 */
function openModal({ title, text = '', icon = null, okText = 'Готово', cancelText = 'Отмена', danger = false, build, collect }) {
  return new Promise((resolve) => {
    modalResolve = resolve;

    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalText').hidden = !text;
    $('#modalIcon').textContent = icon ?? '';
    $('#modalIcon').hidden = !icon;
    $('#modalOk').textContent = okText;
    $('#modalOk').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    $('#modalOk').hidden = !okText;
    $('#modalCancel').textContent = cancelText;
    $('#modalCancel').hidden = !cancelText;

    const body = $('#modalBody');
    body.innerHTML = '';
    // Сначала снимаем блокировку, потом строим тело: build может её вернуть обратно
    $('#modalOk').disabled = false;
    const focusTarget = build?.(body, { setValid: (ok) => { $('#modalOk').disabled = !ok; } });

    $('#modalOk').onclick = () => {
      const value = collect ? collect(body) : true;
      if (value === undefined || value === null || value === false) return;
      closeModal(value);
    };
    $('#modalCancel').onclick = () => closeModal(null);

    $('#modal').hidden = false;
    // Кнопки «Готово» может не быть (список для выбора) — тогда фокус на «Закрыть»
    const fallback = okText ? $('#modalOk') : $('#modalCancel');
    setTimeout(() => (focusTarget ?? fallback).focus?.(), 60);
  });
}

$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(null); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal(null);
});

/** Подтверждение вместо confirm. */
const askConfirm = (opts) => openModal({ okText: 'Да', ...opts });

/** Ввод строки вместо prompt. */
function askText({ title, text, placeholder = '', value = '', okText = 'Готово' }) {
  let input;
  return openModal({
    title,
    text,
    okText,
    build: (body) => {
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.value = value;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#modalOk').click(); });
      body.append(input);
      return input;
    },
    collect: () => input.value.trim() || null,
  });
}

/**
 * Ввод кода по одной цифре, как на телефоне: сам переходит к следующей ячейке,
 * понимает Backspace и вставку кода целиком.
 */
function buildPinField(body, length, onComplete) {
  const wrap = document.createElement('div');
  wrap.className = 'pin';

  const cells = Array.from({ length }, () => {
    const cell = document.createElement('input');
    cell.type = 'text';
    cell.inputMode = 'numeric';
    cell.autocomplete = 'off';
    cell.maxLength = 1;
    wrap.append(cell);
    return cell;
  });

  const value = () => cells.map((c) => c.value).join('');

  cells.forEach((cell, i) => {
    cell.addEventListener('input', () => {
      cell.value = cell.value.replace(/\D/g, '').slice(-1);
      if (cell.value && i < length - 1) cells[i + 1].focus();
      wrap.classList.toggle('filled', value().length === length);
      if (value().length === length) onComplete?.(value());
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !cell.value && i > 0) cells[i - 1].focus();
      if (e.key === 'ArrowLeft' && i > 0) cells[i - 1].focus();
      if (e.key === 'ArrowRight' && i < length - 1) cells[i + 1].focus();
    });
    cell.addEventListener('paste', (e) => {
      e.preventDefault();
      const digits = (e.clipboardData.getData('text') ?? '').replace(/\D/g, '').slice(0, length);
      digits.split('').forEach((d, k) => { cells[k].value = d; });
      cells[Math.min(digits.length, length - 1)].focus();
      wrap.classList.toggle('filled', value().length === length);
      if (value().length === length) onComplete?.(value());
    });
  });

  body.append(wrap);
  return { wrap, cells, value, clear: () => { cells.forEach((c) => { c.value = ''; }); cells[0].focus(); } };
}

/** Ввод пароля — тем же окном, что и PIN, только строкой, а не по цифрам. */
function askPassword({ title, text, okText = 'Готово', minLength = 6 }) {
  let input;
  return openModal({
    title,
    text,
    build: (body, { setValid }) => {
      input = document.createElement('input');
      input.type = 'password';
      input.autocomplete = 'new-password';
      input.placeholder = 'Пароль';

      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = `Минимум ${minLength} символов`;

      setValid(false);
      input.addEventListener('input', () => setValid(input.value.length >= minLength));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.length >= minLength) $('#modalOk').click();
      });

      body.append(input, hint);
      return input;
    },
    okText,
    collect: () => (input.value.length >= minLength ? input.value : null),
  });
}

function askPin({ title, text, length = 4, okText = 'Готово' }) {
  let field;
  return openModal({
    title,
    text,
    okText,
    build: (body) => {
      field = buildPinField(body, length, () => setTimeout(() => $('#modalOk').click(), 120));
      return field.cells[0];
    },
    collect: () => (field.value().length === length ? field.value() : null),
  });
}

/** Опасное действие: чтобы подтвердить, нужно вписать слово — как при удалении репозитория. */
function askDangerous({ title, text, confirmWord, okText = 'Удалить' }) {
  let input;
  return openModal({
    title,
    text,
    icon: '⚠️',
    okText,
    danger: true,
    build: (body, { setValid }) => {
      const label = document.createElement('p');
      label.className = 'hint';
      label.innerHTML = 'Введите <b></b>, чтобы подтвердить:';
      label.querySelector('b').textContent = confirmWord;
      input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      setValid(false);
      input.addEventListener('input', () => setValid(input.value.trim() === confirmWord));
      body.append(label, input);
      return input;
    },
    collect: () => (input.value.trim() === confirmWord ? confirmWord : null),
  });
}

let toastTimer = null;
function toast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function pill(el, status, text) {
  el.className = `pill ${status}`;
  el.textContent = text;
}

async function guard(button, fn) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Секунду…';
  }
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/** Из вставленного куска сообщения достаём то, что нужно: люди копируют вместе с текстом. */
function extract(value, kind) {
  const raw = String(value ?? '').trim();
  if (kind === 'token') return raw.match(/\d{5,}:[A-Za-z0-9_-]{20,}/)?.[0] ?? raw;
  if (kind === 'hash') return raw.match(/\b[a-f0-9]{32}\b/i)?.[0] ?? raw;
  if (kind === 'id') return raw.match(/\d{5,}/)?.[0] ?? raw;
  if (kind === 'chat') return raw.match(/-100\d{6,}/)?.[0] ?? raw;
  return raw;
}

const humanSize = (bytes) => {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};

/* ── навигация ───────────────────────────────────────────────────────────── */

function show(pane) {
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${pane}`));
  $$('#nav button, #navExtra button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.pane === pane)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (pane === 'finish') runChecks();
  if (pane === 'archive') loadArchive();
  if (pane === 'profile') loadProfile();
  if (pane === 'folders') loadDevices();
  if (pane === 'chat') updateCreateAvailability();
  if (pane === 'prefs') renderPreview();
}

$$('#nav button[data-pane], #navExtra button[data-pane]').forEach((b) =>
  b.addEventListener('click', () => show(b.dataset.pane)));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

function markDone(pane, done) {
  const num = $(`#nav button[data-pane="${pane}"] .nav-num`);
  if (!num) return;
  num.classList.toggle('done', done);
  num.textContent = done ? '✓' : num.dataset.n ?? num.textContent;
}

/* ── чипы: показываем имена, а не технические идентификаторы ─────────────── */

/**
 * Кружок с буквой, поверх которого ложится фото, если оно есть.
 * Фото приходит прямо из Telegram и нигде не сохраняется — не загрузилось,
 * значит остаётся буква.
 */
function makeAvatar({ key, letter, photo, className = 'chip-avatar' }) {
  const avatar = document.createElement('span');
  avatar.className = className;
  avatar.style.setProperty('--h', hueOf(key ?? letter ?? '?'));
  avatar.textContent = (letter ?? '?').replace(/^@/, '').slice(0, 1);

  if (photo) {
    const img = document.createElement('img');
    img.src = photo;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    avatar.append(img);
  }
  return avatar;
}

function renderChips(box, items, { empty = 'Пока никого', onRemove } = {}) {
  box.innerHTML = '';
  if (!items.length) {
    const hint = document.createElement('span');
    hint.className = 'chips-empty';
    hint.textContent = empty;
    box.append(hint);
    return;
  }

  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = 'chip-item';
    chip.title = item.title ?? '';

    const avatar = makeAvatar({ key: item.id ?? item.label, letter: item.title ?? item.label, photo: item.photo });

    const text = document.createElement('span');
    text.className = 'chip-text';
    text.textContent = item.label;

    chip.append(avatar, text);

    if (onRemove) {
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = 'Убрать';
      x.addEventListener('click', () => onRemove(item));
      chip.append(x);
    }
    box.append(chip);
  }
}

/** Выбор из списка людей или чатов — вместо ввода числового id. */
function pickFromList({ title, text, items, empty }) {
  return openModal({
    title,
    text,
    okText: '',
    cancelText: 'Закрыть',
    build: (body) => {
      const list = document.createElement('div');
      list.className = 'picker';

      if (!items.length) {
        const none = document.createElement('p');
        none.className = 'hint';
        none.textContent = empty;
        list.append(none);
      }

      for (const item of items) {
        const btn = document.createElement('button');
        const avatar = makeAvatar({ key: item.id ?? item.label, letter: item.label, photo: item.photo });

        const wrap = document.createElement('span');
        const b = document.createElement('b');
        b.textContent = item.label;
        const small = document.createElement('small');
        small.textContent = item.sub ?? '';
        wrap.append(b, small);

        btn.append(avatar, wrap);
        btn.addEventListener('click', () => closeModal(item));
        list.append(btn);
      }
      body.append(list);
      return null;
    },
    collect: () => null,
  });
}

/* ── профили ─────────────────────────────────────────────────────────────── */

/** Цвет кружка выводим из имени — у каждого профиля свой, но всегда один и тот же. */
function hueOf(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

async function switchProfile(name, label) {
  const result = await api('/api/profiles/switch', { name });

  if (result.needsUnlock) {
    showLock({ name, method: result.method, pinLength: result.pinLength, canCode: result.canCode, label });
    return;
  }

  state = result;
  captionSamples = null;
  archiveOffset = 0;
  profileData = null;
  await refresh();
  toast(`Профиль: ${label ?? name}`);
  show('start');
}

function renderProfiles() {
  const list = $('#profileList');
  list.innerHTML = '';

  for (const p of state.profiles ?? []) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'account';
    btn.setAttribute('aria-current', String(p.active));

    const label = p.displayName || (p.name === 'default' ? 'Основной' : p.name);

    const avatar = document.createElement('span');
    avatar.className = 'account-avatar';
    avatarStyle(avatar, { name: p.name, hasAvatar: p.hasAvatar, letter: label });

    const text = document.createElement('span');
    text.className = 'account-text';
    const title = document.createElement('b');
    title.textContent = label;
    const sub = document.createElement('small');
    const marks = [];
    if (p.lock !== 'none') marks.push(p.locked ? '🔒 закрыт' : '🔓 открыт');
    if (!p.configured) marks.push('не настроен');
    else if (p.lastLoginAt) marks.push(`вход ${timeAgo(p.lastLoginAt)}`);
    else marks.push('настроен');
    sub.textContent = marks.join(' · ');
    text.append(title, sub);

    btn.append(avatar, text);

    if (!p.active && p.name !== 'default') {
      const del = document.createElement('span');
      del.className = 'account-del';
      del.textContent = '×';
      del.title = 'Удалить профиль';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        guard(null, () => deleteProfileFlow(p.name, label));
      });
      btn.append(del);
    }

    if (p.active) btn.addEventListener('click', () => show('profile'));
    else btn.addEventListener('click', () => guard(null, () => switchProfile(p.name, label)));
    li.append(btn);
    list.append(li);
  }
}

$('#newProfile').addEventListener('click', () => guard(null, async () => {
  const name = await askText({
    title: 'Новый профиль',
    text: 'У него будут свои бот, группа, аккаунт и архив — от других профилей он полностью отделён.',
    placeholder: 'Например, Маша',
    okText: 'Создать',
  });
  if (!name) return;
  await api('/api/profiles/create', { name });
  await switchProfile(name);
  toast(`Профиль «${name}» создан — настройте его с первого шага`);
  show('bot');
}));

/** Удаление профиля со страховкой: нужно вписать его имя. */
async function deleteProfileFlow(name, label) {
  const confirmed = await askDangerous({
    title: `Удалить профиль «${label}»?`,
    text:
      'Из программы исчезнут его настройки, ключ от аккаунта Telegram и база отправленного. ' +
      'Фото и сообщения в самом Telegram останутся на месте — их программа не трогает. ' +
      'Отменить это будет нельзя.',
    confirmWord: name,
    okText: 'Удалить профиль',
  });
  if (!confirmed) return;

  await api('/api/profiles/delete', { name });
  await refresh();
  toast(`Профиль «${label}» удалён`);
}

/* ── состояние ───────────────────────────────────────────────────────────── */

async function refresh() {
  state = await api('/api/state');
  const s = state.settings;
  renderProfiles();

  if (s.botTokenSet) $('#botToken').placeholder = s.botToken;
  $('#topicYear').checked = s.topicMode === 'year';
  $('#apiId').value = s.apiId || '';
  if (s.apiHashSet) $('#apiHash').placeholder = s.apiHash;
  admins = (s.admins ?? []).map((a) => ({
    id: a.id,
    label: a.username ? `@${a.username}` : a.name,
    title: a.name,
    photo: `/api/user-photo?id=${encodeURIComponent(a.id)}`,
  }));
  renderAdminChips();

  $$('#segSend input').forEach((i) => { i.checked = i.value === (s.sendAsDocument ? 'doc' : 'feed'); });
  $$('#segLive input').forEach((i) => { i.checked = i.value === s.livePhotoVideos; });
  $$('#segCaption input').forEach((i) => { i.checked = i.value === s.captionStyle; });
  $('#keepHeic').checked = s.keepHeicOriginal;

  applyStyle(state.style);
  paths = [...s.scanPaths];
  renderPaths();

  renderChatChip();
  markDone('bot', s.botTokenSet);
  markDone('chat', Boolean(s.chatId));
  markDone('account', s.sessionSet);
  markDone('folders', paths.length > 0);
  markDone('prefs', state.envExists);

  if (s.botTokenSet) pill($('#botStatus'), '', 'бот подключён');
  if (s.chatId) pill($('#chatStatus'), '', s.chatTitle ? `группа «${s.chatTitle}»` : 'группа выбрана');
  if (s.sessionSet) pill($('#accountStatus'), 'ok', 'аккаунт подключён');
  if (paths.length) pill($('#pathStatus'), 'ok', `папок: ${paths.length}`);

  renderBot();
  updateCreateAvailability();
}

/* ── бот: слушает команды с телефона ─────────────────────────────────────── */

/**
 * Бот включается сам вместе с мастером — отдельную команду в терминале
 * запускать не нужно. Здесь только видно, работает он или нет.
 */
function renderBot() {
  const bot = state?.bot ?? { running: false };
  const s = state?.settings ?? {};
  const ready = Boolean(s.botTokenSet && (s.admins ?? []).length);

  const toggle = $('#botToggle');
  toggle.textContent = bot.running ? 'Выключить' : 'Включить';
  toggle.disabled = !ready;
  toggle.dataset.action = bot.running ? 'stop' : 'start';

  if (bot.running) {
    pill($('#botPill'), 'ok', 'на связи');
    $('#botText').textContent =
      'Бот уже написал вам в Telegram — командуйте оттуда: /send, /status, /random. ' +
      'Слушает, пока открыта эта программа.';
    return;
  }

  pill($('#botPill'), ready ? '' : 'warn', ready ? 'выключен' : 'не готов');
  $('#botText').textContent = ready
    ? 'Включите — и командуйте архивом из Telegram, не подходя к компьютеру'
    : bot.error
      ? `Не запустился: ${bot.error}`
      : !s.botTokenSet
        ? 'Сначала подключите бота на шаге 2'
        : 'Сначала укажите на шаге 6, кто может им командовать';
}

$('#botToggle').addEventListener('click', (e) => guard(e.target, async () => {
  const stopping = e.target.dataset.action === 'stop';
  await api(stopping ? '/api/bot/stop' : '/api/bot/start', {});
  await refresh();
  toast(stopping ? 'Бот выключен' : 'Бот на связи — посмотрите Telegram');
}));

/* ── шаг 1: бот ──────────────────────────────────────────────────────────── */

$('#saveBot').addEventListener('click', (e) => guard(e.target, async () => {
  const token = extract($('#botToken').value, 'token');
  if (!token && !state?.settings.botTokenSet) throw new Error('Вставьте токен от @BotFather');
  if (token) await api('/api/settings', { TELEGRAM_BOT_TOKEN: token });

  const checks = await api('/api/checks', {});
  if (checks.bot?.ok) {
    pill($('#botStatus'), 'ok', `@${checks.bot.username}`);
    toast(`Бот @${checks.bot.username} на связи`);
    $('#botToken').value = '';
    await refresh();
  } else {
    pill($('#botStatus'), 'err', 'токен не подошёл');
    throw new Error(checks.bot?.problem ?? 'Telegram не принял этот токен — скопируйте его целиком');
  }
}));

/* ── шаг 2: канал ────────────────────────────────────────────────────────── */

function renderChatChip() {
  const s = state?.settings ?? {};
  const items = s.chatId
    ? [{ id: s.chatId, label: s.chatTitle || 'Группа выбрана', title: 'Подключённая группа' }]
    : [];
  renderChips($('#chatChips'), items, { empty: 'Группа ещё не выбрана' });
}

function selectChatOption(mode) {
  $('#optionCreate').setAttribute('aria-pressed', String(mode === 'create'));
  $('#optionExisting').setAttribute('aria-pressed', String(mode === 'existing'));
  $('#createBlock').hidden = mode !== 'create';
  $('#existingBlock').hidden = mode !== 'existing';
}

$('#optionCreate').addEventListener('click', () => selectChatOption('create'));
$('#optionExisting').addEventListener('click', () => selectChatOption('existing'));

function updateCreateAvailability() {
  const ready = Boolean(state?.settings.sessionSet);
  $('#createGroup').disabled = !ready;
  $('#needAccount').hidden = ready;
  $('#createHint').textContent = ready
    ? 'Программа создаст приватную группу, включит темы и сделает бота администратором'
    : 'Нужен вход в аккаунт — у ботов нет права создавать группы';
}

$('#createGroup').addEventListener('click', (e) => guard(e.target, async () => {
  const title = $('#groupTitle').value.trim() || 'Мой фотоархив';
  const topics = $('#groupTopics').checked;

  const created = await api('/api/create-group', { title, topics });
  $('#topicYear').checked = created.isForum && topics;

  pill($('#chatStatus'), 'ok', `${created.title}${created.isForum ? ' · с темами' : ''}`);
  toast(created.isForum ? 'Группа создана, темы включены, бот добавлен' : 'Группа создана, бот добавлен');
  for (const w of created.warnings ?? []) toast(w, true);

  await refresh();
  updateCreateAvailability();
}));

$('#detectChat').addEventListener('click', (e) => guard(e.target, async () => {
  const { chats } = await api('/api/detect-chats', {});

  const picked = await pickFromList({
    title: 'Ваши группы и каналы',
    text: 'Показываю то, куда добавлен ваш бот. Если нужного нет — напишите там любое сообщение и откройте список снова.',
    items: chats.map((chat) => ({
      id: chat.id,
      label: chat.title,
      sub: [chat.type === 'channel' ? 'канал' : 'группа', chat.isForum ? 'с темами' : null].filter(Boolean).join(' · '),
      photo: chat.photo ? `/api/thumb?file=${encodeURIComponent(chat.photo)}` : null,
      isForum: chat.isForum,
    })),
    empty: 'Пока ничего не вижу. Добавьте бота администратором в группу, напишите там любое сообщение и попробуйте снова.',
  });

  if (!picked) return;

  await api('/api/settings', {
    TELEGRAM_CHAT_ID: picked.id,
    TOPIC_MODE: picked.isForum && $('#topicYear').checked ? 'year' : 'none',
  });
  await refresh();
  toast(`Выбрана «${picked.label}»`);
  await checkChat();
}));

async function checkChat() {
  const checks = await api('/api/checks', {});
  if (checks.chat?.ok) {
    pill($('#chatStatus'), 'ok', checks.chat.title);
    await refresh();
    if ($('#topicYear').checked && !checks.chat.isForum) {
      pill($('#chatStatus'), 'warn', 'темы не включены');
      throw new Error('В этой группе не включены темы. Включите их в настройках группы или выключите папки по годам');
    }
    toast(`«${checks.chat.title}» готова принимать файлы`);
  } else {
    pill($('#chatStatus'), 'err', 'нет доступа');
    throw new Error(checks.chat?.problem ?? 'Группа не найдена. Проверьте, что бот добавлен администратором');
  }
}

$('#saveChat').addEventListener('click', (e) => guard(e.target, async () => {
  if (!state?.settings.chatId) throw new Error('Сначала создайте группу или выберите готовую');
  await api('/api/settings', { TOPIC_MODE: $('#topicYear').checked ? 'year' : 'none' });
  await checkChat();
}));

$('#topicYear').addEventListener('change', () => guard(null, async () => {
  await api('/api/settings', { TOPIC_MODE: $('#topicYear').checked ? 'year' : 'none' });
}));

/* ── шаг 3: аккаунт ──────────────────────────────────────────────────────── */

let loginPoll = null;

function renderLogin(login) {
  $('#codeBox').hidden = login.stage !== 'code';
  $('#passBox').hidden = login.stage !== 'password';

  if (login.stage === 'code') pill($('#accountStatus'), 'warn', 'ждём код');
  else if (login.stage === 'password') pill($('#accountStatus'), 'warn', 'ждём пароль');
  else if (login.stage === 'done') {
    pill($('#accountStatus'), 'ok', login.user?.name || 'вход выполнен');
    clearInterval(loginPoll);
    loginPoll = null;
    toast('Аккаунт подключён — большие файлы теперь тоже уйдут');
    refresh();
  } else if (login.stage === 'error') {
    pill($('#accountStatus'), 'err', 'не вышло');
    clearInterval(loginPoll);
    loginPoll = null;
    toast(login.error ?? 'вход не удался', true);
  }
  if (login.error && login.stage !== 'error') toast(login.error, true);
}

$('#loginStart').addEventListener('click', (e) => guard(e.target, async () => {
  const apiId = extract($('#apiId').value, 'id');
  const apiHash = extract($('#apiHash').value, 'hash');
  const phone = $('#phone').value.trim();

  if (!apiId) throw new Error('Нужен api_id с my.telegram.org');
  if (!apiHash && !state?.settings.apiHashSet) throw new Error('Нужен api_hash с my.telegram.org');
  if (!phone) throw new Error('Укажите номер телефона в формате +79991234567');

  const login = await api('/api/login/start', { apiId, apiHash, phone });
  renderLogin(login);

  clearInterval(loginPoll);
  loginPoll = setInterval(async () => {
    try {
      renderLogin(await api('/api/login/state'));
    } catch {
      /* сервер перезапускается — попробуем в следующий раз */
    }
  }, 1500);
}));

$('#sendCode').addEventListener('click', (e) => guard(e.target, async () => {
  const code = $('#code').value.trim();
  if (!code) throw new Error('Введите код из Telegram');
  renderLogin(await api('/api/login/code', { code }));
}));

$('#sendPass').addEventListener('click', (e) => guard(e.target, async () => {
  const password = $('#pass').value;
  if (!password) throw new Error('Введите облачный пароль');
  renderLogin(await api('/api/login/password', { password }));
}));

/* ── шаг 4: папки ────────────────────────────────────────────────────────── */

function renderPaths() {
  const list = $('#pathList');
  list.innerHTML = '';
  if (!paths.length) {
    list.innerHTML = '<p class="hint" style="margin:0">Пока ничего не выбрано.</p>';
    return;
  }
  for (const p of paths) {
    const row = document.createElement('div');
    row.className = 'pathitem';
    const span = document.createElement('span');
    span.className = 'mono';
    span.textContent = p;
    const del = document.createElement('button');
    del.className = 'btn btn-danger';
    del.textContent = 'Убрать';
    del.addEventListener('click', () => {
      paths = paths.filter((x) => x !== p);
      renderPaths();
      guard(null, savePaths);
    });
    row.append(span, del);
    list.append(row);
  }
}

function addPath(p) {
  if (!paths.includes(p)) paths.push(p);
  renderPaths();
  toast(`Добавлено: ${p}`);
  guard(null, savePaths);
}

async function loadDevices() {
  const { mounts, phones, hint } = await api('/api/devices');
  const box = $('#disks');
  box.innerHTML = '';

  const group = document.createElement('div');
  group.className = 'group';

  for (const phone of phones ?? []) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row-label"><b></b><small></small></div>';
    row.querySelector('b').textContent = phone.name;
    row.querySelector('small').textContent =
      phone.kind === 'android' ? 'Android подключён по кабелю' : 'iPhone подключён по кабелю';
    group.append(row);
  }

  for (const m of mounts) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row-label"><b class="mono"></b><small></small></div>';
    row.querySelector('b').textContent = m.path;
    row.querySelector('small').textContent = m.looksLikeIPhone
      ? 'похоже на iPhone'
      : m.looksLikeAndroid
        ? 'похоже на Android'
        : m.hasDcim
          ? 'есть папка DCIM'
          : 'диск или папка';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Выбрать';
    btn.addEventListener('click', () => {
      addPath(m.dcimPath ?? m.path);
      // На Android снимки из мессенджеров и скриншоты лежат вне DCIM
      for (const extra of m.extraPaths ?? []) addPath(extra);
    });
    row.append(btn);
    group.append(row);
  }

  if (!mounts.length && !ios.length) {
    group.innerHTML = '<div class="row"><div class="row-label"><b>Ничего не нашлось</b><small>Подключите диск или iPhone и нажмите ещё раз</small></div></div>';
  }
  box.append(group);

  if (hint) {
    const note = document.createElement('div');
    note.className = 'note';
    note.innerHTML = '<b>Как подключить телефон</b><span class="prewrap"></span>';
    note.querySelector('.prewrap').textContent = hint;
    box.append(note);
  }
}

$('#findDisks').addEventListener('click', (e) => guard(e.target, loadDevices));

async function browseTo(target) {
  const data = await api('/api/browse', { path: target });
  $('#browser').hidden = false;
  $('#browserPath').textContent = data.path;
  $('#browserUp').disabled = !data.parent;
  $('#browserUp').onclick = () => guard(null, () => browseTo(data.parent));
  $('#browserPick').onclick = () => {
    addPath(data.path);
    $('#browser').hidden = true;
  };

  const list = $('#browserList');
  list.innerHTML = '';
  for (const dir of data.dirs) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cursor = 'pointer';
    row.innerHTML = '<div class="row-label"><b></b></div><span class="hint" style="margin:0">открыть ›</span>';
    row.querySelector('b').textContent = dir.name;
    row.addEventListener('click', () => guard(null, () => browseTo(dir.path)));
    list.append(row);
  }
  if (!data.dirs.length) {
    list.innerHTML = '<div class="row"><div class="row-label"><small>Внутри нет вложенных папок — можно выбрать эту</small></div></div>';
  }
}

$('#addPath').addEventListener('click', (e) => guard(e.target, () => browseTo(null)));

/** Папки сохраняются сразу — отдельной кнопки «Сохранить» нет. */
async function savePaths() {
  await api('/api/settings', { SCAN_PATHS: paths.join(',') });
  pill($('#pathStatus'), paths.length ? 'ok' : '', paths.length ? `сохранено, папок: ${paths.length}` : 'папки не выбраны');
}

/* ── шаг 5: настройки ────────────────────────────────────────────────────── */

/** Настройки применяются сразу, как в системных настройках. */
async function savePrefs() {
  pill($('#prefsStatus'), '', 'сохраняю…');
  await api('/api/settings', {
    SEND_AS_DOCUMENT: String($('#segSend input:checked').value === 'doc'),
    KEEP_HEIC_ORIGINAL: String($('#keepHeic').checked),
    LIVE_PHOTO_VIDEOS: $('#segLive input:checked').value,
    CAPTION_STYLE: $('#segCaption input:checked').value,
  });
  pill($('#prefsStatus'), 'ok', 'сохранено');
  renderPreview();
}

let prefsTimer = null;
function schedulePrefsSave() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => guard(null, savePrefs), 350);
}

$$('#segSend input, #segLive input, #segCaption input, #keepHeic').forEach((el) =>
  el.addEventListener('change', schedulePrefsSave));


let admins = [];

function renderAdminChips() {
  renderChips($('#adminChips'), admins, {
    empty: 'Пока никто — командовать ботом сможете только из программы',
    onRemove: (item) => {
      admins = admins.filter((a) => a.id !== item.id);
      renderAdminChips();
      guard(null, saveAdmins);
    },
  });
}

async function saveAdmins() {
  await api('/api/settings', { TELEGRAM_ADMIN_IDS: admins.map((a) => a.id).join(',') });
  pill($('#prefsStatus'), 'ok', 'сохранено');
}

$('#detectOwner').addEventListener('click', (e) => guard(e.target, async () => {
  const { owners } = await api('/api/detect-owner', {});
  const source = {
    account: 'ваш аккаунт',
    group: 'участник группы',
    bot: 'писал вашему боту',
    known: 'писал боту раньше',
  };

  const candidates = owners
    .filter((o) => !admins.some((a) => a.id === o.id))
    .map((o) => ({
      id: o.id,
      label: o.username ? `@${o.username}` : o.name,
      username: o.username ?? null,
      name: o.name,
      sub: [o.username ? o.name : null, source[o.source]].filter(Boolean).join(' · '),
      photo: `/api/user-photo?id=${encodeURIComponent(o.id)}`,
    }));

  const picked = await pickFromList({
    title: 'Кто может командовать ботом',
    text: 'Участники вашей группы и те, кто писал боту. Если нужного человека нет — попросите его написать боту любое сообщение и откройте список снова.',
    items: candidates,
    empty: 'Пока никого не нашлось. Попросите человека написать вашему боту любое сообщение и попробуйте ещё раз.',
  });

  if (!picked) return;
  admins.push({
    id: picked.id,
    label: picked.username ? `@${picked.username}` : picked.name,
    title: picked.name,
    photo: picked.photo,
  });
  renderAdminChips();
  await saveAdmins();
  toast(`${picked.name} теперь может командовать ботом`);
}));

/* ── превью подписи ──────────────────────────────────────────────────────── */

let captionSamples = null;

async function renderPreview() {
  try {
    captionSamples ??= await api('/api/caption-preview');
  } catch {
    return;
  }
  const style = $('#segCaption input:checked')?.value ?? 'pretty';
  const kind = $('#segPreviewKind input:checked')?.value ?? 'photo';
  const sample = captionSamples[style]?.[kind];
  if (!sample) return;

  const box = $('#captionPreview');
  // Текст сгенерирован программой из образца, посторонних данных в нём нет
  if (sample.parseMode === 'HTML') box.innerHTML = sample.text;
  else box.textContent = sample.text;

  $('.bubble-photo').textContent = kind === 'video' ? '🎬' : kind === 'live' ? '🌀' : '🏔';
}

$$('#segCaption input, #segPreviewKind input').forEach((i) => i.addEventListener('change', renderPreview));

/* ── профиль: оформление, аккаунт, защита ────────────────────────────────── */

const ACCENTS = ['#007aff', '#34c759', '#ff9500', '#ff2d55', '#af52de', '#5856d6', '#00c7be', '#8e8e93'];

// Готовые фоны — мягкие градиенты, чтобы текст поверх оставался читаемым
const WALLPAPERS = [
  { id: 'dawn', css: 'linear-gradient(160deg, #ffd7a8, #ffb3c1 55%, #c9a7ff)' },
  { id: 'ocean', css: 'linear-gradient(160deg, #a8d8ff, #7fb4e8 60%, #5f8fd0)' },
  { id: 'mint', css: 'linear-gradient(160deg, #c7f0d8, #9fdcc0 60%, #74c7a8)' },
  { id: 'sand', css: 'linear-gradient(160deg, #f3e2c7, #e2c9a0 60%, #cbb089)' },
  { id: 'dusk', css: 'linear-gradient(160deg, #6a7ba8, #4a5578 60%, #2f364f)' },
  { id: 'graphite', css: 'linear-gradient(160deg, #3a3a3c, #2c2c2e 60%, #1c1c1e)' },
];

/** Тема, цвет и фон — свои у каждого профиля, применяются ко всей странице. */
function applyStyle(style) {
  if (!style) return;
  document.documentElement.style.setProperty('--accent', style.accent || '#007aff');
  if (style.theme === 'light' || style.theme === 'dark') {
    document.documentElement.dataset.theme = style.theme;
  } else {
    delete document.documentElement.dataset.theme;
  }

  const content = $('.content');
  const wall = style.wallpaper ?? { type: 'none' };
  if (wall.type === 'preset') {
    const preset = WALLPAPERS.find((w) => w.id === wall.value);
    content.style.setProperty('--wallpaper', preset?.css ?? 'none');
    content.classList.toggle('has-wallpaper', Boolean(preset));
  } else if (wall.type === 'custom') {
    content.style.setProperty('--wallpaper', `url(/api/wallpaper?name=${encodeURIComponent(state?.profile ?? '')}&v=${Date.now()})`);
    content.classList.add('has-wallpaper');
  } else {
    content.classList.remove('has-wallpaper');
  }
}

function renderWallpapers(current = { type: 'none' }) {
  const box = $('#wallpapers');
  box.innerHTML = '';

  const none = document.createElement('button');
  none.className = 'wall none';
  none.textContent = '✕';
  none.title = 'Без фона';
  none.setAttribute('aria-pressed', String(current.type === 'none'));
  none.addEventListener('click', () => guard(null, () => setWallpaper({ type: 'none' })));
  box.append(none);

  for (const w of WALLPAPERS) {
    const btn = document.createElement('button');
    btn.className = 'wall';
    btn.style.background = w.css;
    btn.setAttribute('aria-pressed', String(current.type === 'preset' && current.value === w.id));
    btn.addEventListener('click', () => guard(null, () => setWallpaper({ type: 'preset', value: w.id })));
    box.append(btn);
  }

  if (current.type === 'custom') {
    const own = document.createElement('button');
    own.className = 'wall';
    own.style.backgroundImage = `url(/api/wallpaper?name=${encodeURIComponent(state?.profile ?? '')}&v=${Date.now()})`;
    own.setAttribute('aria-pressed', 'true');
    own.title = 'Ваша картинка';
    box.append(own);
  }
}

async function setWallpaper(payload) {
  const { wallpaper } = await api('/api/profile/wallpaper', payload);
  applyStyle({ ...(state?.style ?? {}), wallpaper });
  if (state) state.style = { ...(state.style ?? {}), wallpaper };
  renderWallpapers(wallpaper);
}

$('#pickWallpaper').addEventListener('click', () => $('#wallpaperInput').click());
$('#wallpaperInput').addEventListener('change', () => guard(null, async () => {
  const file = $('#wallpaperInput').files?.[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  await setWallpaper({ type: 'custom', dataUrl });
  $('#wallpaperInput').value = '';
  toast('Фон обновлён');
}));

function avatarStyle(el, { name, hasAvatar, letter }) {
  el.style.setProperty('--h', hueOf(name));
  if (hasAvatar) {
    el.style.backgroundImage = `url(/api/avatar?name=${encodeURIComponent(name)}&v=${Date.now()})`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = (letter || name || '?').slice(0, 1);
  }
}

const timeAgo = (ms) => {
  if (!ms) return 'ещё ни разу';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  return new Date(ms).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
};

let profileData = null;

async function loadProfile() {
  profileData = await api('/api/profile');
  const p = profileData;
  // Вход есть — значит обновлять есть откуда, даже если имя ещё не подтянуто
  const connected = Boolean(p.accountConnected);
  const known = p.telegram;
  const label = p.displayName || known?.name || (p.name === 'default' ? 'Основной' : p.name);

  avatarStyle($('#profileAvatar'), { name: p.name, hasAvatar: p.hasAvatar, letter: label });
  $('#profileTitle').textContent = label;
  $('#profileSub').textContent = known?.username
    ? `@${known.username}`
    : connected ? 'Аккаунт Telegram подключён' : 'Аккаунт Telegram не подключён';
  $('#profileLast').textContent = `Последний вход: ${timeAgo(p.lastLoginAt)}`;

  // Пока аккаунт не подключён, обновлять нечего — ведём на шаг входа
  $('#refreshTelegram').textContent = connected ? 'Обновить из Telegram' : 'Войти в свой Telegram';
  $('#tgWho').textContent = !connected
    ? 'Никто — большие файлы отправляться не будут'
    : known
      ? [known.username ? `@${known.username}` : known.name, known.premium ? 'Premium' : null]
          .filter(Boolean).join(' · ')
      : 'Вход выполнен — нажмите «Обновить из Telegram», чтобы увидеть кто';
  $('#goAccount').hidden = connected;

  $('#displayName').value = p.displayName ?? '';
  $$('#segTheme input').forEach((i) => { i.checked = i.value === p.theme; });
  $$('#segLock input').forEach((i) => { i.checked = i.value === p.lock.type; });
  $('#autoLock').value = p.lock.autoLockMinutes ?? 30;
  $('#tgLimit').textContent = !connected
    ? 'до 50 МБ, пока не подключён аккаунт'
    : known?.premium
      ? 'до 4 ГБ — у аккаунта есть Premium'
      : 'до 2 ГБ (с Telegram Premium стало бы 4 ГБ)';

  renderSwatches(p.accent);
  renderWallpapers(p.wallpaper ?? { type: 'none' });
  updateLockRow();
}

function renderSwatches(active) {
  const box = $('#accentSwatches');
  box.innerHTML = '';
  for (const color of ACCENTS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = color;
    b.setAttribute('aria-pressed', String(color === active));
    b.title = color;
    b.addEventListener('click', () => guard(null, async () => {
      const saved = await api('/api/profile', { accent: color });
      applyStyle(saved);
      renderSwatches(saved.accent);
      await refresh();
    }));
    box.append(b);
  }
}

function updateLockRow() {
  const type = $('#segLock input:checked')?.value ?? 'none';
  $('#pinLengthRow').hidden = type !== 'pin';
  $('#saveLock').textContent = type === 'none' ? 'Выключить защиту' : 'Придумать и включить';
  $('#lockHint').textContent = type === 'telegram'
    ? (profileData?.canUseTelegramCode
        ? 'Код будет приходить вашему боту в личку'
        : 'Нужны бот и ваш id в списке владельцев — иначе код прислать некуда')
    : type === 'none'
      ? 'Профиль будет открываться сразу'
      : 'Забудете — можно будет войти по коду из Telegram';
}

$$('#segLock input').forEach((i) => i.addEventListener('change', updateLockRow));

$('#displayName').addEventListener('input', () => {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => guard(null, async () => {
    await api('/api/profile', { displayName: $('#displayName').value });
    await refresh();
  }), 400);
});

$$('#segTheme input').forEach((i) => i.addEventListener('change', () => guard(null, async () => {
  applyStyle(await api('/api/profile', { theme: i.value }));
})));

$('#goAccount').addEventListener('click', () => show('account'));

$('#refreshTelegram').addEventListener('click', (e) => guard(e.target, async () => {
  if (!profileData?.accountConnected) {
    show('account');
    toast('Войдите в аккаунт — это шаг 3');
    return;
  }
  await api('/api/profile/refresh-telegram', {});
  await loadProfile();
  await refresh();
  toast('Имя и аватар взяты из Telegram');
}));

$('#pickAvatar').addEventListener('click', () => $('#avatarInput').click());
$('#avatarInput').addEventListener('change', () => guard(null, async () => {
  const file = $('#avatarInput').files?.[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  await api('/api/profile/avatar', { dataUrl });
  $('#avatarInput').value = '';
  await loadProfile();
  await refresh();
  toast('Картинка профиля обновлена');
}));

$('#saveLock').addEventListener('click', (e) => guard(e.target, async () => {
  const type = $('#segLock input:checked').value;
  let secret = '';

  if (type === 'pin') {
    const length = Number($('#pinLength input:checked')?.value) || 4;
    const word = length === 4 ? 'Четыре цифры' : 'Шесть цифр';
    const first = await askPin({ title: 'Придумайте PIN', text: `${word} — их нужно будет вводить при входе в профиль`, length });
    if (!first) return;
    const again = await askPin({ title: 'Повторите PIN', length });
    if (!again) return;
    if (first !== again) throw new Error('PIN не совпал — попробуйте ещё раз');
    secret = first;
  } else if (type === 'password') {
    const first = await askPassword({
      title: 'Придумайте пароль',
      text: 'Его нужно будет вводить при входе в профиль. Забудете — войдёте по коду из Telegram.',
    });
    if (!first) return;
    const again = await askPassword({ title: 'Повторите пароль', okText: 'Включить защиту' });
    if (!again) return;
    if (first !== again) throw new Error('Пароль не совпал — попробуйте ещё раз');
    secret = first;
  }

  await api('/api/profile/lock', { type, secret, autoLockMinutes: Number($('#autoLock').value) || 30 });
  await loadProfile();
  await refresh();
  toast(type === 'none' ? 'Защита выключена' : 'Защита включена');
}));

$('#lockNow').addEventListener('click', (e) => guard(e.target, async () => {
  const { locked } = await api('/api/profiles/lock-now', {});
  if (!locked) {
    show('profile');
    throw new Error('У профиля нет защиты — сначала включите PIN, пароль или код');
  }

  // Показываем экран замка сразу: с него можно и войти обратно, и уйти в другой профиль
  const me = state.profiles.find((p) => p.active);
  showLock({
    name: state.profile,
    method: me?.lock ?? 'pin',
    pinLength: me?.pinLength ?? 4,
    canCode: true,
    label: me?.displayName,
  });
}));

$('#logoutTelegram').addEventListener('click', (e) => guard(e.target, async () => {
  const ok = await askConfirm({
    title: 'Отключить аккаунт Telegram?',
    text: 'Программа забудет ключ от аккаунта: файлы больше 50 МБ отправляться перестанут, пока не войдёте снова. Архив, настройки и сам аккаунт останутся целыми.',
    icon: '🔌',
    okText: 'Отключить',
    danger: true,
  });
  if (!ok) return;

  await api('/api/profile/logout-telegram', {});
  await loadProfile();
  await refresh();
  toast('Аккаунт отключён');
}));

$('#deleteProfile').addEventListener('click', (e) => guard(e.target, async () => {
  const label = profileData?.displayName || (state.profile === 'default' ? 'Основной' : state.profile);
  if (state.profile === 'default') {
    throw new Error('Основной профиль удалить нельзя — можно отключить аккаунт или удалить другие профили');
  }
  // Переключаемся на основной, иначе удалять активный профиль нельзя
  const target = state.profile;
  await switchProfile('default', 'Основной');
  await deleteProfileFlow(target, label);
}));

/* ── экран замка ─────────────────────────────────────────────────────────── */

let lockTarget = null;

let lockField = null;

function showLock({ name, method, pinLength = 4, canCode, label }) {
  lockTarget = { name, method, pinLength, canCode };
  $('#lockscreen').hidden = false;

  const profile = state?.profiles?.find((p) => p.name === name);
  const title = label || profile?.displayName || (name === 'default' ? 'Основной' : name);

  avatarStyle($('#lockAvatar'), { name, hasAvatar: profile?.hasAvatar ?? false, letter: title });
  $('#lockTitle').textContent = title;
  $('#lockSub').textContent = method === 'telegram'
    ? 'Нажмите «Прислать код» — он придёт вам в Telegram'
    : method === 'password' ? 'Введите пароль' : 'Введите PIN';

  const field = $('#lockField');
  field.innerHTML = '';

  if (method === 'password') {
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Пароль';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(null, submitUnlock); });
    field.append(input);
    lockField = { value: () => input.value.trim(), clear: () => { input.value = ''; input.focus(); }, focus: () => input.focus() };
  } else {
    // PIN и код из Telegram вводим по одной цифре
    const length = method === 'telegram' ? 6 : pinLength;
    const pin = buildPinField(field, length, () => setTimeout(() => guard(null, submitUnlock), 120));
    lockField = { ...pin, focus: () => pin.cells[0].focus() };
  }

  $('#lockCode').hidden = !(canCode || method === 'telegram');
  $('#lockNote').textContent = method === 'telegram' ? '' : 'Забыли? Можно войти по коду из Telegram';

  renderLockProfiles(name);
  setTimeout(() => lockField.focus(), 60);
}

/**
 * Рядом с полем ввода — остальные профили. Закрыли свой и хотите зайти в чужой
 * или завести новый: не нужно сначала открывать закрытый.
 */
function renderLockProfiles(current) {
  const box = $('#lockOthers');
  const list = $('#lockProfiles');
  list.innerHTML = '';

  const others = (state?.profiles ?? []).filter((p) => p.name !== current);
  box.hidden = false;
  $('#lockSepText').textContent = others.length ? 'или войдите в другой профиль' : 'или заведите ещё один профиль';

  for (const p of others) {
    const label = p.displayName || (p.name === 'default' ? 'Основной' : p.name);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'account';

    const avatar = document.createElement('span');
    avatar.className = 'account-avatar';
    avatarStyle(avatar, { name: p.name, hasAvatar: p.hasAvatar, letter: label });

    const text = document.createElement('span');
    text.className = 'account-text';
    const title = document.createElement('b');
    title.textContent = label;
    const sub = document.createElement('small');
    sub.textContent = p.lock === 'none' ? 'открыт' : p.locked ? '🔒 спросит код' : '🔓 открыт';
    text.append(title, sub);

    btn.append(avatar, text);
    btn.addEventListener('click', () => guard(btn, () => switchFromLock(p, label)));
    li.append(btn);
    list.append(li);
  }
}

/** Переход в другой профиль прямо с экрана замка. */
async function switchFromLock(profile, label) {
  const res = await api('/api/profiles/switch', { name: profile.name });
  if (res.needsUnlock) {
    // У соседа тоже замок — просто перерисовываем экран под него
    showLock({
      name: res.name,
      method: res.method,
      pinLength: res.pinLength,
      canCode: res.canCode,
      label,
    });
    return;
  }

  state = res;
  hideLock();
  captionSamples = null;
  archiveOffset = 0;
  profileData = null;
  await refresh();
  toast(`Профиль: ${label}`);
  show('start');
}

function hideLock() {
  lockTarget = null;
  lockField = null;
  $('#lockscreen').hidden = true;
}

async function submitUnlock() {
  const value = lockField?.value() ?? '';
  if (!value) throw new Error('Введите код');

  const body = lockTarget.method === 'telegram' || lockTarget.codeSent
    ? { name: lockTarget.name, code: value }
    : { name: lockTarget.name, secret: value };

  try {
    state = await api('/api/profiles/unlock', body);
  } catch (err) {
    // Неверный код: тряхнём поле и дадим ввести заново
    const wrap = $('#lockField .pin');
    if (wrap) {
      wrap.classList.add('shake');
      setTimeout(() => wrap.classList.remove('shake'), 400);
    }
    lockField.clear();
    throw err;
  }

  hideLock();
  captionSamples = null;
  await refresh();
  toast('Добро пожаловать');
  show('start');
}

$('#lockNewProfile').addEventListener('click', (e) => guard(e.target, async () => {
  const name = await askText({
    title: 'Новый профиль',
    text: 'У него будут свои бот, группа, аккаунт и архив — от других профилей он полностью отделён.',
    placeholder: 'Например, Маша',
    okText: 'Создать',
  });
  if (!name) return;

  const { profiles } = await api('/api/profiles/create', { name });
  state = { ...state, profiles: profiles ?? state.profiles };
  await switchFromLock({ name, lock: 'none', locked: false }, name);
  toast(`Профиль «${name}» создан — настройте его с первого шага`);
  show('bot');
}));

$('#lockUnlock').addEventListener('click', (e) => guard(e.target, submitUnlock));

$('#lockCode').addEventListener('click', (e) => guard(e.target, async () => {
  const res = await api('/api/profiles/request-code', { name: lockTarget.name });
  lockTarget.codeSent = true;
  showLock({ ...lockTarget, method: 'telegram', label: $('#lockTitle').textContent });
  lockTarget.codeSent = true;
  $('#lockSub').textContent = 'Введите код из Telegram';
  $('#lockNote').textContent = `Код отправлен (${res.sentTo}), действует 5 минут`;
  toast('Код отправлен в Telegram');
}));

/* ── база отправленного ──────────────────────────────────────────────────── */

let archiveOffset = 0;
let archiveTotal = 0;

function statusBadge(status) {
  const map = { sent: ['ok', 'в архиве'], failed: ['err', 'ошибка'], skipped: ['warn', 'пропущен'], pending: ['', 'в очереди'] };
  return map[status] ?? ['', status];
}

const KIND_ICON = { photo: '🖼', video: '🎬', document: '📄', live_photo: '🌀' };

/** Миниатюру не храним у себя — её отдаёт Telegram по сохранённому идентификатору. */
function thumbFor(r, big = false) {
  if (r.thumb_file_id) {
    const img = document.createElement('img');
    img.className = big ? '' : 'thumb';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = `/api/thumb?file=${encodeURIComponent(r.thumb_file_id)}`;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(fallbackThumb(r, big)));
    return img;
  }
  return fallbackThumb(r, big);
}

function fallbackThumb(r, big) {
  const box = document.createElement('span');
  box.className = big ? 'grid-fallback' : 'thumb';
  box.textContent = KIND_ICON[r.file_type] ?? KIND_ICON[r.kind] ?? '🖼';
  return box;
}

function appendArchiveGrid(rows) {
  const box = $('#archiveRows');
  for (const r of rows) {
    const cell = r.link ? document.createElement('a') : document.createElement('div');
    cell.className = 'grid-cell';
    if (r.link) {
      cell.href = r.link;
      cell.target = '_blank';
      cell.rel = 'noopener';
    }
    cell.title = r.rel_path || r.name;
    cell.append(thumbFor(r, true));

    const caption = document.createElement('span');
    caption.className = 'grid-caption';
    caption.textContent = r.taken_at
      ? new Date(r.taken_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' })
      : r.name;
    cell.append(caption);
    box.append(cell);
  }
}

function appendArchiveRows(rows) {
  if ($('#segArchiveView input:checked')?.value === 'grid') {
    appendArchiveGrid(rows);
    archiveOffset += rows.length;
    updateArchiveFooter();
    return;
  }

  const box = $('#archiveRows');
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row-label"><b></b><small></small></div><span class="pill"></span>';
    row.prepend(thumbFor(r));

    const title = row.querySelector('b');
    if (r.link) {
      // Ссылка строится из уже сохранённых chat_id и message_id — открывается само сообщение
      const a = document.createElement('a');
      a.href = r.link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = r.rel_path || r.name;
      title.append(a);
    } else {
      title.textContent = r.rel_path || r.name;
    }
    const when = r.taken_at ? new Date(r.taken_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    row.querySelector('small').textContent =
      `${when} · ${humanSize(r.size)}${r.message_id ? ` · сообщение ${r.message_id}` : ''}${r.last_error ? ` · ${r.last_error}` : ''}`;
    const [cls, text] = statusBadge(r.status);
    const badge = row.querySelector('.pill');
    badge.className = `pill ${cls}`;
    badge.textContent = text;

    if (r.link) {
      const open = document.createElement('a');
      open.className = 'tg-link';
      open.href = r.link;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'открыть ↗';
      row.append(open);
    }
    box.append(row);
  }
  archiveOffset += rows.length;
  updateArchiveFooter();
}

function updateArchiveFooter() {
  const more = archiveOffset < archiveTotal;
  $('#archiveMoreRow').hidden = archiveTotal === 0;
  $('#archiveMore').hidden = !more;
  $('#archiveCounter').textContent = archiveTotal
    ? `Показано ${archiveOffset} из ${archiveTotal}`
    : '';
}

function archiveFilter() {
  return {
    query: $('#archiveSearch')?.value.trim() ?? '',
    status: $('#segArchiveStatus input:checked')?.value ?? '',
  };
}

async function loadMoreArchive() {
  const page = await api('/api/archive/rows', { offset: archiveOffset, limit: 100, ...archiveFilter() });
  archiveTotal = page.total;
  appendArchiveRows(page.rows);
}

/** Перезапрашивает список с нуля — при поиске и смене фильтра. */
async function reloadArchiveRows() {
  const { query, status } = archiveFilter();
  const page = await api('/api/archive/rows', { offset: 0, limit: 100, query, status });

  const box = $('#archiveRows');
  box.innerHTML = '';
  box.classList.toggle('grid-view', $('#segArchiveView input:checked')?.value === 'grid');
  archiveOffset = 0;
  archiveTotal = page.total;

  if (!page.rows.length) {
    box.innerHTML = '<div class="row"><div class="row-label"><b>Ничего не нашлось</b><small>Попробуйте другое слово или уберите фильтр</small></div></div>';
    updateArchiveFooter();
  } else {
    appendArchiveRows(page.rows);
  }

  $('#archiveRowsTitle').textContent = query || status
    ? `Найдено записей: ${archiveTotal}`
    : `Что внутри · всего записей ${archiveTotal}`;
}

let searchTimer = null;
$('#archiveSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => guard(null, reloadArchiveRows), 300);
});
$$('#segArchiveStatus input, #segArchiveView input').forEach((i) =>
  i.addEventListener('change', () => guard(null, reloadArchiveRows)));

async function loadArchive() {
  const a = await api('/api/archive').catch((err) => {
    toast(err.message, true);
    return null;
  });
  if (!a) return;

  const sent = a.byStatus.find((r) => r.status === 'sent');
  const failed = a.byStatus.find((r) => r.status === 'failed');
  const empty = !a.total.n;

  $('#archiveNumbers').innerHTML = empty
    ? '<div class="stat wide"><b>Пусто</b><small>Ещё ничего не отправлено — база создана, но записей в ней нет</small></div>'
    : `
      <div class="stat"><b>${sent?.n ?? 0}</b><small>файлов в архиве</small></div>
      <div class="stat"><b>${humanSize(sent?.bytes ?? 0)}</b><small>общий объём</small></div>
      <div class="stat"><b>${a.fileIds?.with_file_id ?? 0}</b><small>можно переслать мгновенно</small></div>
      <div class="stat"><b>${a.byYear.length}</b><small>${a.byYear.length ? `лет: ${a.byYear.map((y) => y.year).join(', ')}` : 'лет в архиве'}</small></div>`;

  const rows = $('#archiveRows');
  rows.innerHTML = '';
  rows.classList.toggle('grid-view', $('#segArchiveView input:checked')?.value === 'grid');
  archiveOffset = 0;
  archiveTotal = a.page?.total ?? 0;

  if (empty) {
    rows.innerHTML = '<div class="row"><div class="row-label"><b>Записей нет</b><small>Как только отправите первый файл, он появится здесь</small></div></div>';
    $('#archiveRowsTitle').textContent = 'Что внутри';
    updateArchiveFooter();
  } else {
    $('#archiveRowsTitle').textContent = `Что внутри · всего записей ${archiveTotal}`;
    if (failed?.n) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<div class="row-label"><b></b><small>Можно попробовать ещё раз кнопкой «Отправить всё»</small></div>';
      row.querySelector('b').textContent = `С ошибкой: ${failed.n}`;
      rows.append(row);
    }
    // Первая сотня приехала вместе со сводкой, остальное — по кнопке
    appendArchiveRows(a.page?.rows ?? []);
  }

  $('#dbPath').textContent = a.path;
  $('#dbMeta').textContent = `${humanSize(a.fileSize)} · ${a.driver}${a.topics.length ? ` · топиков: ${a.topics.length}` : ''}`;
}

$('#archiveMore').addEventListener('click', (e) => guard(e.target, loadMoreArchive));

$('#refreshArchive').addEventListener('click', (e) => guard(e.target, loadArchive));

/* ── шаг 6: проверка и запуск ────────────────────────────────────────────── */

async function runChecks() {
  try {
    await refresh();
    const c = await api('/api/checks', {});
    const s = state?.settings ?? {};

    if (c.bot?.ok) { pill($('#sumBot'), 'ok', 'готов'); $('#sumBotText').textContent = `@${c.bot.username}`; }
    else { pill($('#sumBot'), 'err', 'нет'); $('#sumBotText').textContent = c.bot?.problem ?? 'токен не задан'; }

    if (c.chat?.ok) { pill($('#sumChat'), 'ok', 'готов'); $('#sumChatText').textContent = `${c.chat.title}${c.chat.isForum ? ' · с темами' : ''}`; }
    else { pill($('#sumChat'), 'err', 'нет'); $('#sumChatText').textContent = c.chat?.problem ?? 'канал не выбран'; }

    if (c.account?.ok) { pill($('#sumAcc'), 'ok', 'готов'); $('#sumAccText').textContent = c.account.name || c.account.username || 'подключён'; }
    else { pill($('#sumAcc'), 'warn', 'нет'); $('#sumAccText').textContent = 'файлы больше 50 МБ отправляться не будут'; }

    if (s.scanPaths?.length) { pill($('#sumPath'), 'ok', `${s.scanPaths.length}`); $('#sumPathText').textContent = s.scanPaths.join(', '); }
    else { pill($('#sumPath'), 'err', 'нет'); $('#sumPathText').textContent = 'папки не выбраны'; }
  } catch (err) {
    toast(err.message, true);
  }
}

function renderJob(job) {
  const running = job.running;
  $('#doStop').hidden = !(running && job.mode === 'send');
  $('#log').hidden = !job.lines.length;
  $('#log').textContent = job.lines.join('\n');
  $('#log').scrollTop = $('#log').scrollHeight;

  const s = job.send ?? {};
  if (job.mode === 'send' && s.total) {
    $('#progressWrap').hidden = false;
    $('#progressBar').style.width = `${Math.round((s.processed / s.total) * 100)}%`;
  } else if (!running) {
    $('#progressWrap').hidden = true;
  }

  if (job.summary) {
    const b = job.summary;
    $('#scanResult').hidden = false;
    $('#scanResult').innerHTML = `
      <div class="stat"><b>${b.count}</b><small>файлов к отправке</small></div>
      <div class="stat"><b>${humanSize(b.bytes)}</b><small>общий объём</small></div>
      <div class="stat"><b>${b.photos} / ${b.videos}</b><small>фото / видео</small></div>
      <div class="stat"><b>${b.livePhotos ?? 0}</b><small>Live Photo</small></div>`;
  }

  if (!running && poller) {
    clearInterval(poller);
    poller = null;
    if (job.error) toast(job.error, true);
    else if (job.finished === 'send') toast('Отправка завершена');
  }
}

function startPolling() {
  clearInterval(poller);
  poller = setInterval(async () => {
    try {
      renderJob(await api('/api/job'));
    } catch {
      /* подождём следующего тика */
    }
  }, 1500);
}

$('#doScan').addEventListener('click', (e) => guard(e.target, async () => {
  await api('/api/scan', {});
  toast('Считаю файлы — это может занять пару минут');
  startPolling();
}));

$('#doSend').addEventListener('click', (e) => guard(e.target, async () => {
  await api('/api/send', {});
  toast('Отправка началась. Можно закрыть вкладку — программа продолжит');
  startPolling();
}));

$('#doStop').addEventListener('click', (e) => guard(e.target, async () => {
  await api('/api/stop', {});
  toast('Остановлюсь после текущего файла');
}));

$('#doCleanup').addEventListener('click', (e) => guard(e.target, async () => {
  const r = await api('/api/cleanup', { apply: false });
  if (!r.found) {
    $('#cleanupText').textContent = 'Лишних видео нет — всё аккуратно';
    toast('Дублей не нашлось');
    return;
  }
  $('#cleanupText').textContent = `Нашлось лишних видео: ${r.found}. ${r.items.slice(0, 2).join('; ')}`;
  const ok = await askConfirm({
    title: 'Убрать лишние видео?',
    text: `Найдено ${r.found} видео Live Photo, которые ушли отдельными сообщениями. Их сообщения будут удалены из группы, сами файлы на диске останутся.`,
    icon: '🧹',
    okText: 'Удалить',
    danger: true,
  });
  if (ok) {
    const applied = await api('/api/cleanup', { apply: true });
    $('#cleanupText').textContent = `Удалено: ${applied.deleted}`;
    toast(`Удалено сообщений: ${applied.deleted}`);
  }
}));

/* ── старт ───────────────────────────────────────────────────────────────── */

$$('#nav .nav-num').forEach((n) => { n.dataset.n = n.textContent; });

refresh()
  .then(() => {
    if (state.locked) {
      const me = state.profiles.find((p) => p.active);
      showLock({ name: state.profile, method: me?.lock ?? 'pin', pinLength: me?.pinLength ?? 4, canCode: true, label: me?.displayName });
      return null;
    }
    return api('/api/job').then(renderJob).catch(() => {});
  })
  .catch((err) => toast(err.message, true));
