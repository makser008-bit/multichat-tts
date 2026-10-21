const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const os = require('os');
const WebSocket = require('ws');
const APP_VERSION = require('./package.json').version;

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PLATFORMS = ['twitch', 'youtube', 'tiktok', 'kick'];
const IS_ELECTRON = !!process.versions.electron;   // true лише у вбудованому браузері програми MultiChat.exe
const tfetch = (url, opts = {}, ms = 15000) => fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(ms) });

/* ---------------- конфіг і збережені акаунти ---------------- */
// у зібраному .exe конфіг і акаунти лежать поруч із файлом .exe
const APP_DIR = process.env.MULTICHAT_DIR || (process.pkg ? path.dirname(process.execPath) : __dirname);
const CFG_FILE = path.join(APP_DIR, 'config.json');
const ACC_FILE = path.join(APP_DIR, 'accounts.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = readJson(CFG_FILE, {});
let accounts = readJson(ACC_FILE, {});   // тут лише нік/ID каналу, токени не зберігаються
const saveAccounts = () => fs.writeFileSync(ACC_FILE, JSON.stringify(accounts, null, 2));

const configured = () => ({
  twitch: !!(config.twitchClientId && config.twitchClientSecret),
  youtube: !!(config.googleClientId && config.googleClientSecret),
  kick: !!(config.kickClientId && config.kickClientSecret),
  tiktok: true,
  euler: !!config.eulerApiKey
});

/* ---------------- сервер і WebSocket ---------------- */
const app = express();
app.use(express.json());
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));
// захист: POST-запити приймаємо лише зі сторінки самого застосунку
app.use('/api', (req, res, next) => {
  const o = req.headers.origin;
  if (req.method === 'POST' && o && o !== BASE && o !== `http://127.0.0.1:${PORT}`) return res.status(403).end();
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const lastStatus = {};
const notices = {};
const liveState = {};
const viewers = {};
function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}
const status = (platform, state, info = '') => {
  lastStatus[platform] = { type: 'status', platform, state, info };
  broadcast(lastStatus[platform]);
};
const setViewers = (platform, count) => { viewers[platform] = count; broadcast({ type: 'viewers', platform, count }); };
const setLive = (platform, live) => {
  liveState[platform] = live;
  broadcast({ type: 'live', platform, live });
  if (!live) setViewers(platform, 0);
};
const chat = (platform, user, text) =>
  broadcast({ type: 'chat', platform, user: user || '???', text: text || '', ts: Date.now() });
// події (подарунки, підписки): показуються в чаті, але НЕ озвучуються
const evt = (platform, kind, user, text) =>
  broadcast({ type: 'event', platform, kind, user: user || '???', text: text || '', ts: Date.now() });
// службове повідомлення в чат (наприклад «увійди знову»)
const notice = (platform, text) => { notices[platform] = text; broadcast({ type: 'notice', platform, text }); };

const unesc = v => String(v || '').replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
function twitchNotice(tags, msg) {
  const id = tags['msg-id'];
  const who = unesc(tags['display-name']) || tags['login'] || '???';
  const note = msg ? ' - «' + msg + '»' : '';
  switch (id) {
    case 'sub':
      evt('twitch', 'sub', who, 'нова підписка' + note); break;
    case 'resub': {
      const mo = tags['msg-param-cumulative-months'];
      evt('twitch', 'sub', who, 'поновлення підписки' + (mo ? ` (${mo} міс.)` : '') + note); break;
    }
    case 'subgift':
      if (tags['msg-param-community-gift-id']) break;   // частина масової роздачі - окремо не показуємо
      evt('twitch', 'sub', who, 'подарована підписка для ' + (unesc(tags['msg-param-recipient-display-name']) || '?')); break;
    case 'submysterygift':
      evt('twitch', 'sub', who, 'роздача підписок: ' + (tags['msg-param-mass-gift-count'] || '?')); break;
    case 'raid':
      evt('twitch', 'raid', tags['msg-param-displayName'] || who, 'рейд, глядачів: ' + (tags['msg-param-viewerCount'] || '?')); break;
    case 'giftpaidupgrade':
    case 'anongiftpaidupgrade':
      evt('twitch', 'sub', who, 'поновлення подарованої підписки'); break;
  }
}

// перемикач «використовувати API-ключі для кнопок Увійти» (розділ «API-ключі»): за замовчуванням увімкнено; значення зберігається в settings.json
const apiKeysOn = () => settings.apiKeysEnabled !== false;
const kickDiagOn = () => settings.kickDiagnostics === true;   // «Діагностика Kick» (розділ «Для розробників»): за замовчуванням вимкнено
const useAuth = a => !!(a && a.refreshToken) && apiKeysOn();   // збережений вхід діє лише поки використання ключів увімкнено; самі токени не видаляються
const isLoggedIn = (p, a) => useAuth(a) || (p === 'kick' && !!(a && a.apiLogin) && apiKeysOn());
const eulerKey = () => (apiKeysOn() && config.eulerApiKey) ? config.eulerApiKey : '';
function accountView() {
  const o = {};
  for (const p of PLATFORMS) { const a = accounts[p]; o[p] = a ? { name: a.name || a.login || a.slug || a.username, auth: isLoggedIn(p, a) } : null; }
  return o;
}
function sendAccounts(ws) {
  const s = JSON.stringify({ type: 'accounts', accounts: accountView(), configured: configured(), apiKeys: apiKeysOn(), kickDiag: kickDiagOn() });
  (ws ? [ws] : [...wss.clients]).forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}
/* ---------------- моніторинг інтернет-з'єднання (у фоні, незалежно від вікон) ---------------- */
const NET_T = {   // змінні середовища потрібні лише для тестів
  interval: Number(process.env.NET_INTERVAL_MS) || 5000,         // перевірка, поки інтернет є
  downInterval: Number(process.env.NET_DOWN_INTERVAL_MS) || 3000, // перевірка, поки інтернету немає
  timeout: Number(process.env.NET_TIMEOUT_MS) || 4000,
  failsToDown: Number(process.env.NET_FAILS) || 2                 // скільки невдалих перевірок поспіль означають втрату інтернету
};
// кілька незалежних адрес: інтернет є, якщо відповіла хоча б одна (збій одного сайту чи платформи не вважається втратою мережі)
const NET_PROBES = ['https://www.gstatic.com/generate_204', 'http://www.msftconnecttest.com/connecttest.txt',
  'https://cloudflare.com/cdn-cgi/trace', 'https://www.apple.com/library/test/success.html'];
const NET = { online: true, outage: 0, dismissed: false, since: Date.now(), restoredAt: 0 };
const netMsg = () => ({ type: 'net', online: NET.online, outage: NET.outage, dismissed: NET.dismissed, since: NET.since, restoredAt: NET.restoredAt });
const broadcastNet = () => broadcast(netMsg());
function recoverPlatforms() {   // після відновлення мережі одразу пробуємо підключити платформи, що не в порядку
  for (const p of PLATFORMS) { const st = lastStatus[p]; if (accounts[p] && st && st.state !== 'ok') startPlatform(p); }
}
let netFails = 0;
async function netCheck() {
  let ok = false;
  try {
    await Promise.any(NET_PROBES.map(u => fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(NET_T.timeout) })
      .then(r => { try { r.body && r.body.cancel(); } catch {} return true; })));
    ok = true;
  } catch {}
  if (ok) {
    netFails = 0;
    if (!NET.online) { NET.online = true; NET.dismissed = false; NET.restoredAt = Date.now(); NET.since = Date.now(); broadcastNet(); recoverPlatforms(); }
  } else {
    netFails++;
    if (NET.online && netFails >= NET_T.failsToDown) { NET.online = false; NET.outage++; NET.dismissed = false; NET.since = Date.now(); broadcastNet(); }
  }
  setTimeout(netCheck, NET.online ? NET_T.interval : NET_T.downInterval);
}
app.get('/api/net', (req, res) => res.json(netMsg()));

// Озвучувати має лише ОДНЕ вікно, інакше відкриті одночасно програма й вкладка браузера говорять разом (кожне своїм голосом).
const clientsMeta = new Map();
let speakerId = null;
function electSpeaker() {
  let best = null, bestScore = -1;
  for (const [sock, m] of clientsMeta) {
    if (sock.readyState !== WebSocket.OPEN || !m.canSpeak) continue;
    // вікно, з яким користувач взаємодіяв (клік, клавіша), має пріоритет; інакше перевага в вікна програми над забутою вкладкою браузера
    const score = m.userActive ? 1e15 + m.userActive : m.connected + (m.electron ? 600000 : 0);
    if (score > bestScore) { best = m; bestScore = score; }
  }
  speakerId = best ? best.id : null;
  broadcast({ type: 'speaker', id: speakerId });
}
/* ---------------- показники навантаження: CPU і RAM ---------------- */
// Збір працює лише поки є вікно, яке їх показує (і зупиняється повністю, коли таких немає). Лише процеси самої програми,
// без PowerShell/WMI і без прав адміністратора: Chromium/Electron і модуль os користуються системними викликами Windows.
const SYS_MS = 1500;
const sysSubs = new Set();   // вікна, що зараз показують показники
let sysTimer = null, sysBase = null;
const SYS_CORES = Math.max(1, os.cpus().length || 1);
const sysClamp = v => Math.min(100, Math.max(0, v));
function sysCpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
  return { idle, total };
}
function sysAppNow() {   // у Електроні: усі процеси програми (вікно, GPU, прихований браузер Kick); інакше - поточний процес
  if (IS_ELECTRON) {
    try {
      let cpu = 0, kb = 0;
      for (const m of require('electron').app.getAppMetrics()) {
        cpu += (m.cpu && m.cpu.percentCPUUsage) || 0;   // 100 = одне повне ядро
        const mm = m.memory || {}; kb += mm.privateBytes || mm.workingSetSize || 0;   // приватна пам'ять процесу, КБ
      }
      return { cpu: cpu / SYS_CORES, mem: kb * 1024 };
    } catch {}
  }
  const u = process.cpuUsage();
  return { cpuUs: u.user + u.system, mem: process.memoryUsage().rss };
}
function sysSample() {   // перший виклик після запуску лише запам'ятовує опорні значення: відсотки з'являються з наступного
  const t = Date.now(), ct = sysCpuTimes(), ap = sysAppNow();
  const prev = sysBase; sysBase = { t, ct, cpuUs: ap.cpuUs };
  const total = os.totalmem(), free = os.freemem();
  const out = { type: 'sysStats', ts: t, cores: SYS_CORES, totalMem: total, sys: { cpu: null, usedMem: Math.max(0, total - free) }, app: { cpu: null, usedMem: ap.mem } };
  if (prev) {
    const dt = ct.total - prev.ct.total, di = ct.idle - prev.ct.idle;
    if (dt > 0) out.sys.cpu = sysClamp(100 * (1 - di / dt));
    if (typeof ap.cpu === 'number') out.app.cpu = sysClamp(ap.cpu);
    else if (typeof ap.cpuUs === 'number' && typeof prev.cpuUs === 'number' && t > prev.t) out.app.cpu = sysClamp(100 * (ap.cpuUs - prev.cpuUs) / 1000 / (t - prev.t) / SYS_CORES);
  }
  return out;
}
function sysTick() {
  const s = JSON.stringify(sysSample());
  for (const w of sysSubs) { if (w.readyState === 1) { try { w.send(s); } catch {} } else sysSubs.delete(w); }
  sysUpdateTimer();
}
// Налаштування показників (що показувати, обсяг у дужках, чи показувати в OBS) задає вікно програми, а панель OBS - окремий браузер зі своїм сховищем.
// Тому вікно програми надсилає їх на сервер, а він розсилає всім і віддає щойно підключеним панелям.
let sysCfgLast = null;
function sysCfgClean(m) {
  return { type: 'sysCfg', obs: m.obs !== false, mode: m.mode === 'system' ? 'system' : 'app', mem: m.mem !== false, memFmt: ['usedfree', 'usedtotal'].includes(m.memFmt) ? m.memFmt : 'used' };
}
function sysUpdateTimer() {   // таймер існує лише за наявності підписників
  if (sysSubs.size && !sysTimer) { sysBase = null; sysSample(); sysTimer = setInterval(sysTick, SYS_MS); }
  else if (!sysSubs.size && sysTimer) { clearInterval(sysTimer); sysTimer = null; sysBase = null; }
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'hello') { clientsMeta.set(ws, { id: String(m.id || ''), canSpeak: !!m.canSpeak, electron: !!m.electron, connected: Date.now(), userActive: 0 }); electSpeaker(); }
    else if (m.type === 'active') { const c = clientsMeta.get(ws); if (c) { c.userActive = Date.now(); electSpeaker(); } }
    else if (m.type === 'cmd' && ['skip', 'clearq', 'clearfeed'].includes(m.cmd)) broadcast({ type: 'cmd', cmd: m.cmd });
    else if (m.type === 'sysCfg') { sysCfgLast = sysCfgClean(m); broadcast(sysCfgLast); }   // вікно програми змінило налаштування показників: усі вікна (зокрема панель OBS) оновлюються одразу
    else if (m.type === 'sysSub') { if (m.on === true) sysSubs.add(ws); else sysSubs.delete(ws); sysUpdateTimer(); }   // вікно вмикає/вимикає показники навантаження
    else if (m.type === 'mute' && typeof m.user === 'string') {   // глядача заглушили в одному вікні (напр. у панелі OBS): повідомляємо всі вікна, список озвучення зберігає вікно програми
      const u = m.user.trim().slice(0, 100);
      if (u) broadcast({ type: 'mute', user: u });
    }
    else if (m.type === 'netAck') { if (!NET.online && !NET.dismissed) { NET.dismissed = true; broadcastNet(); } }   // «Добре»: вікно закрите в усіх вікнах, моніторинг триває
  });
  ws.on('close', () => { if (clientsMeta.delete(ws)) electSpeaker(); sysSubs.delete(ws); sysUpdateTimer(); });
  ws.send(JSON.stringify({ type: 'speaker', id: speakerId }));
  if (sysCfgLast) ws.send(JSON.stringify(sysCfgLast));
  sendAccounts(ws);
  Object.values(lastStatus).forEach(s => ws.send(JSON.stringify(s)));
  Object.entries(notices).forEach(([p, t]) => ws.send(JSON.stringify({ type: 'notice', platform: p, text: t })));
  Object.entries(liveState).forEach(([p, l]) => ws.send(JSON.stringify({ type: 'live', platform: p, live: l })));
  Object.entries(viewers).forEach(([p, c]) => ws.send(JSON.stringify({ type: 'viewers', platform: p, count: c })));
  ws.send(JSON.stringify({ type: 'piper', state: 'info', ...piperInfo() }));
  ws.send(JSON.stringify(netMsg()));
});

/* ---------------- OAuth: вхід в акаунти ---------------- */
const qs = o => new URLSearchParams(o).toString();
const redir = p => `${BASE}/auth/${p}/callback`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (title, body) => `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;background:#0e0e12;color:#ececf1;padding:40px;max-width:640px;margin:auto"><h2>${esc(title)}</h2><p>${esc(body)}</p><p><a style="color:#9d86ff" href="/">← Назад</a></p>`;
const authSuccessPage = p => `<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вхід виконано — MultiChat</title><body style="font:16px system-ui;background:#0e0e12;color:#ececf1;padding:40px;max-width:640px;margin:auto"><h2>Вхід виконано</h2><p>Авторизацію для ${esc(({ twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' })[p] || p)} завершено. Повернись у MultiChat. Цю вкладку браузера можна закрити.</p></body></html>`;

async function httpJson(url, opts) {
  const r = await tfetch(url, opts);
  const txt = await r.text();
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status} ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}
const postForm = (url, o) => httpJson(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs(o) });
const getJson = (url, headers) => httpJson(url, { headers });

const OAUTH = {
  twitch: {
    url: state => 'https://id.twitch.tv/oauth2/authorize?' + qs({
      client_id: config.twitchClientId, redirect_uri: redir('twitch'), response_type: 'code',
      scope: 'user:read:chat moderator:read:followers channel:read:redemptions channel:read:hype_train', state, force_verify: 'true' }),
    async finish(code) {
      const t = await postForm('https://id.twitch.tv/oauth2/token', {
        client_id: config.twitchClientId, client_secret: config.twitchClientSecret, code,
        grant_type: 'authorization_code', redirect_uri: redir('twitch') });
      const u = await getJson('https://api.twitch.tv/helix/users', {
        Authorization: 'Bearer ' + t.access_token, 'Client-Id': config.twitchClientId });
      const d = u.data && u.data[0];
      if (!d) throw new Error('Twitch не повернув дані користувача');
      return { login: d.login, name: d.display_name, userId: d.id, refreshToken: t.refresh_token };
    }
  },
  youtube: {
    url: state => 'https://accounts.google.com/o/oauth2/v2/auth?' + qs({
      client_id: config.googleClientId, redirect_uri: redir('youtube'), response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline',
      prompt: 'select_account consent', state }),
    async finish(code) {
      const t = await postForm('https://oauth2.googleapis.com/token', {
        client_id: config.googleClientId, client_secret: config.googleClientSecret, code,
        grant_type: 'authorization_code', redirect_uri: redir('youtube') });
      const c = await getJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { Authorization: 'Bearer ' + t.access_token });
      const it = c.items && c.items[0];
      if (!it) throw new Error('У цього Google-акаунта немає YouTube-каналу');
      return { channelId: it.id, name: it.snippet.title, refreshToken: t.refresh_token };
    }
  },
  kick: {
    url: (state, challenge) => 'https://id.kick.com/oauth/authorize?' + qs({
      response_type: 'code', client_id: config.kickClientId, redirect_uri: redir('kick'),
      scope: 'user:read channel:read', code_challenge: challenge, code_challenge_method: 'S256', state }),
    async finish(code, verifier) {
      const t = await postForm('https://id.kick.com/oauth/token', {
        grant_type: 'authorization_code', client_id: config.kickClientId, client_secret: config.kickClientSecret,
        redirect_uri: redir('kick'), code_verifier: verifier, code });
      const h = { Authorization: 'Bearer ' + t.access_token };
      let name = '', slug = '';
      try { const u = await getJson('https://api.kick.com/public/v1/users', h); name = (u.data && u.data[0] && u.data[0].name) || ''; } catch {}
      try { const c = await getJson('https://api.kick.com/public/v1/channels', h); slug = (c.data && c.data[0] && c.data[0].slug) || ''; } catch {}
      if (!slug && name) slug = name.toLowerCase().replace(/_/g, '-');
      if (!slug) throw new Error('Не вдалося дізнатись нікнейм на Kick');
      return { slug, name: name || slug, apiLogin: true };
    }
  }
};

const pending = new Map();
const API_OFF_PAGE = () => page('API-ключі вимкнено', 'Використання API-ключів вимкнено в налаштуваннях програми (блок «API-ключі» в групі «Програма»). Увімкни його, щоб користуватися кнопкою «Увійти».');
app.get('/auth/:p/login', (req, res) => {
  if (!apiKeysOn()) return res.status(403).send(API_OFF_PAGE());
  const p = req.params.p, o = OAUTH[p];
  if (!o || !configured()[p]) return res.status(400).send(page('Не налаштовано', `Впиши ключі для ${p} у config.json (див. README) і перезапусти сервер.`));
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pending.set(state, { p, verifier, t: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.t > 10 * 60 * 1000) pending.delete(k);
  res.redirect(o.url(state, challenge));
});
app.get('/auth/:p/callback', async (req, res) => {
  if (!apiKeysOn()) return res.status(403).send(API_OFF_PAGE());
  const p = req.params.p, o = OAUTH[p];
  const pend = pending.get(String(req.query.state));
  pending.delete(String(req.query.state));
  if (!o || !pend || pend.p !== p) return res.status(400).send(page('Помилка', 'Невідомий або застарілий запит входу. Спробуй ще раз.'));
  if (req.query.error || !req.query.code) return res.status(400).send(page('Вхід скасовано', String(req.query.error_description || req.query.error || '')));
  try {
    accounts[p] = await o.finish(String(req.query.code), pend.verifier);
    saveAccounts(); sendAccounts(); startPlatform(p);
    res.status(200).send(authSuccessPage(p));
  } catch (e) {
    res.status(500).send(page('Помилка входу', String((e && e.message) || e)));
  }
});

const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
let settings = readJson(SETTINGS_FILE, {});
const isElectron = !!process.env.MULTICHAT_ELECTRON || IS_ELECTRON;
const runningHw = process.env.MULTICHAT_HWACCEL !== '0';   // стан апаратного прискорення в поточному запуску
/* ---------------- пріоритет процесу (лише процеси самої програми, інші процеси Windows не чіпаємо) ---------------- */
const PR = os.constants.priority;
const PRIORITIES = {   // Node на Windows: LOW=Idle, BELOW_NORMAL, NORMAL, ABOVE_NORMAL, HIGH, HIGHEST=Realtime
  idle:        { label: 'Низький (Idle)',                v: PR.PRIORITY_LOW },
  belowNormal: { label: 'Нижче звичайного (Below Normal)', v: PR.PRIORITY_BELOW_NORMAL },
  normal:      { label: 'Звичайний (Normal)',            v: PR.PRIORITY_NORMAL },
  aboveNormal: { label: 'Вище звичайного (Above Normal)', v: PR.PRIORITY_ABOVE_NORMAL },
  high:        { label: 'Високий (High)',                v: PR.PRIORITY_HIGH },
  realtime:    { label: 'Реального часу (Realtime)',     v: PR.PRIORITY_HIGHEST }
};
const curPriority = () => (PRIORITIES[settings.priority] ? settings.priority : 'normal');
let prioState = { error: '', note: '' };
function appPids() {   // тільки процеси цієї програми: головний, вікна, GPU, вбудований браузер Kick
  const set = new Set([process.pid]);
  if (IS_ELECTRON) { try { for (const m of require('electron').app.getAppMetrics()) set.add(m.pid); } catch {} }
  return [...set];
}
function applyPriority() {
  const key = curPriority(), want = PRIORITIES[key].v;
  let ok = 0, fail = 0, lastErr = null, mainGot = null;
  for (const pid of appPids()) {
    try { os.setPriority(pid, want); ok++; if (pid === process.pid) mainGot = os.getPriority(pid); }
    catch (e) { if (e && e.code !== 'ESRCH') { fail++; lastErr = e; } }   // ESRCH: процес уже завершився
  }
  prioState = { error: '', note: '' };
  if (!ok && fail) {
    const denied = lastErr && /EPERM|EACCES|permission|access/i.test(String(lastErr.code || '') + ' ' + String(lastErr.message || ''));
    prioState.error = 'Не вдалося змінити пріоритет' + (denied ? ': недостатньо прав. Спробуй запуск від імені адміністратора або обери нижчий пріоритет.' : ': ' + ((lastErr && lastErr.message) || 'невідома помилка'));
  } else if (mainGot !== null && mainGot !== want) {   // система застосувала інший рівень (так Windows робить з Realtime без прав адміністратора)
    const got = Object.values(PRIORITIES).find(x => x.v === mainGot);
    prioState.note = `Система не дозволила «${PRIORITIES[key].label}» - діє ${got ? '«' + got.label + '»' : 'інший рівень'}. Для вищих рівнів потрібні права адміністратора.`;
  } else if (fail) {
    prioState.note = 'Пріоритет застосовано не до всіх процесів програми (частину змінити не вдалося).';
  }
  return prioState;
}
setInterval(() => { if (curPriority() !== 'normal') applyPriority(); }, 30000).unref();   // нові процеси браузера Kick теж отримують вибраний рівень

const adminSupported = isElectron && process.platform === 'win32';
const isElevatedNow = () => process.env.MULTICHAT_ELEVATED === '1';
const settingsView = () => {
  const want = settings.hardwareAcceleration !== false;
  const runAsAdmin = settings.runAsAdmin === true;
  return {
    electron: isElectron, hardwareAcceleration: want, running: runningHw, restartRequired: isElectron && want !== runningHw,
    priority: curPriority(), priorityError: prioState.error, priorityNote: prioState.note, platform: process.platform,
    runAsAdmin, elevated: isElevatedNow(), adminSupported, adminNote: process.env.MULTICHAT_ADMIN_NOTE || '',
    adminRestartRequired: adminSupported && runAsAdmin !== isElevatedNow(),
    apiKeys: apiKeysOn(),
    kickDiagnostics: kickDiagOn()
  };
};
function applyApiKeysChange() {   // вмикання/вимикання API-ключів: платформи, що користуються входом або ключем, перепідключаємо; ключі й токени лишаються на місці
  for (const k of Object.keys(tokCache)) delete tokCache[k];
  sendAccounts();
  for (const p of ['twitch', 'youtube', 'tiktok']) if (accounts[p]) startPlatform(p);
}
app.get('/api/settings', (req, res) => res.json(settingsView()));
app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  const prev = { ...settings };
  if (typeof b.hardwareAcceleration === 'boolean') settings.hardwareAcceleration = b.hardwareAcceleration;
  if (typeof b.priority === 'string') {
    if (!PRIORITIES[b.priority]) return res.status(400).json({ error: 'невідомий рівень пріоритету' });
    settings.priority = b.priority;
  }
  if (typeof b.apiKeysEnabled === 'boolean') settings.apiKeysEnabled = b.apiKeysEnabled;
  if (typeof b.kickDiagnostics === 'boolean') settings.kickDiagnostics = b.kickDiagnostics;
  if (typeof b.runAsAdmin === 'boolean') {
    if (b.runAsAdmin && !adminSupported) return res.status(400).json({ error: 'запуск від імені адміністратора доступний лише в програмі MultiChat.exe на Windows' });
    settings.runAsAdmin = b.runAsAdmin;
  }
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
  catch (e) { settings = prev; return res.status(500).json({ error: 'Не вдалося зберегти налаштування: ' + String((e && e.message) || e) }); }
  if (typeof b.priority === 'string') applyPriority();   // застосовується одразу, без перезапуску
  if (typeof b.apiKeysEnabled === 'boolean' && (prev.apiKeysEnabled !== false) !== apiKeysOn()) applyApiKeysChange();
  if (typeof b.kickDiagnostics === 'boolean' && (prev.kickDiagnostics === true) !== kickDiagOn()) {   // вмикання/вимикання діагностики Kick
    if (kickDiagOn()) kickLog('діагностику Kick ввімкнено');
    else kickDebug.length = 0;   // вимкнено: накопичені записи (разом зі зразками повідомлень) стираємо
    sendAccounts();   // вікна дізнаються про зміну й ховають/показують кнопку
  }
  res.json(settingsView());
});
app.post('/api/restart', (req, res) => {
  if (typeof global.__multichatRestart !== 'function') return res.status(400).json({ error: 'доступно лише в програмі MultiChat.exe' });
  res.json({ ok: true });
  setTimeout(() => global.__multichatRestart(), 300);
});
app.post('/api/config', (req, res) => {
  if (!apiKeysOn()) return res.status(403).json({ error: 'API-ключі вимкнено в налаштуваннях' });
  const allowed = ['twitchClientId', 'twitchClientSecret', 'googleClientId', 'googleClientSecret', 'kickClientId', 'kickClientSecret', 'eulerApiKey'];
  for (const k of allowed) { const v = req.body && req.body[k]; if (typeof v === 'string' && v.trim()) config[k] = v.trim(); }
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { return res.status(500).json({ error: String((e && e.message) || e) }); }
  sendAccounts();
  res.json({ ok: true });
});
app.post('/api/config/clear', (req, res) => {
  if (!apiKeysOn()) return res.status(403).json({ error: 'API-ключі вимкнено в налаштуваннях' });
  const names = ['twitchClientId', 'twitchClientSecret', 'googleClientId', 'googleClientSecret', 'kickClientId', 'kickClientSecret', 'eulerApiKey'];
  const hadEuler = !!config.eulerApiKey;
  for (const k of names) delete config[k];
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { return res.status(500).json({ error: String((e && e.message) || e) }); }
  // токени доступу без ключів марні: прибираємо їх, а ніки й канали лишаємо (чат працює і без входу)
  const restart = [];
  for (const p of ['twitch', 'youtube']) {
    const a = accounts[p];
    if (a && (a.refreshToken || a.userId)) { delete a.refreshToken; delete a.userId; restart.push(p); }
  }
  if (hadEuler && accounts.tiktok) restart.push('tiktok');   // підключення TikTok було з ключем: перепідключаємо без нього
  saveAccounts();
  for (const k of Object.keys(tokCache)) delete tokCache[k];
  sendAccounts();
  for (const p of restart) startPlatform(p);
  res.json({ ok: true, restarted: restart });
});
app.post('/api/logout/:p', (req, res) => {
  const p = req.params.p;
  if (!PLATFORMS.includes(p)) return res.status(400).json({ error: 'bad platform' });
  delete accounts[p]; saveAccounts(); stopPlatform(p); status(p, 'off', ''); setLive(p, null); sendAccounts();
  res.json({ ok: true });
});
function parseChannelInput(p, v) {
  v = String(v || '').trim();
  if (p === 'twitch') {
    const login = v.replace(/^.*twitch\.tv\//i, '').replace(/^[@#]/, '').split(/[/?]/)[0].toLowerCase();
    return /^\w{3,25}$/.test(login) ? { login, name: login } : null;
  }
  if (p === 'kick') {
    const slug = v.replace(/^.*kick\.com\//i, '').replace(/^@/, '').split(/[/?]/)[0].trim().toLowerCase().replace(/_/g, '-');
    return slug ? { slug, name: slug } : null;
  }
  if (p === 'tiktok') {
    const u = v.replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').split(/[/?]/)[0].trim();
    return u ? { username: u, name: '@' + u } : null;
  }
  if (p === 'youtube') {
    const vid = v.match(/(?:v=|youtu\.be\/|live\/)([\w-]{11})/);
    if (vid) return { liveId: vid[1], name: 'live ' + vid[1] };
    const ch = v.match(/channel\/(UC[\w-]{22})/) || v.match(/^(UC[\w-]{22})$/);
    if (ch) return { channelId: ch[1], name: ch[1] };
    const h = v.match(/(@[\w.\-]+)/);
    if (h) return { handle: h[1], name: h[1] };
    if (/^[\w-]{11}$/.test(v)) return { liveId: v, name: 'live ' + v };
  }
  return null;
}
app.post('/api/channel/:p', (req, res) => {
  const p = req.params.p;
  if (!PLATFORMS.includes(p)) return res.status(400).json({ error: 'bad platform' });
  const acc = parseChannelInput(p, req.body.value);
  if (!acc) return res.status(400).json({ error: 'bad value' });
  accounts[p] = acc;
  saveAccounts(); sendAccounts(); startPlatform(p);
  res.json({ ok: true });
});
app.post('/api/kick-chatroom', (req, res) => {
  const id = String(req.body.id || '').replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: 'bad id' });
  const a = accounts.kick || { slug: '', name: 'chatroom ' + id };
  a.chatroomId = id; accounts.kick = a;
  saveAccounts(); sendAccounts(); startPlatform('kick');
  res.json({ ok: true });
});

/* ---------------- Офлайн-голоси Piper (жіночі українські: Tetiana, Lada) ---------------- */
const isAscii = t => /^[\x20-\x7e]*$/.test(t);
// Piper (C++) на Windows не відкриває файли в шляхах з не-ASCII символами (наприклад "Рабочий стол"):
// у такому разі зберігаємо голоси в C:\ProgramData\MultiChat\voices
function pickVoicesDir() {
  const local = path.join(APP_DIR, 'voices');
  if (isAscii(local)) return local;
  const base = process.env.ProgramData || (process.platform === 'win32' ? 'C:\\ProgramData' : os.tmpdir());
  return path.join(base, 'MultiChat', 'voices');
}
const VOICES_DIR = pickVoicesDir();
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const PIPER_VOICES = {
  'uk-tetiana': { lang: 'uk', label: 'Tetiana', quality: 'висока якість', mb: 114, path: 'uk/uk_UA/tetiana/high/uk_UA-tetiana-high.onnx' },
  'uk-lada': { lang: 'uk', label: 'Lada', quality: 'проста якість, швидка', mb: 21, path: 'uk/uk_UA/lada/x_low/uk_UA-lada-x_low.onnx' },
};
for (const v of Object.values(PIPER_VOICES)) v.file = v.path.split('/').pop();
const PIPER_ENGINE = (() => {
  const base = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/';
  if (process.platform === 'win32') return { url: base + 'piper_windows_amd64.zip', archive: 'piper.zip' };
  if (process.platform === 'linux' && process.arch === 'x64') return { url: base + 'piper_linux_x86_64.tar.gz', archive: 'piper.tar.gz' };
  return null;
})();
let exeCache = null;
function findPiperExe() {
  const name = process.platform === 'win32' ? 'piper.exe' : 'piper';
  const walk = (dir, depth) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const it of items) if (it.isFile() && it.name === name) return path.join(dir, it.name);
    if (depth > 0) for (const it of items) {
      if (it.isDirectory() && it.name !== 'espeak-ng-data') { const r = walk(path.join(dir, it.name), depth - 1); if (r) return r; }
    }
    return null;
  };
  return walk(VOICES_DIR, 3);
}
const piperExe = () => {
  if (exeCache && fs.existsSync(exeCache)) return exeCache;
  const f = findPiperExe();
  if (f) { exeCache = f; return f; }
  return path.join(VOICES_DIR, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
};
const piperInfo = () => ({
  supported: !!PIPER_ENGINE,
  engine: fs.existsSync(piperExe()),
  voices: Object.fromEntries(Object.entries(PIPER_VOICES).map(([id, v]) => [id, {
    lang: v.lang, label: v.label, quality: v.quality, mb: v.mb,
    installed: fs.existsSync(path.join(VOICES_DIR, v.file)) && fs.existsSync(path.join(VOICES_DIR, v.file + '.json'))
  }]))
});

async function downloadTo(url, dest, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  const total = Number(r.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await new Promise(res => out.once('drain', res));
    if (onProgress) onProgress(got, total);
  }
  await new Promise((res, rej) => { out.on('error', rej); out.end(res); });
  fs.renameSync(tmp, dest);
}
function runCmd(cmd, args) {
  return new Promise((res, rej) => execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 26 },
    (e, so, se) => e ? rej(new Error(String(se || e.message).slice(0, 200))) : res()));
}
async function extractArchive(file, dest) {
  if (file.endsWith('.zip')) {
    try { await runCmd('tar', ['-xf', file, '-C', dest]); }
    catch { await runCmd('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${dest}' -Force`]); }
  } else {
    await runCmd('tar', ['-xzf', file, '-C', dest]);
  }
}
async function installPiperVoice(id) {
  const v = PIPER_VOICES[id];
  if (!v) throw new Error('невідомий голос');
  if (!PIPER_ENGINE) throw new Error('автовстановлення Piper доступне лише для Windows і Linux x64');
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  let last = 0;
  const prog = info => (got, total) => {
    const now = Date.now();
    if (now - last < 400 && got !== total) return;
    last = now;
    broadcast({ type: 'piper', state: 'downloading', voice: id, info, pct: total ? Math.round(got / total * 100) : null });
  };
  if (!fs.existsSync(piperExe())) {
    const arc = path.join(VOICES_DIR, PIPER_ENGINE.archive);
    await downloadTo(PIPER_ENGINE.url, arc, prog('рушій Piper'));
    broadcast({ type: 'piper', state: 'downloading', voice: id, info: 'розпаковка рушія…', pct: null });
    await extractArchive(arc, VOICES_DIR);
    try { fs.unlinkSync(arc); } catch {}
    if (!fs.existsSync(piperExe())) throw new Error('після розпаковки не знайдено piper');
    if (process.platform !== 'win32') { try { fs.chmodSync(piperExe(), 0o755); } catch {} }
  }
  const onnx = path.join(VOICES_DIR, v.file);
  if (!fs.existsSync(onnx)) await downloadTo(HF + v.path, onnx, prog('голос ' + v.label));
  if (!fs.existsSync(onnx + '.json')) await downloadTo(HF + v.path + '.json', onnx + '.json');
}
let piperBusy = false;
app.get('/api/piper', (req, res) => res.json(piperInfo()));
app.post('/api/piper/install', async (req, res) => {
  const id = String(req.body.voice || '');
  if (!PIPER_VOICES[id]) return res.status(400).json({ error: 'bad voice' });
  if (piperBusy) return res.status(409).json({ error: 'busy' });
  piperBusy = true;
  res.json({ ok: true });
  try {
    await installPiperVoice(id);
    broadcast({ type: 'piper', state: 'ready', voice: id, ...piperInfo() });
  } catch (e) {
    console.error('piper install:', e && e.message);
    broadcast({ type: 'piper', state: 'error', voice: id, info: String((e && e.message) || e).slice(0, 200), ...piperInfo() });
  }
  piperBusy = false;
});

let piperQueue = Promise.resolve();
const piperProcs = new Set();   // запущені процеси Piper: при виході з програми їх зупиняємо
global.__multichatCleanup = () => { for (const p of piperProcs) { try { p.kill(); } catch {} } piperProcs.clear(); };
function piperRun(exe, id, text, scale, useJson) {
  const v = PIPER_VOICES[id];
  return new Promise((resolve, reject) => {
    const out = path.join(VOICES_DIR, 'tmp-' + crypto.randomBytes(6).toString('hex') + '.wav');
    const args = ['--model', path.join(VOICES_DIR, v.file), '--output_file', out, '--length_scale', scale];
    const espeak = path.join(path.dirname(exe), 'espeak-ng-data');
    if (fs.existsSync(espeak)) args.push('--espeak_data', espeak);
    if (useJson) args.push('--json-input');
    let p;
    try { p = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true }); }
    catch (e) { return reject(new Error('не вдалося запустити piper: ' + e.message)); }
    piperProcs.add(p); p.once('close', () => piperProcs.delete(p)); p.once('error', () => piperProcs.delete(p));
    let err = '', finished = false;
    const cleanup = () => { try { fs.unlinkSync(out); } catch {} };
    const t = setTimeout(() => { if (finished) return; finished = true; try { p.kill(); } catch {} cleanup(); reject(new Error('таймаут 45 с')); }, 45000);
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { if (finished) return; finished = true; clearTimeout(t); cleanup(); reject(new Error('не вдалося запустити piper: ' + e.message)); });
    p.on('close', code => {
      if (finished) return;
      finished = true; clearTimeout(t);
      try {
        if (code !== 0) throw new Error('piper завершився з кодом ' + code + (err ? ': ' + err.trim().slice(-200) : ''));
        const buf = fs.readFileSync(out);
        if (buf.length < 100) throw new Error('piper створив порожній звук' + (err ? ': ' + err.trim().slice(-200) : ''));
        resolve(buf);
      } catch (e) { reject(e); } finally { cleanup(); }
    });
    p.stdin.on('error', () => {});
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (useJson) {
      // ASCII-безпечний JSON: кирилиця йде як \uXXXX, тож кодування stdin у Windows не має значення
      const json = JSON.stringify({ text: clean }).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      p.stdin.end(json + '\n');
    } else {
      p.stdin.end(Buffer.from(clean + '\n', 'utf8'));
    }
  });
}
function piperSynth(id, text, rate) {
  const v = PIPER_VOICES[id];
  const exe = piperExe();
  if (!v || !piperInfo().voices[id].installed) return Promise.reject(new Error('голос не встановлено: натисни «Завантажити» в блоці «Офлайн-голоси»'));
  if (!fs.existsSync(exe)) return Promise.reject(new Error('не знайдено рушій piper: натисни «Завантажити» в блоці «Офлайн-голоси»'));
  const scale = Math.max(0.5, Math.min(2, 1 / rate)).toFixed(2);
  const job = async () => {
    try { return await piperRun(exe, id, text, scale, true); }
    catch (e1) {
      try { return await piperRun(exe, id, text, scale, false); }   // запасний режим: звичайний текст у stdin
      catch (e2) { throw new Error(e1.message + (e2.message !== e1.message ? ' | запасний режим: ' + e2.message : '')); }
    }
  };
  const run = piperQueue.then(job, job);
  piperQueue = run.catch(() => {});
  return run;
}
// перевірка офлайн-голосів: показує, на якому кроці проблема
app.post('/api/piper/diagnose', async (req, res) => {
  const lines = [];
  const info = piperInfo();
  const asked = String((req.body && req.body.voice) || '');
  const id = PIPER_VOICES[asked] ? asked : (Object.keys(PIPER_VOICES).find(k => info.voices[k].installed) || 'uk-lada');
  lines.push('Платформа: ' + process.platform + ' ' + process.arch);
  lines.push('Папка голосів: ' + VOICES_DIR + (isAscii(VOICES_DIR) ? '' : '  (УВАГА: шлях має не-ASCII символи)'));
  const exe = piperExe();
  lines.push('Рушій piper: ' + (fs.existsSync(exe) ? exe : 'НЕ ЗНАЙДЕНО'));
  if (fs.existsSync(exe)) lines.push('espeak-ng-data: ' + (fs.existsSync(path.join(path.dirname(exe), 'espeak-ng-data')) ? 'є' : 'НЕМАЄ поруч із рушієм'));
  for (const [k, v] of Object.entries(PIPER_VOICES)) {
    let size = 'немає файлу';
    try { size = Math.round(fs.statSync(path.join(VOICES_DIR, v.file)).size / 1048576) + ' МБ'; } catch {}
    lines.push(`Голос ${v.label}: ${info.voices[k].installed ? 'встановлено' : 'не встановлено'} (${size})`);
  }
  if (info.voices[id].installed && fs.existsSync(exe)) {
    const t0 = Date.now();
    try {
      const buf = await piperSynth(id, 'Привіт, це перевірка голосу.', 1);
      lines.push(`Тест синтезу (${PIPER_VOICES[id].label}): ОК, ${Math.round(buf.length / 1024)} КБ за ${Date.now() - t0} мс`);
    } catch (e) { lines.push(`Тест синтезу (${PIPER_VOICES[id].label}): ПОМИЛКА - ${(e && e.message) || e}`); }
  } else lines.push('Тест синтезу пропущено: спершу завантаж рушій і голос.');
  res.json({ lines });
});

/* ---------------- Нейронні голоси через Microsoft Edge TTS (укр.: Polina - жін., Ostap - чол.) ---------------- */
const EDGE_VOICES = ['uk-UA-PolinaNeural', 'uk-UA-OstapNeural'];
const ttsCache = new Map();
app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  const voice = String(req.query.voice || '');
  if (text && voice.startsWith('gtts:')) {   // Google Translate TTS (неофіційно): жіночий голос
    try {
      const lang = voice.slice(5);
      if (lang !== 'uk') return res.status(400).end();
      const key = voice + '|' + text;
      let buf = ttsCache.get(key);
      if (!buf) {
        const r = await fetch('https://translate.google.com/translate_tts?' + qs({ ie: 'UTF-8', q: text.slice(0, 200), tl: lang, client: 'tw-ob' }),
          { headers: { 'User-Agent': UA, Referer: 'https://translate.google.com/' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        buf = Buffer.from(await r.arrayBuffer());
        ttsCache.set(key, buf);
        if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value);
      }
      return res.set('Content-Type', 'audio/mpeg').send(buf);
    } catch (e) {
      console.error('gtts:', e && e.message);
      return res.status(502).set('Content-Type', 'text/plain; charset=utf-8').send('Google-голос: ' + String((e && e.message) || e));
    }
  }
  if (text && voice.startsWith('piper:')) {
    try {
      const rate = Math.max(0.5, Math.min(2, Number(req.query.rate) || 1));
      const key = voice + '|' + rate + '|' + text;
      let buf = ttsCache.get(key);
      if (!buf) {
        buf = await piperSynth(voice.slice(6), text, rate);
        ttsCache.set(key, buf);
        if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value);
      }
      return res.set('Content-Type', 'audio/wav').send(buf);
    } catch (e) {
      console.error('piper tts:', e && e.message);
      return res.status(502).set('Content-Type', 'text/plain; charset=utf-8').send('Офлайн-голос: ' + String((e && e.message) || e));
    }
  }
  if (!text || !EDGE_VOICES.includes(voice)) return res.status(400).end();
  const rate = Math.max(0.5, Math.min(2, Number(req.query.rate) || 1));
  const pct = Math.round((rate - 1) * 100);
  const rateStr = (pct >= 0 ? '+' : '') + pct + '%';
  const key = voice + '|' + rateStr + '|' + text;
  try {
    let buf = ttsCache.get(key);
    if (!buf) {
      const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = await tts.toStream(text, { rate: rateStr });
      buf = await new Promise((resolve, reject) => {
        const chunks = [];
        const t = setTimeout(() => reject(new Error('timeout')), 15000);
        const fin = () => { clearTimeout(t); resolve(Buffer.concat(chunks)); };
        audioStream.on('data', d => chunks.push(d));
        audioStream.on('end', fin);
        audioStream.on('close', fin);
        audioStream.on('error', e => { clearTimeout(t); reject(e); });
      });
      if (!buf.length) throw new Error('порожня відповідь');
      ttsCache.set(key, buf);
      if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value);
    }
    res.set('Content-Type', 'audio/mpeg').send(buf);
  } catch (e) {
    console.error('tts:', e && e.message);
    res.status(502).set('Content-Type', 'text/plain; charset=utf-8').send('Нейронний голос: ' + String((e && e.message) || e));
  }
});

/* ---------------- токени для Twitch EventSub і YouTube (refresh-токени зберігаються в accounts.json) ---------------- */
const tokCache = {};
async function twitchAccessToken(a) {
  const c = tokCache.twitch;
  if (c && c.exp > Date.now() + 60000) return c.token;
  const t = await postForm('https://id.twitch.tv/oauth2/token', {
    client_id: config.twitchClientId, client_secret: config.twitchClientSecret,
    grant_type: 'refresh_token', refresh_token: a.refreshToken });
  tokCache.twitch = { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
  if (t.refresh_token && t.refresh_token !== a.refreshToken) { a.refreshToken = t.refresh_token; saveAccounts(); }
  return t.access_token;
}
async function googleAccessToken(a) {
  const c = tokCache.google;
  if (c && c.exp > Date.now() + 60000) return c.token;
  const t = await postForm('https://oauth2.googleapis.com/token', {
    client_id: config.googleClientId, client_secret: config.googleClientSecret,
    grant_type: 'refresh_token', refresh_token: a.refreshToken });
  tokCache.google = { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
  return t.access_token;
}

function twitchEventSub(type, e, a) {
  switch (type) {
    case 'stream.online': setLive('twitch', true); break;
    case 'stream.offline': setLive('twitch', false); break;
    case 'channel.follow':
      evt('twitch', 'follow', e.user_name, 'новий фоловер'); break;
    case 'channel.channel_points_custom_reward_redemption.add':
      evt('twitch', 'points', e.user_name, 'нагорода «' + ((e.reward && e.reward.title) || '?') + '»' + (e.user_input ? ' - «' + e.user_input + '»' : '')); break;
    case 'channel.hype_train.begin':
      evt('twitch', 'hype', a.name, 'Hype Train розпочався!'); break;
    case 'channel.hype_train.end':
      evt('twitch', 'hype', a.name, 'Hype Train завершився' + (e.level ? ` (рівень ${e.level})` : '')); break;
  }
}
function startTwitchEvents(a) {
  if (!useAuth(a) || !a.userId) {   // без входу (або коли API-ключі вимкнено) подій Twitch немає, чат працює за ніком
    if (apiKeysOn() && configured().twitch) notice('twitch', 'Щоб бачити фоли, нагороди й Hype Train, натисни «Увійти для фолів» у блоці акаунтів.');
    return { stop() {} };
  }
  let ws = null, stopped = false, timer = null, last = Date.now(), warned = false;
  const seen = new Set();
  const subscribeAll = async sessionId => {
    let token;
    try { token = await twitchAccessToken(a); }
    catch (e) { notice('twitch', 'Не вдалось оновити токен Twitch - натисни «Вийти» і увійди знову.'); return; }
    const headers = { 'Client-Id': config.twitchClientId, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    try {
      const r = await getJson('https://api.twitch.tv/helix/streams?user_id=' + a.userId, headers);
      setLive('twitch', !!(r.data && r.data.length));
    } catch {}
    const cond = { broadcaster_user_id: a.userId };
    const subs = [
      { type: 'channel.follow', version: '2', condition: { ...cond, moderator_user_id: a.userId } },
      { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: cond },
      { type: 'channel.hype_train.begin', version: '1', condition: cond },
      { type: 'channel.hype_train.end', version: '1', condition: cond },
      { type: 'stream.online', version: '1', condition: cond },
      { type: 'stream.offline', version: '1', condition: cond }
    ];
    for (const s of subs) {
      try {
        await httpJson('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method: 'POST', headers, body: JSON.stringify({ ...s, transport: { method: 'websocket', session_id: sessionId } }) });
      } catch (e) {
        console.error('eventsub', s.type, String(e.message).slice(0, 200));
        if (!warned && /HTTP 40[13]/.test(e.message)) { warned = true; notice('twitch', 'Немає дозволу на частину подій Twitch - натисни «Вийти» і увійди знову.'); }
      }
    }
  };
  const connect = (url, prev) => {
    const sock = new WebSocket(url || 'wss://eventsub.wss.twitch.tv/ws');
    ws = sock; last = Date.now();
    sock.on('message', raw => {
      last = Date.now();
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const t = m.metadata && m.metadata.message_type;
      if (t === 'session_welcome') {
        if (prev) { try { prev.close(); } catch {} } else subscribeAll(m.payload.session.id);
      } else if (t === 'session_reconnect') {
        connect(m.payload.session.reconnect_url, sock);
      } else if (t === 'notification') {
        const id = m.metadata.message_id;
        if (seen.has(id)) return;
        seen.add(id); if (seen.size > 200) seen.delete(seen.values().next().value);
        twitchEventSub(m.payload.subscription.type, m.payload.event || {}, a);
      }
    });
    sock.on('close', () => { if (!stopped && ws === sock) timer = setTimeout(() => connect(), 5000); });
    sock.on('error', () => {});
  };
  connect();
  const watchdog = setInterval(() => { if (ws && Date.now() - last > 45000) { try { ws.terminate(); } catch {} } }, 15000);
  return { stop() { stopped = true; clearTimeout(timer); clearInterval(watchdog); try { ws && ws.close(); } catch {} } };
}

// нові підписники YouTube: опитування API раз на хвилину, лише поки йде стрім (1 одиниця квоти за запит)
function startYouTubeSubs(a) {
  let stopped = false, timer = null, seen = null, warned = false;
  const poll = async () => {
    if (stopped) return;
    try {
      const tok = await googleAccessToken(a);
      const r = await getJson('https://www.googleapis.com/youtube/v3/subscriptions?part=subscriberSnippet&myRecentSubscribers=true&maxResults=10',
        { Authorization: 'Bearer ' + tok });
      const items = r.items || [];
      if (seen === null) seen = new Set(items.map(i => i.id));
      else items.slice().reverse().forEach(i => {
        if (seen.has(i.id)) return;
        seen.add(i.id);
        evt('youtube', 'follow', (i.subscriberSnippet && i.subscriberSnippet.title) || '???', 'новий підписник');
      });
    } catch (e) {
      console.error('youtube subs:', String(e.message).slice(0, 200));
      if (!warned && /invalid_grant|HTTP 40[13]/.test(e.message)) {
        warned = true;
        notice('youtube', 'Немає доступу до підписників YouTube - натисни «Вийти» і увійди знову (у режимі Testing Google скидає доступ кожні 7 днів).');
      }
    }
    if (!stopped) timer = setTimeout(poll, 60000);
  };
  poll();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

/* ---------------- лічильники глядачів: Twitch, YouTube ---------------- */
const TWITCH_GQL_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko';   // публічний client-id вебсайту Twitch
async function twitchStreamInfo(login) {
  const r = await tfetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': TWITCH_GQL_CLIENT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query{user(login:"${login}"){stream{viewersCount}}}` })
  });
  const j = await r.json();
  const u = j && j.data && j.data.user;
  if (!u) return null;
  return u.stream ? { live: true, viewers: u.stream.viewersCount || 0 } : { live: false, viewers: 0 };
}
function startTwitchStats(login) {
  let stopped = false, timer = null;
  const poll = async () => {
    if (stopped) return;
    try {
      const i = await twitchStreamInfo(login);
      if (i && !stopped) { setLive('twitch', i.live); if (i.live) setViewers('twitch', i.viewers); }
    } catch (e) { console.error('twitch stats:', String((e && e.message) || e).slice(0, 120)); }
    if (!stopped) timer = setTimeout(poll, 30000);
  };
  poll();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
async function youtubeViewerCount(a, videoId) {
  if (useAuth(a)) {
    try {
      const tok = await googleAccessToken(a);
      const r = await getJson('https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=' + encodeURIComponent(videoId),
        { Authorization: 'Bearer ' + tok });
      const d = r.items && r.items[0] && r.items[0].liveStreamingDetails;
      if (d && d.concurrentViewers != null) return Number(d.concurrentViewers);
    } catch {}
  }
  // без входу: сторінка відео (неофіційно)
  const r = await tfetch('https://www.youtube.com/watch?v=' + encodeURIComponent(videoId),
    { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
  const t = await r.text();
  const m = t.match(/"originalViewCount":"(\d+)"/);
  return m ? Number(m[1]) : null;
}
function startYouTubeViewers(a, videoId) {
  let stopped = false, timer = null;
  const poll = async () => {
    if (stopped) return;
    try { const n = await youtubeViewerCount(a, videoId); if (n != null && !stopped) setViewers('youtube', n); }
    catch (e) { console.error('youtube viewers:', String((e && e.message) || e).slice(0, 120)); }
    if (!stopped) timer = setTimeout(poll, 30000);
  };
  poll();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

/* ---------------- Twitch (анонімний IRC; нік береться з акаунта) ---------------- */
function startTwitch(a) {
  const channel = a.login;
  let ws, stopped = false, timer;
  const open = () => {
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.on('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
      ws.send('JOIN #' + channel);
    });
    ws.on('message', data => {
      data.toString().split('\r\n').filter(Boolean).forEach(line => {
        if (line.startsWith('PING')) return ws.send('PONG :tmi.twitch.tv');
        if (line.includes(' 001 ')) status('twitch', 'ok', '#' + channel);
        const un = line.match(/^@(\S+) :tmi\.twitch\.tv USERNOTICE #\S+(?: :(.*))?$/);
        if (un) {
          const t = {};
          un[1].split(';').forEach(kv => { const i = kv.indexOf('='); t[kv.slice(0, i)] = kv.slice(i + 1); });
          twitchNotice(t, un[2]);
          return;
        }
        const m = line.match(/^(?:@(\S+) )?:([^!]+)![^ ]+ PRIVMSG #\S+ :(.*)$/);
        if (m) {
          const tags = {};
          (m[1] || '').split(';').forEach(kv => { const [k, v] = kv.split('='); tags[k] = v; });
          const nm = tags['display-name'] || m[2];
          if (tags.bits) evt('twitch', 'bits', nm, 'біти: ' + tags.bits);
          chat('twitch', nm, m[3]);
        }
      });
    });
    ws.on('close', () => { if (!stopped) { status('twitch', 'connecting', 'перепідключення…'); timer = setTimeout(open, 3000); } });
    ws.on('error', () => {});
  };
  open();
  const ev = startTwitchEvents(a);
  const stats = startTwitchStats(channel);
  return { stop() { stopped = true; clearTimeout(timer); try { ws.close(); } catch {} ev.stop(); stats.stop(); } };
}

/* ---------------- YouTube (youtube-chat за channelId; сам чекає початку стріму) ---------------- */
const YT_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };
// без входу: сторінка /live каналу. Якщо канал у ефірі, YouTube віддає сторінку відео з ознакою isLiveNow
async function ytScrapeLive(a) {
  const base = a.channelId ? 'https://www.youtube.com/channel/' + a.channelId : 'https://www.youtube.com/' + String(a.handle || '').replace(/^\/+/, '');
  const r = await tfetch(base + '/live', { headers: YT_HEADERS, redirect: 'follow' });
  const t = await r.text();
  const canon = t.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  return canon && /"isLiveNow":true|"isLive":true/.test(t) ? canon[1] : null;
}
async function ytDetectLive(a) {
  if (useAuth(a)) {   // після входу: активна трансляція каналу через API (1 одиниця квоти)
    try {
      const tok = await googleAccessToken(a);
      const r = await getJson('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,status&broadcastStatus=active&mine=true&maxResults=5',
        { Authorization: 'Bearer ' + tok });
      if (r.items && r.items[0]) return r.items[0].id;
    } catch (e) { console.error('youtube api detect:', String((e && e.message) || e).slice(0, 160)); }
  }
  if (a.channelId || a.handle) return ytScrapeLive(a);
  return null;
}
function startYouTube(a) {
  const { LiveChat } = require('youtube-chat');
  let stopped = false, lc = null, timer = null, helpers = null;
  const stopHelpers = () => { if (helpers) { helpers.stop(); helpers = null; } };
  const wait = (msg, keepLive) => {
    if (stopped) return;
    stopHelpers();
    const old = lc; lc = null;
    try { old && old.stop(); } catch {}
    status('youtube', 'waiting', msg);
    if (!keepLive) setLive('youtube', false);
    clearTimeout(timer);
    timer = setTimeout(attempt, 30000);
  };
  const attempt = async () => {
    if (stopped) return;
    status('youtube', 'connecting', '');
    let id = a.liveId || null;
    if (!id) { try { id = await ytDetectLive(a); } catch (e) { console.error('youtube detect:', String((e && e.message) || e).slice(0, 160)); } }
    if (stopped) return;
    if (!id) return wait('очікування початку стріму');
    setLive('youtube', true);   // стрім знайдено: на значку «Онлайн»
    stopHelpers();
    const vp = startYouTubeViewers(a, id);
    const sp = useAuth(a) ? startYouTubeSubs(a) : null;
    helpers = { stop() { vp.stop(); if (sp) sp.stop(); } };
    if (!sp && apiKeysOn()) notice('youtube', 'Щоб бачити нових підписників, натисни «Увійти» біля YouTube.');
    const me = new LiveChat({ liveId: id });
    lc = me;
    me.on('start', () => { if (lc === me) status('youtube', 'ok', 'live ' + id); });
    me.on('end', () => { if (lc === me) wait('стрім завершено, очікую наступний'); });
    me.on('error', e => console.error('youtube:', e && e.message));
    me.on('chat', c => {
      const text = (c.message || []).map(p => p.text || p.emojiText || '').join('');
      const name = c.author && c.author.name;
      if (process.env.DEBUG_EVENTS) console.log('youtube item:', JSON.stringify(c));
      // нові учасники каналу (Join): приблизне визначення; звичайні підписники в чаті YouTube не відображаються
      if (c.isMembership && (!text.trim() || /welcome to|ласкаво просимо|new member|just joined|нов(ий|а|ого) (учасник|член)|приєдна/i.test(text))) {
        evt('youtube', 'sub', name, 'новий учасник каналу');
        return;
      }
      chat('youtube', name, text);
    });
    try {
      const ok = await me.start();
      if (ok === false && lc === me) wait('стрім знайдено, але чат не відкрився (чат вимкнено або обмежений)', true);
    } catch (e) {
      if (lc === me) wait('не вдалося відкрити чат: ' + String((e && e.message) || e).slice(0, 80), true);
    }
  };
  attempt();
  return { stop() { stopped = true; clearTimeout(timer); stopHelpers(); try { lc && lc.stop(); } catch {} lc = null; } };
}

/* ---------------- TikTok (tiktok-live-connector; чекає початку стріму) ---------------- */
let ttLib = null;
async function loadTikTok() {
  if (!ttLib) { const m = await import('tiktok-live-connector'); ttLib = (m && m.TikTokLiveConnection) ? m : ((m && m.default) || m); }
  return ttLib;
}
function tiktokFriendly(e) {
  const m = String((e && e.message) || e).replace(/\s+/g, ' ');
  const name = String((e && e.name) || '');
  if (/UserOffline/i.test(name) || /offline|not (currently )?live|isn'?t live/i.test(m)) return { wait: true, text: 'очікування початку стріму' };
  if (/sign/i.test(name + ' ' + m)) {
    return { wait: false, text: 'сервер підписів TikTok недоступний або перевищено ліміт запитів (' + m.slice(0, 90) + '). Додай безкоштовний ключ Euler Stream у блоці «Ключі для кнопок Увійти»' };
  }
  return { wait: false, text: m.slice(0, 160) };
}
function startTikTok(a) {
  let stopped = false, conn = null, timer = null, pollTimer = null, warnedNoText = false, lastViewerEvent = 0;
  const later = ms => { clearTimeout(timer); timer = setTimeout(attempt, ms); };
  const goWaiting = text => { status('tiktok', 'waiting', text); setLive('tiktok', false); later(60000); };
  const dropConn = () => { clearInterval(pollTimer); const old = conn; conn = null; try { if (old && old.disconnect) Promise.resolve(old.disconnect()).catch(() => {}); } catch {} };
  const attempt = async () => {
    if (stopped) return;
    status('tiktok', 'connecting', '');
    let lib;
    try { lib = await loadTikTok(); }
    catch (e) { status('tiktok', 'error', 'не вдалося завантажити модуль TikTok: ' + String((e && e.message) || e).slice(0, 120)); return later(120000); }
    if (stopped) return;
    const { TikTokLiveConnection } = lib;
    const WebcastEvent = lib.WebcastEvent || {}, ControlEvent = lib.ControlEvent || {};
    const me = new TikTokLiveConnection(a.username, eulerKey() ? { signApiKey: eulerKey() } : {});
    // спершу легка перевірка ефіру (без підписування), щоб не навантажувати сервер підписів, поки стріму немає
    try {
      if (typeof me.fetchIsLive === 'function' && !(await me.fetchIsLive())) { if (!stopped) goWaiting('очікування початку стріму'); return; }
    } catch (e) { console.error('tiktok live check:', String((e && e.message) || e).slice(0, 120)); }
    if (stopped) return;
    conn = me;
    const alive = () => conn === me && !stopped;
    const nm = u => (u && (u.nickname || u.uniqueId)) || '???';
    const E = (k, d) => WebcastEvent[k] || d;
    // текст повідомлення: основне поле comment, а якщо формат зміниться, шукаємо схожі поля
    const textOf = d => {
      if (!d) return '';
      for (const k of ['comment', 'content', 'text', 'message']) if (typeof d[k] === 'string' && d[k].trim()) return d[k];
      for (const k of Object.keys(d)) if (/comment|content|text/i.test(k) && typeof d[k] === 'string' && d[k].trim()) return d[k];
      const em = d.emotesList || d.emoteList || d.emotes;
      return Array.isArray(em) && em.length ? '[стікер]' : '';
    };
    me.on(E('CHAT', 'chat'), d => {
      if (!alive()) return;
      if (process.env.DEBUG_EVENTS) console.log('tiktok chat:', JSON.stringify(d).slice(0, 400));
      const text = textOf(d);
      if (!text) {   // не показуємо рядок «нік без тексту»
        if (!warnedNoText) {
          warnedNoText = true;
          console.error('tiktok chat without text, fields:', Object.keys(d || {}).join(','));
          notice('tiktok', 'Отримано повідомлення без тексту (формат TikTok міг змінитися). Деталі в консолі: запусти з DEBUG_EVENTS=1.');
        }
        return;
      }
      chat('tiktok', nm(d.user), text);
    });
    // лічильник глядачів: подія roomUser, запасні джерела: member, інформація про кімнату
    const pickViewers = (d, keys) => {
      for (const k of keys) { const n = Number(d && d[k]); if (d && d[k] != null && Number.isFinite(n) && n >= 0) return n; }
      return null;
    };
    me.on(E('MEMBER', 'member'), d => { if (alive()) { const n = pickViewers(d, ['memberCount']); if (n != null) { lastViewerEvent = Date.now(); setViewers('tiktok', n); } } });
    me.on(E('GIFT', 'gift'), d => {
      if (!alive()) return;
      const det = d.giftDetails || {};
      if (det.giftType === 1 && !d.repeatEnd) return;   // серія ще триває: рахуємо після завершення
      const n = d.repeatCount || 1;
      evt('tiktok', 'gift', nm(d.user), 'подарунок: ' + (det.giftName || ('#' + d.giftId)) + (n > 1 ? ' ×' + n : ''));
    });
    me.on(E('FOLLOW', 'follow'), d => { if (alive()) evt('tiktok', 'follow', nm(d.user), 'новий фоловер'); });
    me.on(E('SHARE', 'share'), d => { if (alive()) evt('tiktok', 'share', nm(d.user), 'поділився стрімом'); });
    me.on(E('SUB_NOTIFY', 'subNotify'), d => { if (alive()) evt('tiktok', 'sub', nm(d && d.user), 'нова підписка'); });
    me.on(E('ROOM_USER', 'roomUser'), d => { if (alive()) { const n = pickViewers(d, ['viewerCount', 'memberCount', 'userCount']); if (n != null) { lastViewerEvent = Date.now(); setViewers('tiktok', n); } } });
    me.on(E('STREAM_END', 'streamEnd'), () => { if (alive()) { dropConn(); goWaiting('стрім завершено, очікую наступний'); } });
    me.on(ControlEvent.DISCONNECTED || 'disconnected', () => { if (alive()) { dropConn(); goWaiting('відключено, перепідключаюсь'); } });
    me.on(ControlEvent.ERROR || 'error', e => console.error('tiktok:', String((e && (e.info || e.message)) || e).slice(0, 160)));
    try {
      const state = await me.connect();
      if (!alive()) return;
      status('tiktok', 'ok', 'room ' + ((state && state.roomId) || ''));
      setLive('tiktok', true);
      const n0 = state && state.roomInfo ? Number(state.roomInfo.user_count) : NaN;
      if (Number.isFinite(n0)) { lastViewerEvent = Date.now(); setViewers('tiktok', n0); }
      // запасне оновлення лічильника раз на 30 с (якщо подія roomUser не приходить)
      if (typeof me.fetchRoomInfo === 'function') {
        pollTimer = setInterval(async () => {
          if (conn !== me || stopped) return;
          if (Date.now() - lastViewerEvent < (Number(process.env.TIKTOK_STALE_MS) || 45000)) return;   // події свіжі: опитування не потрібне
          try {
            const ri = await me.fetchRoomInfo();
            const n = Number(ri && (ri.user_count != null ? ri.user_count : ri.stats && ri.stats.user_count));
            if (Number.isFinite(n) && conn === me) setViewers('tiktok', n);
          } catch {}
        }, Number(process.env.TIKTOK_POLL_MS) || 30000);
      }
    } catch (e) {
      if (conn !== me || stopped) return;
      dropConn();
      const f = tiktokFriendly(e);
      console.error('tiktok connect:', String((e && e.message) || e).slice(0, 200));
      if (f.wait) goWaiting(f.text);
      else { status('tiktok', 'error', f.text); setLive('tiktok', false); later(90000); }
    }
  };
  attempt();
  return { stop() { stopped = true; clearTimeout(timer); clearInterval(pollTimer); dropConn(); } };
}

/* ---------------- Kick (Pusher; chatroom ID шукається один раз і запам'ятовується) ---------------- */
async function kickChannelJson(slug) {
  const url = 'https://kick.com/api/v2/channels/' + encodeURIComponent(slug);
  if (IS_ELECTRON) {   // запит через мережевий стек Chromium (справжній браузер): Cloudflare його пропускає
    try {
      const ses = require('electron').session.fromPartition('persist:kick');
      const r0 = await ses.fetch(url, { headers: { Accept: 'application/json' } });
      if (r0.ok) return await r0.json();
    } catch {}
  }
  let j;
  try {
    const r = await tfetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
  } catch (e) {
    // Cloudflare часто блокує fetch за TLS-відбитком - пробуємо системний curl
    j = await new Promise((res, rej) => {
      execFile('curl', ['-s', '-A', UA, '-H', 'Accept: application/json', url], { timeout: 15000, windowsHide: true }, (err, out) => {
        if (err) return rej(new Error('curl недоступний'));
        try { res(JSON.parse(out)); } catch { rej(new Error('Cloudflare блокує запит')); }
      });
    });
  }
  return j;
}
async function resolveKickIds(slug) {
  const j = await kickChannelJson(slug);
  if (!j || !j.chatroom || !j.chatroom.id) throw new Error('у відповіді немає chatroom.id');
  return { chatroomId: String(j.chatroom.id), channelId: j.id ? String(j.id) : '', live: ('livestream' in j) ? !!j.livestream : null };
}

function kickEventName(ev) {   // 'App\Events\ChatMessageEvent' -> 'ChatMessageEvent'
  return String(ev || '').replace(/^.*\\/, '');
}
const KICK_CHAT_RE = /chat.?message|message.?sent/i, KICK_CHAT_SKIP_RE = /delet|pin|clear|reply.?to/i;
function handleKickEvent(ev, raw) {
  let name = kickEventName(ev);
  let d = raw;
  if (typeof raw === 'string') { try { d = JSON.parse(raw); } catch { kickLog('не вдалося розібрати дані події ' + name); return; } }
  d = d || {};
  if (KICK_CHAT_RE.test(name) && !KICK_CHAT_SKIP_RE.test(name)) name = 'ChatMessageEvent';   // приймаємо й інші назви події повідомлення
  switch (name) {
    case 'ChatMessageEvent': {
      kickStats.chats++;
      const rawText = d.content != null ? d.content : (d.message != null ? d.message : (d.text != null ? d.text : d.body));
      const text = String(rawText && typeof rawText === 'object' ? (rawText.text || rawText.content || '') : (rawText || '')).replace(/\[emote:\d+:([^\]]*)\]/g, '$1').trim();   // смайл показуємо його назвою, щоб повідомлення не лишалось порожнім
      const sender = d.sender || d.user || {};
      const who = sender.username || sender.slug || sender.name || d.username || d.user_name;
      if (!text) kickLog('порожній текст повідомлення, сирі дані: ' + JSON.stringify(d).slice(0, 300));
      chat('kick', who, text);
      break;
    }
    case 'SubscriptionEvent':
      evt('kick', 'sub', d.username, 'нова підписка' + (d.months > 1 ? ` (${d.months} міс.)` : '')); break;
    case 'GiftedSubscriptionsEvent':
      evt('kick', 'sub', d.gifter_username, 'подаровано підписок: ' + ((d.gifted_usernames || []).length || '?')); break;
    case 'StreamHostEvent':
      evt('kick', 'raid', d.host_username, 'хост/рейд, глядачів: ' + (d.number_viewers != null ? d.number_viewers : '?')); break;
    case 'RewardRedeemedEvent':
      evt('kick', 'points', d.username, 'нагорода «' + (d.reward_title || '?') + '»' + (d.user_input ? ' - «' + d.user_input + '»' : '')); break;
    case 'FollowersUpdated':
      if (d.followed && d.username) evt('kick', 'follow', d.username, 'новий фоловер'); break;
    case 'StreamerIsLive': setLive('kick', true); break;
    case 'StopStreamBroadcast': setLive('kick', false); break;
    case 'KicksGifted': {
      const who = (d.sender && d.sender.username) || d.username;
      const g = d.gift || {};
      evt('kick', 'gift', who, 'подарунок: ' + (g.name || 'Kicks') + (g.amount ? ` (${g.amount})` : '')); break;
    }
    default:
      kickStats.other[name] = (kickStats.other[name] || 0) + 1;
      if ((kickDiagOn() && kickStats.other[name] === 1) || process.env.DEBUG_EVENTS) console.log('kick event:', name, String(typeof raw === 'string' ? raw : (JSON.stringify(raw) || '')).slice(0, 300));
  }
}
const kickStats = { frames: 0, chats: 0, bad: 0, other: {}, channels: {}, events: {}, subscribed: [] };
const kickDebug = [];   // останні службові записи про роботу Kick (дивись /api/kick-debug)
function kickLog(msg) {
  if (!kickDiagOn()) return;   // діагностику вимкнено: нічого не записуємо й не друкуємо (у записах бувають зразки повідомлень чату)
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  kickDebug.push(line); if (kickDebug.length > 120) kickDebug.shift();
  console.log('kick:', msg);
}   // лічильники для діагностики: що реально приходить від Kick

const KICK_WS_URL = process.env.KICK_PUSHER_URL || 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
const KICK_T = {   // часові параметри (у мілісекундах); змінні середовища потрібні лише для тестів
  ping: Number(process.env.KICK_PING_MS) || 25000,         // як часто перевіряємо, що з'єднання живе
  pong: Number(process.env.KICK_PONG_MS) || 20000,         // скільки чекаємо відповіді, перш ніж вважати з'єднання мертвим
  backoff0: Number(process.env.KICK_BACKOFF_MS) || 3000,   // перша пауза перед повторною спробою
  backoffMax: Number(process.env.KICK_BACKOFF_MAX_MS) || 60000,
  stable: Number(process.env.KICK_STABLE_MS) || 60000,     // з'єднання, що прожило стільки, вважається стабільним
  fatalRetry: Number(process.env.KICK_FATAL_RETRY_MS) || 600000,   // пауза після помилки Pusher 40xx (її повтор без змін не допоможе)
  handshake: Number(process.env.KICK_HANDSHAKE_MS) || 15000,
  subscribe: Number(process.env.KICK_SUBSCRIBE_MS) || 10000   // скільки чекаємо підтвердження підписки на чат
};
function startKickLegacy(a) {
  let stopped = false, ws = null, timer = null, statsTimer = null, pingTimer = null, pongTimer = null, hsTimer = null, subTimer = null;
  let backoff = KICK_T.backoff0, fails = 0, lastErr = '', fatal = false;
  const pollStats = async () => {
    if (stopped || !a.slug) return;
    try {
      const j = await kickChannelJson(a.slug);
      const ls = j && j.livestream;
      setLive('kick', !!ls);
      if (ls) setViewers('kick', Number(ls.viewer_count) || 0);
    } catch {}
    if (!stopped) statsTimer = setTimeout(pollStats, 45000);
  };
  const clearLive = () => { clearInterval(pingTimer); clearTimeout(pongTimer); clearTimeout(hsTimer); clearTimeout(subTimer); };
  const open = (chatroomId, channelId) => {
    if (stopped) return;
    const sock = new WebSocket(KICK_WS_URL);
    ws = sock;
    let openedAt = 0, established = false;
    const current = () => ws === sock && !stopped;
    // якщо сервер не відповів на рукостискання, не висимо вічно
    hsTimer = setTimeout(() => { if (!established) { try { sock.terminate(); } catch {} } }, KICK_T.handshake);
    sock.on('message', raw => {
      if (!current()) return;
      clearTimeout(pongTimer);   // будь-яке повідомлення від сервера означає, що з'єднання живе
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const ev = String(m.event || '');
      if (ev === 'pusher:connection_established') {
        established = true; openedAt = Date.now(); clearTimeout(hsTimer);
        sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }));
        if (channelId) sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `channel.${channelId}` } }));
        // з'єднання є, але підписка на чат не підтвердилася: перезапускаємо, щоб не «висіти» без повідомлень
        clearTimeout(subTimer);
        subTimer = setTimeout(() => { try { sock.terminate(); } catch {} }, KICK_T.subscribe);
        // keep-alive: у тихому чаті без трафіку з'єднання тихо "помирає" (роутер, провайдер), тому самі перевіряємо його
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (!current() || sock.readyState !== 1) return;
          try { sock.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch {}
          clearTimeout(pongTimer);
          pongTimer = setTimeout(() => { try { sock.terminate(); } catch {} }, KICK_T.pong);
        }, KICK_T.ping);
      } else if (ev === 'pusher_internal:subscription_succeeded') {
        clearTimeout(subTimer);
        lastErr = '';
        status('kick', 'ok', 'chatroom ' + chatroomId);
      } else if (ev === 'pusher:ping') {
        try { sock.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch {}
      } else if (ev === 'pusher:error') {
        let d = m.data;
        try { if (typeof d === 'string') d = JSON.parse(d); } catch {}
        const code = d && Number(d.code);
        lastErr = 'Pusher: ' + ((d && d.message) || 'помилка') + (code ? ' (код ' + code + ')' : '');
        if (code >= 4000 && code < 4100) fatal = true;   // за протоколом Pusher так закриті з'єднання не відновлюють без змін
        console.error('kick:', lastErr);
      } else if (!ev.startsWith('pusher')) {
        try { handleKickEvent(ev, m.data); } catch {}
      }
    });
    sock.on('close', code => {
      if (ws === sock) clearLive();
      if (!current()) return;
      if (fatal) {   // не крутимо нескінченний цикл спроб: чекаємо довго й пояснюємо причину
        fatal = false;
        const wait = KICK_T.fatalRetry >= 60000 ? Math.round(KICK_T.fatalRetry / 60000) + ' хв' : Math.max(1, Math.round(KICK_T.fatalRetry / 1000)) + ' с';
        status('kick', 'error', `Kick закрив старий публічний канал чату (${lastErr}). Чат Kick працює лише в програмі MultiChat.exe (вбудований браузер). Наступна перевірка через ${wait}`);
        timer = setTimeout(() => open(chatroomId, channelId), KICK_T.fatalRetry);
        return;
      }
      const lived = openedAt ? Date.now() - openedAt : 0;
      if (lived >= KICK_T.stable) { backoff = KICK_T.backoff0; fails = 0; } else fails++;
      const delay = backoff;
      backoff = Math.min(backoff * 2, KICK_T.backoffMax);   // пауза між спробами росте, тож безкінечного швидкого циклу немає
      const why = lastErr || (code ? 'код ' + code : '');
      const secs = Math.max(1, Math.round(delay / 1000));
      if (fails >= 3) status('kick', 'error', `З'єднання з чатом Kick постійно розривається (${why || 'без причини'}). Наступна спроба через ${secs} с`);
      else status('kick', 'connecting', `перепідключення через ${secs} с${why ? ' (' + why + ')' : ''}`);
      timer = setTimeout(() => open(chatroomId, channelId), delay);
    });
    sock.on('error', () => {});
  };
  (async () => {
    let cr = a.chatroomId, ch = a.channelId;
    if ((!cr || !ch) && a.slug) {
      try {
        const ids = await resolveKickIds(a.slug);
        if (ids.live !== null) setLive('kick', ids.live);
        cr = cr || ids.chatroomId; ch = ch || ids.channelId;
        a.chatroomId = cr; a.channelId = ch; saveAccounts();
      } catch (e) {
        if (!cr) { status('kick', 'error', 'Не вдалось автоматично отримати ID чату Kick (' + e.message + '). Встав його вручну.'); return; }
      }
    }
    if (!cr) { status('kick', 'error', 'Невідомий chatroom ID Kick. Встав його вручну.'); return; }
    if (!ch) notice('kick', 'Без channel ID не видно фоли Kick (чат працює). Він підтягнеться автоматично, коли вдасться зв\'язатися з Kick API.');
    if (!stopped) { open(cr, ch); pollStats(); }
  })();
  return { stop() { stopped = true; clearTimeout(timer); clearTimeout(statsTimer); clearLive(); try { ws && ws.close(); } catch {} } };
}

/* ---------------- Kick: чат через вбудований браузер (Electron) ----------------
   Kick покинув хмарний Pusher: старий публічний ключ відповідає «App key not in this cluster» (код 4001) на кожному кластері,
   а новий шлюз websockets.kick.com потребує одноразового токена, який віддається лише справжньому браузеру (Cloudflare).
   Тому відкриваємо сторінку чату Kick у прихованому вікні Chromium і читаємо кадри її WebSocket через протокол DevTools:
   сторінка сама отримує токен, підключається й підписується, а ми лише беремо ті самі події (App\Events\...). */
const KICK_B = {   // змінні середовища потрібні лише для тестів
  watchdog: Number(process.env.KICK_WATCHDOG_MS) || 60000,   // скільки чекаємо першу підписку, перш ніж підказати про перевірку Cloudflare
  retry0: Number(process.env.KICK_BACKOFF_MS) || 3000,
  retryMax: Number(process.env.KICK_BACKOFF_MAX_MS) || 60000,
  silence: Number(process.env.KICK_SILENCE_MS) || 300000     // скільки без жодного кадру від сервера вважаємо обривом
};
let kickWinRef = null;
function chromeUA() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + (process.versions.chrome || '130.0.0.0') + ' Safari/537.36';
}
// спільна обробка однієї події Kick (з Centrifugo або зі старого Pusher): name - назва події, data - її дані, channel - канал
function processKickEvent(name, data, channel, onReady, sample) {
  const short = kickEventName(name);
  if (channel) kickStats.channels[channel] = (kickStats.channels[channel] || 0) + 1;
  if (!kickStats.events[short]) { kickStats.events[short] = 0; kickLog('перша подія «' + short + '»' + (channel ? ' на каналі ' + channel : '') + ': ' + String(sample || '').slice(0, 160)); }
  kickStats.events[short]++;
  if (KICK_CHAT_RE.test(short) && !KICK_CHAT_SKIP_RE.test(short)) onReady();   // повідомлення чату означає, що все працює
  try { handleKickEvent(name, data); } catch (e) { kickLog('помилка обробки події ' + short + ': ' + (e && e.message)); }
}
// один JSON-об'єкт із кадру WebSocket
function handleKickMessage(line, onReady) {
  let m; try { m = JSON.parse(line); } catch { if (++kickStats.bad <= 5) kickLog('не JSON: ' + line.slice(0, 80)); return; }
  if (!m || typeof m !== 'object') return;
  if (!Object.keys(m).length) return;   // порожній об'єкт {} - службовий пінг Centrifugo
  kickStats.frames++;
  // --- новий протокол Kick (Centrifugo): {"push":{"channel":"chatrooms.ID.v2","pub":{"data":{"event":"...","data":"..."}}}} ---
  if (m.push) {
    const ch = String(m.push.channel || '');
    const pub = m.push.pub;
    if (!pub) return;   // join/leave/unsubscribe та інше службове
    let inner = pub.data;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch {} }
    if (inner && typeof inner === 'object' && inner.event) { processKickEvent(inner.event, inner.data, ch, onReady, line); return; }
    if (!kickStats.events['(push без event)']) { kickStats.events['(push без event)'] = 0; kickLog('push без поля event: ' + line.slice(0, 200)); }
    kickStats.events['(push без event)']++;
    return;
  }
  if (m.connect) { kickLog('Centrifugo: з\'єднання встановлено'); return; }
  if (m.error) { kickLog('Centrifugo помилка (id ' + m.id + '): ' + JSON.stringify(m.error).slice(0, 200)); return; }
  if ('subscribe' in m) {   // відповідь на підписку (без назви каналу): помилок немає - підписку прийнято
    kickStats.subscribed.push('підписка #' + m.id);
    if (kickStats.subscribed.length <= 6) kickLog('підписку прийнято (id ' + m.id + ')');
    onReady();
    return;
  }
  if ('id' in m && !m.event) return;   // інші відповіді Centrifugo (ping, rpc тощо)
  // --- старий протокол Pusher ---
  const ev = String(m.event || '');
  if (ev === 'pusher_internal:subscription_succeeded') {
    kickLog('підписка підтверджена: ' + (m.channel || '(без назви каналу)'));
    kickStats.subscribed.push(String(m.channel || ''));
    if (/chat/i.test(String(m.channel || ''))) onReady();
    return;
  }
  if (!ev || ev.startsWith('pusher')) return;
  processKickEvent(ev, m.data, m.channel, onReady, line);
}
function handleKickFrame(payload, onReady, meta = {}) {
  let text = String(payload == null ? '' : payload);
  if (meta.opcode === 2) { try { text = Buffer.from(text, 'base64').toString('utf8'); } catch {} }   // бінарний кадр приходить у base64
  // Centrifugo може склеювати кілька JSON-об'єктів в один кадр через новий рядок
  for (const line of text.split('\n')) { const l = line.trim(); if (l) handleKickMessage(l, onReady); }
}
function startKickBrowser(a) {
  const { BrowserWindow } = require('electron');
  const slug = a.slug;
  if (!slug) { status('kick', 'error', 'Не вказано нік каналу Kick.'); return { stop() {} }; }
  let stopped = false, win = null, timer = null, watch = null, silenceTimer = null, statsTimer = null;
  let backoff = KICK_B.retry0, ready = false, reloads = 0, lastFrame = 0;
  const wsUrls = new Map();
  let wsSeen = 0;
  const closeWin = () => {
    clearTimeout(watch); clearInterval(silenceTimer);
    const w = win; win = null;
    if (kickWinRef === w) kickWinRef = null;
    if (w && !(w.isDestroyed && w.isDestroyed())) {
      try { w.webContents.debugger.detach(); } catch {}
      try { w.destroy(); } catch {}
    }
  };
  const retry = why => {
    if (stopped || global.__multichatQuitting) return;   // під час виходу з програми нових спроб не робимо
    closeWin(); ready = false;
    const delay = backoff;
    backoff = Math.min(backoff * 2, KICK_B.retryMax);   // паузи ростуть, нескінченного швидкого циклу немає
    status('kick', 'connecting', `${why}. Повторна спроба через ${Math.max(1, Math.round(delay / 1000))} с`);
    timer = setTimeout(create, delay);
  };
  const pollStats = async () => {
    if (stopped) return;
    try {
      const j = await kickChannelJson(slug);
      const ls = j && j.livestream;
      setLive('kick', !!ls);
      if (ls) setViewers('kick', Number(ls.viewer_count) || 0);
    } catch {}
    if (!stopped) statsTimer = setTimeout(pollStats, 45000);
  };
  const create = () => {
    if (stopped || global.__multichatQuitting) return;   // під час виходу вікно не відкриваємо
    status('kick', 'connecting', 'відкриваю чат Kick у вбудованому браузері');
    ready = false; lastFrame = Date.now(); wsUrls.clear(); wsSeen = 0;
    const w = new BrowserWindow({ show: false, width: 460, height: 700, title: 'Kick',
      webPreferences: { partition: 'persist:kick', backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win = w; kickWinRef = w;
    const wc = w.webContents;
    wc.setUserAgent(chromeUA());   // без слова Electron у User-Agent
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      wc.debugger.attach('1.3');
      Promise.resolve(wc.debugger.sendCommand('Network.enable')).catch(() => {});
      // якщо сторінка тримає WebSocket у воркері, звичайний Network його не бачить: підключаємось і до воркерів
      Promise.resolve(wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })).catch(() => {});
    } catch (e) { return retry('не вдалося підключити відлагоджувач (' + (e && e.message) + ')'); }
    wc.debugger.on('message', (_e, method, p, sessionId) => {
      if (win !== w || !p) return;
      if (method === 'Target.attachedToTarget') {   // воркер сторінки: вмикаємо в ньому Network
        const sid = p.sessionId;
        if (sid) Promise.resolve(wc.debugger.sendCommand('Network.enable', {}, sid)).catch(() => {});
        return;
      }
      const rid = (sessionId || '') + '|' + p.requestId;
      if (method === 'Network.webSocketCreated') {
        const u = String(p.url || ''); wsUrls.set(rid, u); wsSeen++;
        kickLog('WebSocket відкрито: ' + u.replace(/\?.*$/, ''));
        if (!ready && /kick\.com|pusher/i.test(u)) status('kick', 'connecting', 'з\'єднання з Kick відкрито, чекаю підписку на чат');
      } else if (method === 'Network.webSocketFrameReceived') {
        if (!/kick\.com|pusher/i.test(wsUrls.get(rid) || '')) return;   // лише WebSocket Kick
        lastFrame = Date.now();
        handleKickFrame(p.response && p.response.payloadData, () => {
          if (ready) return;
          ready = true; backoff = KICK_B.retry0; reloads = 0;
          kickLog('чат Kick працює');
          status('kick', 'ok', 'чат Kick (вбудований браузер)');
          try { if (w.isVisible && w.isVisible()) w.hide(); } catch {}   // перевірку Cloudflare пройдено: ховаємо вікно
        }, { opcode: p.response && p.response.opcode });
      } else if (method === 'Network.webSocketClosed') { kickLog('WebSocket закрито: ' + String(wsUrls.get(rid) || '').replace(/\?.*$/, '')); wsUrls.delete(rid); }
      else if (method === 'Network.webSocketFrameError') kickLog('помилка WebSocket: ' + String(p.errorMessage || ''));
    });
    wc.on('did-fail-load', (_e, code, desc, _url, isMain) => { if (isMain && win === w && code !== -3) retry(`сторінку чату Kick не завантажено (${desc || code})`); });
    wc.on('render-process-gone', () => { if (win === w) retry('вбудований браузер Kick аварійно завершився'); });
    w.on('closed', () => { if (win === w) { win = null; if (kickWinRef === w) kickWinRef = null; if (!stopped) retry('вікно Kick закрито'); } });
    Promise.resolve(w.loadURL(`https://kick.com/popout/${encodeURIComponent(slug)}/chat`)).catch(() => {});
    // сторож: підписки немає (наприклад, Cloudflare просить перевірку): підказуємо і перезавантажуємо сторінку
    clearTimeout(watch);
    watch = setTimeout(function check() {
      if (stopped || win !== w || ready) return;
      reloads++;
      const why = wsSeen === 0
        ? 'Kick не відповідає (можливо, Cloudflare просить перевірку). Натисни «Показати вікно Kick» і пройди перевірку'
        : 'Kick відкрив з\'єднання, але підписка на чат не підтвердилась (кадрів: ' + kickStats.frames + '). Натисни «Показати вікно Kick» і перевір, чи там видно чат';
      kickLog('сторож: ' + why);
      status('kick', 'error', why + (reloads > 1 ? ` (спроб: ${reloads})` : ''));
      try { w.webContents.reload(); } catch {}
      watch = setTimeout(check, KICK_B.watchdog);
    }, KICK_B.watchdog);
    // після підключення: якщо сервер довго не надсилає жодного кадру, вважаємо з'єднання мертвим і відкриваємо чат заново
    clearInterval(silenceTimer);
    silenceTimer = setInterval(() => {
      if (stopped || win !== w || !ready) return;
      status('kick', 'ok', `чат Kick (вбудований браузер): кадрів ${kickStats.frames}, повідомлень ${kickStats.chats}`);
      if (Date.now() - lastFrame > KICK_B.silence) retry('чат Kick довго мовчить, перепідключаюсь');
    }, Math.max(500, Math.min(30000, Math.round(KICK_B.silence / 4))));
  };
  create();
  pollStats();
  return { stop() { stopped = true; clearTimeout(timer); clearTimeout(statsTimer); closeWin(); } };
}
function startKick(a) { return IS_ELECTRON ? startKickBrowser(a) : startKickLegacy(a); }
app.get('/api/kick-debug', (req, res) => {   // діагностика: що саме приходить від Kick
  if (!kickDiagOn()) return res.status(403).type('text/plain; charset=utf-8').send('Діагностика Kick вимкнена. Увімкни її в налаштуваннях програми: група «Для розробників», пункт «Діагностика Kick».');
  res.type('text/plain; charset=utf-8').send(
    'Kick - діагностика\n\n' + JSON.stringify(kickStats, null, 2) + '\n\nОстанні записи:\n' + kickDebug.join('\n') + '\n');
});
app.post('/api/kick-window', (req, res) => {   // показати вікно Kick, щоб вручну пройти перевірку Cloudflare
  const w = kickWinRef;
  if (!w || (w.isDestroyed && w.isDestroyed())) return res.status(400).json({ error: 'вікно Kick недоступне (потрібна програма MultiChat.exe)' });
  try { w.show(); if (w.focus) w.focus(); } catch {}
  res.json({ ok: true });
});

/* ---------------- запуск/зупинка платформ ---------------- */
const running = {};
const STARTERS = { twitch: startTwitch, youtube: startYouTube, tiktok: startTikTok, kick: startKick };
function stopPlatform(p) { if (running[p]) { try { running[p].stop(); } catch {} delete running[p]; } }
function startPlatform(p) {
  stopPlatform(p);
  setLive(p, null);
  delete notices[p];
  if (p === 'twitch') delete tokCache.twitch;
  if (p === 'youtube') delete tokCache.google;
  const a = accounts[p];
  if (!a) { status(p, 'off', ''); return; }
  status(p, 'connecting', '');
  try { running[p] = STARTERS[p](a); } catch (e) { status(p, 'error', String((e && e.message) || e)); }
}

process.on('unhandledRejection', e => console.error('unhandled:', e && e.message));
process.on('uncaughtException', e => console.error('uncaught:', e && e.message));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  require('child_process').exec(cmd, () => {});
}
server.on('error', e => {
  console.error(e && e.code === 'EADDRINUSE' ? `\n  Port ${PORT} is already in use - close the other MultiChat window.\n` : e);
  setTimeout(() => process.exit(1), 15000);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  MultiChat is running -> ${BASE}\n  (close this window to stop)\n`);
  PLATFORMS.forEach(startPlatform);   // автопідключення до збережених акаунтів
  if (curPriority() !== 'normal') { applyPriority(); setTimeout(applyPriority, 6000); }   // збережений пріоритет діє від запуску
  netCheck();                         // постійна перевірка інтернету у фоні
  if (!process.env.NO_OPEN) openBrowser(BASE);
});

