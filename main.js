const { app, BrowserWindow, shell, Menu, clipboard } = require('electron');
const { buildTemplate } = require('./contextmenu.js');
const path = require('path');
const net = require('net');
const { execFile, spawn } = require('child_process');

// у зібраній програмі голоси й журнали лежать поруч із MultiChat.exe, а settings.json, ключі, акаунти й налаштування віджетів - у %APPDATA%\MultiChat
process.env.NO_OPEN = '1';
process.env.MULTICHAT_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
process.env.MULTICHAT_ELECTRON = '1';
// налаштування віджетів і розіграшів лежать у постійній папці користувача (Windows: %APPDATA%\MultiChat), яку нова збірка програми не стирає
try { process.env.MULTICHAT_USERDATA = path.join(app.getPath('appData'), 'MultiChat'); } catch {}

/* одна папка в %APPDATA%: дані самого Electron (localStorage з налаштуваннями інтерфейсу, сесії входу, кеш) раніше лежали в %APPDATA%\multichat-tts
   (за назвою пакета), тепер вони теж у %APPDATA%\MultiChat разом із віджетами. Старий вміст переноситься один раз без перезапису наявних файлів,
   а стару папку видаляємо лише тоді, коли перенесено все без помилок. Має виконатися до готовності програми. */
try {
  const fs = require('fs'), appData = app.getPath('appData');
  const oldDir = path.join(appData, 'multichat-tts'), newDir = path.join(appData, 'MultiChat');
  if (path.resolve(oldDir).toLowerCase() !== path.resolve(newDir).toLowerCase()) {
    if (fs.existsSync(oldDir)) {
      let ok = true;
      try {
        fs.mkdirSync(newDir, { recursive: true });
        fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false, filter: src => !/^(Singleton|lockfile$|LOCK$)/i.test(path.basename(src)) });
      } catch { ok = false; }
      if (ok) { try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch {} }
    }
    app.setPath('userData', newDir);
  }
} catch {}

// налаштування з settings.json (змінюються в інтерфейсі, діють після перезапуску)
let savedSettings = {};
for (const dir of [process.env.MULTICHAT_USERDATA, process.env.MULTICHAT_DIR]) {   // спершу постійна папка (%APPDATA%\MultiChat), потім старе місце поруч із програмою
  if (!dir) continue;
  try { savedSettings = JSON.parse(require('fs').readFileSync(path.join(dir, 'settings.json'), 'utf8')) || {}; break; } catch {}
}
const hwAccel = savedSettings.hardwareAcceleration === true;   // за замовчуванням апаратне прискорення вимкнено
if (!hwAccel) app.disableHardwareAcceleration();   // має викликатися до готовності програми
process.env.MULTICHAT_HWACCEL = hwAccel ? '1' : '0';

/* ---- запуск від імені адміністратора (лише Windows) ---- */
const IS_WIN = process.platform === 'win32';
const wantAdmin = savedSettings.runAsAdmin === true;
const ELEV_CHILD = process.argv.includes('--elevated-child');   // позначає екземпляр, запущений нами з підвищеними правами: сам себе вдруге не перезапускає (захист від циклу)
const isElevated = () => new Promise(resolve => {
  if (!IS_WIN) return resolve(false);
  execFile('fltmc', [], { windowsHide: true, timeout: 8000 }, err => resolve(!err));   // fltmc працює лише з правами адміністратора
});
function relaunchElevated() {
  return new Promise(resolve => {
    const q = x => "'" + String(x).replace(/'/g, "''") + "'";
    const argStr = (app.isPackaged ? '' : '"' + app.getAppPath() + '" ') + '--elevated-child';
    const cmd = `Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${q(argStr)} -Verb RunAs -ErrorAction Stop`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, timeout: 300000 }, (err, _out, errOut) => {
        if (!err) return resolve({ ok: true });
        resolve({ ok: false, reason: String(errOut || err.message || '').trim().split(/\r?\n/)[0].slice(0, 160) });
      });
  });
}
// повертає true, якщо запущено копію з підвищеними правами і цей екземпляр треба закрити
async function handleAdminMode() {
  const elevated = await isElevated();
  process.env.MULTICHAT_ELEVATED = elevated ? '1' : '0';
  if (!IS_WIN || !wantAdmin || elevated) return false;   // права не потрібні або вже є: нічого не запитуємо
  if (ELEV_CHILD) {   // нас уже запускали з підвищенням, а прав немає: не перезапускаємось вдруге
    process.env.MULTICHAT_ADMIN_NOTE = 'Права адміністратора не отримано. Програма працює у звичайному режимі.';
    return false;
  }
  const r = await relaunchElevated();   // тут Windows покаже вікно UAC
  if (r.ok) return true;
  process.env.MULTICHAT_ADMIN_NOTE = 'Запуск від імені адміністратора скасовано або неможливий' + (r.reason ? ' (' + r.reason + ')' : '') + '. Програма працює у звичайному режимі.';
  return false;
}
// перезапуск: з режиму адміністратора повертаємось до звичайного через explorer.exe (він запускає програму без підвищених прав)
global.__multichatRestart = () => {
  try { app.releaseSingleInstanceLock(); } catch {}
  if (IS_WIN && process.env.MULTICHAT_ELEVATED === '1' && !wantAdmin && app.isPackaged) {
    try { spawn('explorer.exe', [process.execPath], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => app.exit(0), 700); return; } catch {}
  }
  app.relaunch(); app.exit(0);
};
const PORT = Number(process.env.PORT || 3000);

let win = null;

function waitForPort(port, tries = 80) {
  return new Promise(resolve => {
    const attempt = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => { s.destroy(); if (--tries <= 0) resolve(false); else setTimeout(attempt, 250); });
    };
    attempt();
  });
}

// повне завершення програми. Прихований браузер Kick теж є вікном, тому «усі вікна закрито» без цього ніколи не настає й програма лишається у фоні
let quitting = false;
function quitApp() {
  if (quitting) return;
  quitting = true;
  global.__multichatQuitting = true;   // server.js більше не створює вікон і не перепідключається
  try { if (global.__multichatCleanup) global.__multichatCleanup(); } catch {}   // зупиняє дочірні процеси (Piper)
  try { for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch {} } } catch {}
  try { app.quit(); } catch {}
  setTimeout(() => app.exit(0), 2500);   // страховка: якщо щось зависло, завершуємо примусово
}
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 700, minHeight: 500,
    backgroundColor: '#0e0e12', autoHideMenuBar: false, title: 'MultiChat',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }
  });
  win.removeMenu(); win.setMenuBarVisibility(false);
  win.loadURL(`http://localhost:${PORT}`);

  // вхід через Google/Twitch відкриваємо в звичайному браузері (Google не пускає вхід у вбудованих вікнах)
  const isExternal = url => {
    try { const u = new URL(url); return u.hostname !== 'localhost' || u.pathname.startsWith('/auth/'); }
    catch { return true; }
  };
  const openHandler = ({ url }) => {
    try { const u = new URL(url); if (u.hostname === 'localhost' && u.pathname === '/multi-editor.html') return { action: 'allow', overrideBrowserWindowOptions: { width: 1700, height: 950, minWidth: 800, minHeight: 500, backgroundColor: '#0e0e12', autoHideMenuBar: false, title: 'MultiChat: мульти-віджет', icon: path.join(__dirname, 'assets', 'icon.ico'), webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } } }; } catch {}
    shell.openExternal(url); return { action: 'deny' };
  };
  win.webContents.setWindowOpenHandler(openHandler);
  win.webContents.on('did-create-window', child => { try { child.removeMenu(); child.setMenuBarVisibility(false); child.webContents.setWindowOpenHandler(openHandler); } catch {} });   // і в окремому вікні редактора немає меню
  win.webContents.on('will-navigate', (e, url) => { if (isExternal(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.on('closed', () => { win = null; quitApp(); });   // закрито головне вікно - програма завершується повністю

  // права кнопка миші: копіювати / вставити / вирізати в полях, копіювання тексту й посилань у чаті
  win.webContents.on('context-menu', async (_e, params) => {
    const w = win;
    if (!w || w.isDestroyed()) return;
    let ctx = null;
    if (!params.isEditable) { try { ctx = await w.webContents.executeJavaScript('window.__ctx || null'); } catch {} }   // що під курсором у чаті
    if (!win || win.isDestroyed()) return;
    const api = {
      writeText: t => clipboard.writeText(String(t)),
      openExternal: u => shell.openExternal(u),
      selectFeed: () => { try { w.webContents.executeJavaScript('window.selectFeed && window.selectFeed()'); } catch {} }
    };
    const tpl = buildTemplate(params, ctx, api);
    if (tpl.length) Menu.buildFromTemplate(tpl).popup({ window: w });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function acquireLock() {
  for (let i = 0; i < 60; i++) {
    if (app.requestSingleInstanceLock()) return true;
    if (!ELEV_CHILD) return false;   // звичайний екземпляр не чекає; екземпляр з підвищеними правами чекає, поки закриється попередній
    await sleep(500);
  }
  return false;
}
(async () => {
  if (!(await acquireLock())) { app.quit(); return; }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', quitApp);
  app.on('before-quit', () => { global.__multichatQuitting = true; });
  await app.whenReady();
  Menu.setApplicationMenu(null);   // без верхнього меню (File, Edit, View...): Alt його більше не відкриває
  app.on('web-contents-created', (_e, wc) => wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    if (k === 'f12' || (input.control && input.shift && k === 'i')) { e.preventDefault(); wc.toggleDevTools(); }
    else if (k === 'f5' || (input.control && !input.shift && k === 'r')) { e.preventDefault(); wc.reload(); }
  }));   // меню немає, тож ці клавіші задаємо самі
  if (await handleAdminMode()) { setTimeout(() => app.exit(0), 300); return; }   // запущено копію з правами адміністратора - цю закриваємо
  require('./server.js');
  await waitForPort(PORT);
  createWindow();
})();
