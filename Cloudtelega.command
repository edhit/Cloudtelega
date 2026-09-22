#!/bin/bash
# Запуск на macOS: двойной щелчок по этому файлу.
#
# Терминал открывается не в папке программы, а где придётся, поэтому
# первым делом переходим туда, где лежит сам файл.
cd "$(dirname "$0")" || exit 1

printf '\n  Cloudtelega — ваше облако в Telegram\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  Не найден Node.js — без него программа не запустится.\n'
  printf '  Поставьте его отсюда: https://nodejs.org (кнопка LTS), затем\n'
  printf '  закройте это окно и запустите файл снова.\n\n'
  read -r -p '  Нажмите Enter, чтобы закрыть…'
  exit 1
fi

# Нужен Node 22.5 или новее: на нём есть встроенная база (node:sqlite)
major=$(node -p 'process.versions.node.split(".")[0]')
minor=$(node -p 'process.versions.node.split(".")[1]')
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 5 ]; }; then
  printf '  У вас Node.js %s, а нужен 22.5 или новее.\n' "$(node -v)"
  printf '  Обновите его с https://nodejs.org и запустите файл снова.\n\n'
  read -r -p '  Нажмите Enter, чтобы закрыть…'
  exit 1
fi

if [ ! -d node_modules ]; then
  printf '  Первый запуск: доставляю всё нужное, это займёт минуту…\n\n'
  npm install --no-audit --no-fund || {
    printf '\n  Не вышло доставить. Проверьте интернет и запустите файл снова.\n\n'
    read -r -p '  Нажмите Enter, чтобы закрыть…'
    exit 1
  }
fi

printf '  Открываю настройку в браузере. Чтобы закончить работу — закройте это окно.\n\n'
node src/index.js setup
