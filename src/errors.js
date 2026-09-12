/**
 * Понятные объяснения ошибок.
 *
 * Node прячет настоящую причину сетевого сбоя: fetch бросает TypeError
 * с текстом «fetch failed», а код (ENOTFOUND, ECONNREFUSED, таймаут, проблема
 * с сертификатом) лежит в err.cause, иногда на два уровня глубже. Без этого
 * в логе остаётся «fetch failed», по которому ничего не понять.
 */

/** Разворачивает цепочку cause: настоящая причина обычно в самом низу. */
export function rootCause(err) {
  let current = err;
  const seen = new Set();
  while (current?.cause && !seen.has(current.cause)) {
    seen.add(current.cause);
    current = current.cause;
  }
  return current ?? err;
}

/** Все коды из цепочки: у undici код бывает и на обёртке, и на причине. */
function codesOf(err) {
  const codes = [];
  let current = err;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.code) codes.push(String(current.code));
    if (current.errno && typeof current.errno === 'string') codes.push(current.errno);
    current = current.cause;
  }
  return codes;
}

// Что означает код и что с этим делать. Порядок важен: первое совпадение выигрывает.
const NETWORK_CODES = [
  ['ENOTFOUND', 'не удалось определить адрес сервера (DNS)', 'Проверьте интернет и настройки DNS. Если Telegram у вас блокируют — понадобится VPN или прокси.'],
  ['EAI_AGAIN', 'DNS не ответил вовремя', 'Обычно это временный сбой сети или DNS-сервера. Проверьте интернет и попробуйте ещё раз.'],
  ['ECONNREFUSED', 'сервер отказался от соединения', 'Если задан свой Bot API server (TELEGRAM_BOT_API_ROOT) — проверьте, запущен ли он и верен ли адрес.'],
  ['ECONNRESET', 'соединение оборвал сервер или сеть по пути', 'Так бывает при блокировках и на нестабильном соединении. Программа повторит запрос сама.'],
  ['UND_ERR_CONNECT_TIMEOUT', 'не удалось подключиться за отведённое время', 'Похоже на блокировку или очень медленную сеть. Проверьте, открывается ли api.telegram.org в браузере.'],
  ['UND_ERR_HEADERS_TIMEOUT', 'сервер не прислал ответ вовремя', 'Соединение есть, но ответа нет. Часто это блокировка или перегруженный канал.'],
  ['UND_ERR_BODY_TIMEOUT', 'передача файла оборвалась по таймауту', 'Обычно это медленный или нестабильный интернет — большой файл не успел уйти.'],
  ['UND_ERR_SOCKET', 'соединение закрылось на полпути', 'Так бывает при блокировках и на нестабильном соединении. Программа повторит запрос сама.'],
  ['ETIMEDOUT', 'время ожидания вышло', 'Проверьте, открывается ли api.telegram.org в браузере: если нет — нужен VPN или прокси.'],
  ['EPIPE', 'соединение закрылось во время передачи', 'Обычно это обрыв связи посреди загрузки файла.'],
  ['EHOSTUNREACH', 'сеть не знает пути до сервера', 'Проверьте подключение к интернету и настройки маршрутизации.'],
  ['ENETUNREACH', 'сеть недоступна', 'Проверьте подключение к интернету.'],
  ['EACCES', 'система запретила соединение', 'Скорее всего мешает файрвол или антивирус.'],
  ['CERT_HAS_EXPIRED', 'у сервера просроченный сертификат', 'Проверьте дату и время на компьютере — из-за неверных часов сертификаты выглядят просроченными.'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'сертификат подписан сам собой', 'Так выглядит подмена трафика: корпоративный прокси, антивирус с проверкой HTTPS или свой Bot API server.'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'в цепочке сертификатов есть самоподписанный', 'Так выглядит подмена трафика: корпоративный прокси или антивирус с проверкой HTTPS.'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'не удалось проверить сертификат сервера', 'Обычно мешает антивирус или прокси, встающий в середину HTTPS.'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'сертификат выдан на другое имя', 'Похоже, соединение перехватывает прокси или провайдер.'],
];

/**
 * Коды файловой системы. Отдельно от сетевых: у EACCES и ETIMEDOUT смысл
 * меняется в зависимости от того, читаем мы диск или ходим в Telegram.
 */
const FILE_CODES = [
  ['EIO', 'диск не смог прочитать файл (ошибка ввода-вывода)',
   'Это отвечает не программа, а сам накопитель: обычно так проявляются битые сектора, отходящий кабель или сбойный USB-порт. ' +
   'Переподключите диск в другой порт (лучше без удлинителя и хаба), а если ошибок много — скопируйте с него всё, что читается, на другой носитель: такой диск может окончательно отказать.'],
  ['ENODEV', 'устройство пропало во время работы',
   'Диск или телефон отключился: проверьте кабель и снова смонтируйте накопитель.'],
  ['ENXIO', 'устройство не отвечает',
   'Накопитель отвалился от системы. Переподключите его и попробуйте снова.'],
  ['ESTALE', 'система потеряла файл из виду',
   'Так бывает, когда диск размонтировали или переподключили посреди обхода. Начните заново.'],
  ['ENOENT', 'файла или папки больше нет',
   'Проверьте путь: возможно, диск отключился или папку переименовали.'],
  ['EACCES', 'нет прав на чтение',
   'Дайте своему пользователю доступ к папке или запустите программу от имени владельца файлов.'],
  ['EPERM', 'система запретила операцию',
   'Обычно не хватает прав на файл или мешает антивирус.'],
  ['EROFS', 'носитель доступен только для чтения',
   'Файловая система перешла в режим только чтения — так ядро защищается от сбойного диска. Проверьте накопитель.'],
  ['EBUSY', 'файл занят другой программой',
   'Закройте приложение, которое держит файл, и попробуйте ещё раз.'],
  ['ENOSPC', 'на диске кончилось место',
   'Освободите место: программе нужно куда-то класть временные файлы (TMP_DIR).'],
  ['EMFILE', 'слишком много открытых файлов',
   'Системный лимит исчерпан. Закройте лишние программы или поднимите ulimit -n.'],
  ['ENAMETOOLONG', 'слишком длинное имя файла', 'Переименуйте файл или перенесите его выше по дереву папок.'],
  ['EISDIR', 'это папка, а не файл', null],
  ['ENOTDIR', 'в пути оказался файл вместо папки', 'Проверьте путь в списке папок.'],
];

/** Сбой ли это чтения диска — по этому решается, стоит ли верить итогам обхода. */
export function isDiskError(err) {
  const codes = codesOf(err);
  return FILE_CODES.some(([code]) => codes.includes(code));
}

// Сбои, у которых нет кода: их узнаём по имени класса или по тексту
const NAMED_CASES = [
  [(e) => e?.name === 'TimeoutError', 'Telegram не ответил вовремя',
   'Проверьте, открывается ли api.telegram.org в браузере: если нет — нужен VPN или прокси.'],
  [(e) => /bad port|Invalid URL|ERR_INVALID_URL/i.test(`${e?.message} ${e?.cause?.message ?? ''}`),
   'адрес сервера Telegram записан неверно',
   'Проверьте TELEGRAM_BOT_API_ROOT в настройках: должно быть вроде http://127.0.0.1:8081, без лишних символов.'],
  [(e) => /Unexpected token|JSON/i.test(e?.message ?? '') && /</.test(e?.message ?? ''),
   'вместо ответа Telegram пришла страница',
   'Так отвечает прокси или провайдер, подменяющий трафик. Проверьте, открывается ли api.telegram.org напрямую.'],
];

/** Сетевой ли это сбой — по коду где угодно в цепочке причин. */
export function isNetworkError(err) {
  const codes = codesOf(err);
  return (
    codes.some((c) => NETWORK_CODES.some(([code]) => code === c)) ||
    /fetch failed|network|socket|ECONN|ETIMEDOUT/i.test(err?.message ?? '')
  );
}

/**
 * Ошибка одной строкой, но с настоящей причиной внутри.
 * @returns {string}
 */
export function explainError(err, { kind } = {}) {
  if (!err) return 'неизвестная ошибка';
  if (typeof err === 'string') return err;

  const codes = codesOf(err);
  // Для файловых операций сперва смотрим коды диска: EACCES у файла и у сети — разное
  const table = kind === 'file' ? [...FILE_CODES, ...NETWORK_CODES] : [...NETWORK_CODES, ...FILE_CODES];
  const match = table.find(([code]) => codes.includes(code));
  const cause = rootCause(err);

  if (match) {
    const [code, what] = match;
    return `${what} (${code})`;
  }

  const named = NAMED_CASES.find(([test]) => test(err));
  if (named) return named[1];

  // Причина есть, но код незнакомый — покажем её текст, он информативнее обёртки
  if (cause !== err && cause?.message && cause.message !== err.message) {
    const code = cause.code ? ` (${cause.code})` : '';
    return `${err.message}: ${cause.message}${code}`;
  }

  const code = err.code && typeof err.code === 'string' ? ` (${err.code})` : '';
  return `${err.message ?? String(err)}${code}`;
}

/** Что делать — отдельной строкой, чтобы не мешать самой ошибке. */
export function adviceFor(err, { kind } = {}) {
  const codes = codesOf(err);
  const table = kind === 'file' ? [...FILE_CODES, ...NETWORK_CODES] : [...NETWORK_CODES, ...FILE_CODES];
  const match = table.find(([code]) => codes.includes(code));
  if (match) return match[2];

  const named = NAMED_CASES.find(([test]) => test(err));
  if (named) return named[2];
  if (/fetch failed/i.test(err?.message ?? '')) {
    return 'Соединение с Telegram не установилось. Проверьте интернет и открывается ли api.telegram.org в браузере.';
  }
  return null;
}

/* ── ответы самого Telegram ──────────────────────────────────────────────── */

// Bot API отвечает кодом и текстом на английском — переводим в понятное действие
const BOT_API_HINTS = [
  [/bot token is invalid|unauthorized/i, 'Токен бота неверный или отозван. Возьмите новый у @BotFather на шаге «Бот».'],
  [/chat not found/i, 'Telegram не видит такой чат. Проверьте, что бот добавлен в группу и что выбрана правильная группа.'],
  [/bot was kicked|bot is not a member/i, 'Бота выгнали из группы. Добавьте его обратно и дайте право публиковать сообщения.'],
  [/not enough rights|have no rights|CHAT_ADMIN_REQUIRED/i, 'Боту не хватает прав в группе. Сделайте его администратором с правом публиковать сообщения (а для тем — управлять темами).'],
  [/blocked by the user/i, 'Пользователь заблокировал бота — писать ему бот не может.'],
  [/message thread not found|TOPIC_.*(CLOSED|DELETED)/i, 'Темы (топика) больше нет или она закрыта. Программа заведёт новую при следующей отправке.'],
  [/too many requests|flood/i, 'Telegram придержал бота за слишком частые запросы. Программа подождёт столько, сколько он просит.'],
  [/file is too big|Request Entity Too Large/i, 'Файл больше того, что принимает бот (50 МБ). Для крупных нужен вход в аккаунт — он в блоке «Этот профиль».'],
  [/wrong file identifier|file_id/i, 'Telegram не принял сохранённый идентификатор файла — возможно, сообщение удалили.'],
  [/PHOTO_INVALID|IMAGE_PROCESS_FAILED|PHOTO_EXT_INVALID/i, 'Telegram не смог обработать файл как фото. Программа отправит его документом.'],
  [/topic_?closed/i, 'Тема закрыта — писать в неё нельзя.'],
];

/** Подсказка по ответу Bot API: что именно пошло не так и что делать. */
export function botApiAdvice(description = '', status = 0) {
  // Вместо JSON пришла страница — так отвечают блокировщики и прокси
  if (/^\s*<(!doctype|html|head|body)/i.test(description)) {
    return 'Вместо ответа Telegram пришла веб-страница — так отвечает прокси или блокировка провайдера. Проверьте, открывается ли api.telegram.org напрямую; может понадобиться VPN.';
  }
  const hit = BOT_API_HINTS.find(([re]) => re.test(description));
  if (hit) return hit[1];
  if (status === 401) return 'Токен бота не принят. Проверьте его на шаге «Бот».';
  if (status === 403) return 'Telegram запретил действие: обычно бота выгнали из группы или заблокировали.';
  if (status === 404) return 'Telegram не знает такого метода или токена — проверьте токен бота.';
  if (status >= 500) return 'Это сбой на стороне Telegram. Программа повторит запрос сама.';
  return null;
}

// Ошибки MTProto приходят словами вроде AUTH_KEY_UNREGISTERED
const MTPROTO_HINTS = [
  [/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i, 'Вход в аккаунт больше не действует — сеанс отозван. Войдите заново на шаге «Ваш аккаунт».'],
  [/FLOOD_WAIT_(\d+)/i, 'Telegram придержал аккаунт за частые запросы. Нужно подождать — программа сделает это сама.'],
  [/PHONE_NUMBER_INVALID/i, 'Номер телефона в неверном формате. Нужен международный вид, например +79991234567.'],
  [/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/i, 'Код из Telegram неверный или устарел — запросите новый.'],
  [/PASSWORD_HASH_INVALID/i, 'Неверный облачный пароль (двухфакторная защита).'],
  [/CHANNEL_PRIVATE|CHAT_ID_INVALID|PEER_ID_INVALID/i, 'Аккаунт не видит эту группу. Проверьте, что вы в ней состоите и что выбрана правильная группа.'],
  [/CHAT_ADMIN_REQUIRED/i, 'Нужны права администратора в этой группе.'],
  [/FILE_PARTS_INVALID|FILE_PART_.*_MISSING/i, 'Загрузка файла оборвалась. Программа попробует ещё раз.'],
  [/TIMEOUT/i, 'Telegram не ответил вовремя — обычно это медленная сеть или блокировка.'],
];

/** Подсказка по ошибке от аккаунта (MTProto). */
export function mtprotoAdvice(message = '') {
  return MTPROTO_HINTS.find(([re]) => re.test(message))?.[1] ?? null;
}

/**
 * Ошибка + совет одной строкой — для лога и для показа в мастере.
 * @param {unknown} err
 * @param {{ kind?: 'bot'|'mtproto', status?: number }} [opts]
 */
export function describeError(err, { kind, status = 0 } = {}) {
  const text = explainError(err, { kind });
  const description = err?.description ?? err?.message ?? '';
  const advice =
    adviceFor(err, { kind }) ??
    (kind === 'bot' ? botApiAdvice(description, status || err?.code || 0) : null) ??
    (kind === 'mtproto' ? mtprotoAdvice(description) : null);

  // Совет мог уже попасть в текст ошибки ниже по стеку — второй раз не повторяем
  if (!advice || text.includes(advice)) return text;
  return `${text}. ${advice}`;
}
