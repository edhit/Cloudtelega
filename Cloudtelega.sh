#!/bin/bash
# Запуск на Linux: ./Cloudtelega.sh  (или двойной щелчок, если файловый
# менеджер умеет запускать скрипты).
cd "$(dirname "$0")" || exit 1

printf '\n  Cloudtelega — ваше облако в Telegram\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  Не найден Node.js — без него программа не запустится.\n'
  printf '  Ubuntu/Debian:  sudo apt install nodejs npm\n'
  printf '  Fedora:         sudo dnf install nodejs\n'
  printf '  Или с https://nodejs.org. Нужен Node 22.5 или новее.\n\n'
  exit 1
fi

major=$(node -p 'process.versions.node.split(".")[0]')
minor=$(node -p 'process.versions.node.split(".")[1]')
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 5 ]; }; then
  printf '  У вас Node.js %s, а нужен 22.5 или новее.\n' "$(node -v)"
  printf '  Обновите его — например: nvm install 24 && nvm use 24\n\n'
  exit 1
fi

if [ ! -d node_modules ]; then
  printf '  Первый запуск: доставляю всё нужное, это займёт минуту…\n\n'
  npm install --no-audit --no-fund || {
    printf '\n  Не вышло доставить. Проверьте интернет и попробуйте снова.\n\n'
    exit 1
  }
fi

printf '  Открываю настройку в браузере. Чтобы закончить работу — нажмите Ctrl+C.\n\n'
node src/index.js setup
