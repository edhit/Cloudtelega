@echo off
rem Запуск на Windows: двойной щелчок по этому файлу.
rem chcp 65001 — чтобы русские надписи не превратились в кракозябры.
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   Cloudtelega - ваше облако в Telegram
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Не найден Node.js - без него программа не запустится.
  echo   Поставьте его отсюда: https://nodejs.org ^(кнопка LTS^), затем
  echo   закройте это окно и запустите файл снова.
  echo.
  pause
  exit /b 1
)

rem Нужен Node 22.5 или новее: на нём есть встроенная база (node:sqlite)
for /f %%v in ('node -p "process.versions.node.split('.')[0]*1000+process.versions.node.split('.')[1]*1"') do set NODEVER=%%v
if %NODEVER% LSS 22005 (
  echo   Ваш Node.js слишком старый, нужен 22.5 или новее.
  node -v
  echo   Обновите его с https://nodejs.org и запустите файл снова.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Первый запуск: доставляю всё нужное, это займёт минуту...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Не вышло доставить. Проверьте интернет и запустите файл снова.
    echo.
    pause
    exit /b 1
  )
)

echo   Открываю настройку в браузере. Чтобы закончить работу - закройте это окно.
echo.
node src\index.js setup
pause
