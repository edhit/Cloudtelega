#!/bin/bash
# Запуск Cloudtelega на Linux и macOS.
#
# На macOS двойным щелчком открывают Cloudtelega.command — он вызывает
# этот же файл. Держать две почти одинаковые копии смысла нет: разница
# между системами — только в подсказке, где взять Node.js.

# Терминал открывается где придётся, а не в папке программы
cd "$(dirname "$0")" || exit 1

mac() { [ "$(uname -s)" = "Darwin" ]; }

# Двойной щелчок — это отдельное окно терминала: без паузы человек
# не успеет прочитать, что пошло не так
stop() {
  printf '\n'
  [ -t 0 ] && read -r -p '  Нажмите Enter, чтобы закрыть…' _
  exit 1
}

printf '\n  Cloudtelega — ваше облако в Telegram\n\n'

# ── от администратора запускать не надо ─────────────────────────────────────
# Настройки, база и ключи лежат рядом с программой. Под sudo они станут
# принадлежать root, и дальше без sudo программа работать не сможет —
# а sudo ещё и прячет Node.js, поставленный в домашнюю папку.
if [ -n "$SUDO_USER" ]; then
  printf '  Не запускайте через sudo — программе это не нужно.\n\n'
  printf '  Она хранит настройки и базу рядом с собой, в этой же папке.\n'
  printf '  Из-под администратора файлы станут чужими для вас, и дальше\n'
  printf '  программа будет требовать sudo каждый раз.\n\n'
  printf '  Запустите просто:  ./Cloudtelega.sh\n'
  owner="$(stat -c %u node_modules 2>/dev/null || stat -f %u node_modules 2>/dev/null)"
  if [ -d node_modules ] && [ "$owner" = "0" ]; then
    printf '\n  Похоже, прошлый запуск был через sudo: папка node_modules\n'
    printf '  принадлежит root. Верните её себе одной командой:\n\n'
    printf '    sudo chown -R %s "%s"\n' "$SUDO_USER" "$PWD"
  fi
  stop
fi

# ── ищем Node.js ────────────────────────────────────────────────────────────
# Одного `command -v node` мало: nvm, fnm, volta и asdf ставят Node в домашнюю
# папку и прописывают его в PATH только для обычной оболочки. Файловый
# менеджер (и sudo) запускают скрипт с урезанным окружением, и Node «пропадает»,
# хотя в терминале он прекрасно работает.
version_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null
}

NODE=""
FOUND_OLD=""
for candidate in \
  "$(command -v node 2>/dev/null)" \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
  "$HOME"/.fnm/node-versions/*/installation/bin/node \
  "$HOME"/.volta/bin/node \
  "$HOME"/.asdf/shims/node \
  "$HOME"/n/bin/node \
  /usr/local/bin/node \
  /opt/homebrew/bin/node \
  /usr/bin/node \
  /snap/bin/node
do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  if version_ok "$candidate"; then NODE="$candidate"; break; fi
  [ -z "$FOUND_OLD" ] && FOUND_OLD="$candidate"
done

if [ -z "$NODE" ] && [ -n "$FOUND_OLD" ]; then
  printf '  У вас Node.js %s, а нужен 22.5 или новее.\n\n' "$("$FOUND_OLD" -v)"
  if mac; then
    printf '  Обновите его с https://nodejs.org (кнопка LTS) и запустите снова.\n'
  else
    printf '  Обновите его — например:  nvm install 24 && nvm use 24\n'
  fi
  stop
fi

if [ -z "$NODE" ]; then
  printf '  Не найден Node.js — без него программа не запустится.\n\n'
  if mac; then
    printf '  Поставьте его отсюда: https://nodejs.org (кнопка LTS),\n'
    printf '  затем закройте это окно и запустите файл снова.\n'
  else
    printf '  Ubuntu/Debian:  sudo apt install nodejs npm\n'
    printf '  Fedora:         sudo dnf install nodejs\n'
    printf '  Или с https://nodejs.org — нужен Node 22.5 или новее.\n'
  fi
  printf '\n  Если Node.js у вас точно стоит и в терминале работает —\n'
  printf '  запустите программу из того же терминала:  ./Cloudtelega.sh\n'
  stop
fi

# Рядом с найденным node лежит и npm — кладём его папку в PATH,
# иначе при урезанном окружении npm не найдётся следом за node
PATH="$(dirname "$NODE"):$PATH"
export PATH

# ── доставляем зависимости при первом запуске ───────────────────────────────
if [ ! -d node_modules ]; then
  printf '  Первый запуск: доставляю всё нужное, это займёт минуту…\n\n'
  if ! npm install --no-audit --no-fund; then
    printf '\n  Не вышло доставить. Проверьте интернет и запустите файл снова.\n'
    stop
  fi
  printf '\n'
fi

printf '  Открываю настройку в браузере.\n'
printf '  Это окно — работающая программа: закроете его, и она остановится.\n\n'
exec "$NODE" src/index.js setup
