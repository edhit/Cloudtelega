@echo off
rem Запуск Cloudtelega на Windows: двойной щелчок по этому файлу.
rem chcp 65001 — чтобы русские надписи не превратились в кракозябры.
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   Cloudtelega - ваше облако в Telegram
echo.

rem ── ищем Node.js ────────────────────────────────────────────────────────
rem Одного "where node" мало: сразу после установки PATH обновляется только
rem в новых окнах, а nvm-windows, fnm и volta ставят Node к себе в профиль.
set "NODE="
for /f "delims=" %%p in ('where node 2^>nul') do if not defined NODE set "NODE=%%p"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%APPDATA%\nvm\node.exe" set "NODE=%APPDATA%\nvm\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\fnm_multishells" (
  for /f "delims=" %%p in ('dir /b /s "%LOCALAPPDATA%\fnm_multishells\node.exe" 2^>nul') do if not defined NODE set "NODE=%%p"
)
if not defined NODE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE=%LOCALAPPDATA%\Volta\bin\node.exe"

if not defined NODE (
  echo   Не найден Node.js - без него программа не запустится.
  echo.
  echo   Поставьте его отсюда: https://nodejs.org ^(кнопка LTS^).
  echo.
  echo   Если вы только что его поставили - закройте это окно
  echo   и запустите файл снова: Windows показывает новые программы
  echo   только во вновь открытых окнах.
  echo.
  pause
  exit /b 1
)

rem Нужен Node 22.5 или новее: на нём есть встроенная база (node:sqlite)
"%NODE%" -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 (
  echo   Ваш Node.js слишком старый, нужен 22.5 или новее. Сейчас стоит:
  "%NODE%" -v
  echo.
  echo   Обновите его с https://nodejs.org и запустите файл снова.
  echo.
  pause
  exit /b 1
)

rem Рядом с node лежит и npm — кладём его папку в PATH, иначе npm
rem не найдётся следом за найденным вручную node
for %%d in ("%NODE%") do set "PATH=%%~dpd;%PATH%"

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
  echo.
)

echo   Открываю настройку в браузере.
echo   Это окно - работающая программа: закроете его, и она остановится.
echo.
"%NODE%" src\index.js setup
pause
