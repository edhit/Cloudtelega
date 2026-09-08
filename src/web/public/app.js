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
  $$('#nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.pane === pane)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (pane === 'finish') runChecks();
  if (pane === 'archive') loadArchive();
  if (pane === 'folders') loadDevices();
  if (pane === 'chat') updateCreateAvailability();
  if (pane === 'prefs') renderPreview();
}

$$('#nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.pane)));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

function markDone(pane, done) {
  const num = $(`#nav button[data-pane="${pane}"] .nav-num`);
  if (!num) return;
  num.classList.toggle('done', done);
  num.textContent = done ? '✓' : num.dataset.n ?? num.textContent;
}

/* ── профили ─────────────────────────────────────────────────────────────── */

/** Цвет кружка выводим из имени — у каждого профиля свой, но всегда один и тот же. */
function hueOf(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

async function switchProfile(name) {
  state = await api('/api/profiles/switch', { name });
  captionSamples = null;
  archiveOffset = 0;
  await refresh();
  toast(`Профиль: ${name}`);
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

    const label = p.name === 'default' ? 'Основной' : p.name;

    const avatar = document.createElement('span');
    avatar.className = 'account-avatar';
    avatar.style.setProperty('--h', hueOf(p.name));
    avatar.textContent = label.slice(0, 1);

    const text = document.createElement('span');
    text.className = 'account-text';
    const title = document.createElement('b');
    title.textContent = label;
    const sub = document.createElement('small');
    sub.textContent = p.configured ? 'настроен' : 'не настроен';
    text.append(title, sub);

    btn.append(avatar, text);

    if (!p.active && p.name !== 'default') {
      const del = document.createElement('span');
      del.className = 'account-del';
      del.textContent = '×';
      del.title = 'Удалить профиль';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        guard(null, async () => {
          if (!confirm(`Удалить профиль «${p.name}»? Его настройки и база отправленного будут стёрты. Сообщения в Telegram останутся.`)) return;
          await api('/api/profiles/delete', { name: p.name });
          await refresh();
          toast(`Профиль «${p.name}» удалён`);
        });
      });
      btn.append(del);
    }

    if (!p.active) btn.addEventListener('click', () => guard(null, () => switchProfile(p.name)));
    li.append(btn);
    list.append(li);
  }
}

$('#newProfile').addEventListener('click', () => guard(null, async () => {
  const name = prompt('Имя профиля — например, имя человека, чей это архив:');
  if (!name) return;
  await api('/api/profiles/create', { name });
  await switchProfile(name);
  toast(`Профиль «${name}» создан — настройте его с первого шага`);
  show('bot');
}));

/* ── состояние ───────────────────────────────────────────────────────────── */

async function refresh() {
  state = await api('/api/state');
  const s = state.settings;
  renderProfiles();

  if (s.botTokenSet) $('#botToken').placeholder = s.botToken;
  $('#chatId').value = s.chatId || '';
  $('#topicYear').checked = s.topicMode === 'year';
  $('#apiId').value = s.apiId || '';
  if (s.apiHashSet) $('#apiHash').placeholder = s.apiHash;
  $('#adminIds').value = s.adminIds.join(', ');

  $$('#segSend input').forEach((i) => { i.checked = i.value === (s.sendAsDocument ? 'doc' : 'feed'); });
  $$('#segLive input').forEach((i) => { i.checked = i.value === s.livePhotoVideos; });
  $$('#segCaption input').forEach((i) => { i.checked = i.value === s.captionStyle; });
  $('#keepHeic').checked = s.keepHeicOriginal;

  paths = [...s.scanPaths];
  renderPaths();

  markDone('bot', s.botTokenSet);
  markDone('chat', Boolean(s.chatId));
  markDone('account', s.sessionSet);
  markDone('folders', paths.length > 0);
  markDone('prefs', state.envExists);

  if (s.botTokenSet) pill($('#botStatus'), '', 'токен сохранён');
  if (s.chatId) pill($('#chatStatus'), '', `сохранён ${s.chatId}`);
  if (s.sessionSet) pill($('#accountStatus'), 'ok', 'аккаунт подключён');
  if (paths.length) pill($('#pathStatus'), 'ok', `папок: ${paths.length}`);

  markDone('archive', (state.stats?.total?.n ?? 0) > 0);
  updateCreateAvailability();
}

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
  $('#chatId').value = created.chatId;
  $('#topicYear').checked = created.isForum && topics;

  pill($('#chatStatus'), 'ok', `${created.title}${created.isForum ? ' · с темами' : ''}`);
  toast(created.isForum ? 'Группа создана, темы включены, бот добавлен' : 'Группа создана, бот добавлен');
  for (const w of created.warnings ?? []) toast(w, true);

  await refresh();
  updateCreateAvailability();
}));

$('#detectChat').addEventListener('click', (e) => guard(e.target, async () => {
  const { chats } = await api('/api/detect-chats', {});
  const box = $('#chatCandidates');
  box.innerHTML = '';

  if (!chats.length) {
    box.hidden = true;
    throw new Error('Пока ничего не вижу. Добавьте бота администратором в канал и напишите там любое сообщение');
  }

  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="row-label"><b></b><small></small></div>`;
    row.querySelector('b').textContent = chat.title;
    row.querySelector('small').textContent =
      `${chat.type === 'channel' ? 'канал' : 'группа'}${chat.isForum ? ' с темами' : ''} · ${chat.id}`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Выбрать';
    btn.addEventListener('click', () => {
      $('#chatId').value = chat.id;
      if (!chat.isForum) $('#topicYear').checked = false;
      toast(`Выбран «${chat.title}» — теперь нажмите «Сохранить и проверить»`);
    });
    row.append(btn);
    box.append(row);
  }
  box.hidden = false;
}));

$('#saveChat').addEventListener('click', (e) => guard(e.target, async () => {
  const chatId = extract($('#chatId').value, 'chat');
  if (!chatId) throw new Error('Укажите канал — кнопкой «Найти мой канал» или вручную');

  await api('/api/settings', {
    TELEGRAM_CHAT_ID: chatId,
    TOPIC_MODE: $('#topicYear').checked ? 'year' : 'none',
  });

  const checks = await api('/api/checks', {});
  if (checks.chat?.ok) {
    const forum = checks.chat.isForum;
    pill($('#chatStatus'), 'ok', checks.chat.title);
    if ($('#topicYear').checked && !forum) {
      pill($('#chatStatus'), 'warn', 'темы не включены');
      throw new Error('Это не группа с темами. Включите «Темы» в настройках группы или выключите раскладку по годам');
    }
    toast(`Канал «${checks.chat.title}» готов принимать файлы`);
    await refresh();
  } else {
    pill($('#chatStatus'), 'err', 'нет доступа');
    throw new Error(checks.chat?.problem ?? 'Канал не найден. Проверьте ID и что бот добавлен администратором');
  }
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
    });
    row.append(span, del);
    list.append(row);
  }
}

function addPath(p) {
  if (!paths.includes(p)) paths.push(p);
  renderPaths();
  toast(`Добавлено: ${p}`);
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

$('#savePaths').addEventListener('click', (e) => guard(e.target, async () => {
  if (!paths.length) throw new Error('Добавьте хотя бы одну папку');
  await api('/api/settings', { SCAN_PATHS: paths.join(',') });
  pill($('#pathStatus'), 'ok', `папок: ${paths.length}`);
  toast('Папки сохранены');
  await refresh();
}));

/* ── шаг 5: настройки ────────────────────────────────────────────────────── */

$('#savePrefs').addEventListener('click', (e) => guard(e.target, async () => {
  const asDoc = $('#segSend input:checked').value === 'doc';
  await api('/api/settings', {
    SEND_AS_DOCUMENT: String(asDoc),
    KEEP_HEIC_ORIGINAL: String($('#keepHeic').checked),
    LIVE_PHOTO_VIDEOS: $('#segLive input:checked').value,
    CAPTION_STYLE: $('#segCaption input:checked').value,
    TELEGRAM_ADMIN_IDS: $('#adminIds').value.replace(/\s/g, ''),
  });
  pill($('#prefsStatus'), 'ok', 'сохранено');
  toast('Настройки сохранены');
  await refresh();
}));

$('#detectOwner').addEventListener('click', (e) => guard(e.target, async () => {
  const { owners } = await api('/api/detect-owner', {});
  if (!owners.length) {
    throw new Error('Пока не вижу. Напишите своему боту в Telegram любое сообщение и нажмите ещё раз');
  }
  const existing = $('#adminIds').value.split(',').map((x) => x.trim()).filter(Boolean);
  for (const o of owners) if (!existing.includes(o.id)) existing.push(o.id);
  $('#adminIds').value = existing.join(', ');
  $('#ownerHint').textContent = `Нашлось: ${owners.map((o) => `${o.name} (${o.id})`).join(', ')}`;
  toast('Готово — не забудьте «Сохранить»');
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

/* ── база отправленного ──────────────────────────────────────────────────── */

let archiveOffset = 0;
let archiveTotal = 0;

function statusBadge(status) {
  const map = { sent: ['ok', 'в архиве'], failed: ['err', 'ошибка'], skipped: ['warn', 'пропущен'], pending: ['', 'в очереди'] };
  return map[status] ?? ['', status];
}

function appendArchiveRows(rows) {
  const box = $('#archiveRows');
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row-label"><b></b><small></small></div><span class="pill"></span>';
    row.querySelector('b').textContent = r.rel_path || r.name;
    const when = r.taken_at ? new Date(r.taken_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    row.querySelector('small').textContent =
      `${when} · ${humanSize(r.size)}${r.message_id ? ` · сообщение ${r.message_id}` : ''}${r.last_error ? ` · ${r.last_error}` : ''}`;
    const [cls, text] = statusBadge(r.status);
    const badge = row.querySelector('.pill');
    badge.className = `pill ${cls}`;
    badge.textContent = text;
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

async function loadMoreArchive() {
  const page = await api('/api/archive/rows', { offset: archiveOffset, limit: 100 });
  archiveTotal = page.total;
  appendArchiveRows(page.rows);
}

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

$('#recheck').addEventListener('click', (e) => guard(e.target, runChecks));

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
  if (confirm(`Найдено лишних видео Live Photo: ${r.found}.\n\nУдалить эти сообщения из канала?`)) {
    const applied = await api('/api/cleanup', { apply: true });
    $('#cleanupText').textContent = `Удалено: ${applied.deleted}`;
    toast(`Удалено сообщений: ${applied.deleted}`);
  }
}));

/* ── старт ───────────────────────────────────────────────────────────────── */

$$('#nav .nav-num').forEach((n) => { n.dataset.n = n.textContent; });

refresh()
  .then(() => api('/api/job').then(renderJob).catch(() => {}))
  .catch((err) => toast(err.message, true));
