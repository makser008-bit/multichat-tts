@echo off
chcp 65001 >nul
cd /d %~dp0
echo === Встановлення залежностей ===
call npm install --ignore-scripts
if errorlevel 1 goto fail
echo === Збірка MultiChat (потрібен інтернет, 2-5 хв) ===
if not exist .build-cache mkdir .build-cachecall npx --yes @electron/packager . MultiChat --platform=win32 --arch=x64 --out=dist --overwrite --electron-version=44.9.3 --icon=assets/icon.ico --tmpdir=.build-cache\tmp --ignore="^/dist" --ignore="^/\.github" --ignore="^/\.git" --ignore="^/\.build-cache" --ignore="\.bat$" --ignore="^/accounts\.json$" --ignore="^/config\.json$" --ignore="^/settings\.json$" --ignore="^/voices(/.*)?$" --ignore="^/\.env.*$" --ignore="\.log$" --ignore="\.token$"
if errorlevel 1 goto fail
copy /y config.example.json "dist\MultiChat-win32-x64\config.example.json" >nul
if exist "dist\MultiChat-win32-x64\config.json" goto sensitive_fileif exist "dist\MultiChat-win32-x64\accounts.json" goto sensitive_fileif exist "dist\MultiChat-win32-x64\settings.json" goto sensitive_fileif exist "dist\MultiChat-win32-x64\voices" goto sensitive_file
echo.
echo Готово: dist\MultiChat-win32-x64\MultiChat.exe
explorer "dist\MultiChat-win32-x64"
pause
exit /b 0:sensitive_fileecho ПОМИЛКА: у збірку потрапив файл або папка з особистими налаштуваннями.echo Збірку зупинено. Перевір правила виключення у build-exe.bat.goto fail
:fail
echo.
echo Збірка не вдалась - скопіюй текст помилки вище.
pause
exit /b 1

