/* Новорічне оформлення MultiChat: сніг, замети на елементах, гірлянди й іграшки.
   Усе малюється на одному прозорому canvas поверх сторінки (кліки проходять крізь нього).
   - Сніг лягає на верхні краї відкритих вікон (налаштування, розіграш, модальні вікна). Коли вікно закрито, сніг із нього зсипається вниз.
   - Внизу вікна накопичується замет.
   - «Прикраси» (гірлянда, ялинка) - окрема функція, працює без снігу.
   Керується через window.Festive.set({...}). */
(function () {
  'use strict';
  const D = { snow: false, snowCount: 120, snowSpeed: 100, snowSize: 100, snowWind: 0, snowOnWin: true, xmas: false, xmasGarland: true, xmasTree: false, xmasTreePos: 'right', xmasHat: true, ground: true, off: false };
  let O = { ...D };
  const BW = 5;                      // ширина «стовпчика» замету, px
  const GMAX = 16;                   // найбільша висота замету внизу, px
  const WMAX = 14;                   // найбільша висота снігу на вікні, px
  const LIGHTS = ['#ff4d4d', '#ffd23f', '#4dd96a', '#4da6ff', '#ff7ad9'];
  const WIN_SEL = ['#feedWrap.gw-on', '#helpModal.show .hbox', '#wwModal.show .wwbox', '#netModal.show .box', '#confirmModal.show .box'];

  let cv = null, cx = null, W = 0, H = 0, dpr = 1, raf = 0, last = 0, T = 0, frame = 0;
  let flakes = [], surfaces = new Map(), ground = new Float32Array(2);
  let light = false, lightAt = 0, spawnAcc = 0;

  let barRect = null;   // верхній край нижньої панелі (#viewers): на ньому лежить сніг і стоїть ялинка
  function findBar() {
    const bar = document.getElementById('viewers'); if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return (r.height > 4 && r.width > 40 && r.top > H * .3 && r.top < H) ? r : null;
  }
  const floorAt = x => (barRect && x >= barRect.left && x <= barRect.right) ? barRect.top + 1 : H + 1;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const active = () => !O.off && (O.snow || O.xmas);

  /* ---------- canvas ---------- */
  function ensureCanvas() {
    if (cv) return;
    cv = document.createElement('canvas'); cv.id = 'festiveCv'; cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483000';
    document.body.appendChild(cv); cx = cv.getContext('2d'); resize();
  }
  function dropCanvas() { if (cv) { cv.remove(); cv = null; cx = null; } }
  function resize() {
    if (!cv) return;
    W = innerWidth; H = innerHeight; dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
    const n = Math.ceil(W / BW) + 2;
    if (ground.length !== n) { const g = new Float32Array(n); g.set(ground.subarray(0, Math.min(n, ground.length))); ground = g; }
  }
  addEventListener('resize', resize);

  /* ---------- висоти замету ---------- */
  function addSnow(map, i, a, max) {
    if (i < 0 || i >= map.length) return;
    map[i] = Math.min(max, map[i] + a);
    for (let d = 1; d <= 2; d++) {
      const k = a * (d === 1 ? .55 : .25);
      if (i - d >= 0) map[i - d] = Math.min(max, map[i - d] + k);
      if (i + d < map.length) map[i + d] = Math.min(max, map[i + d] + k);
    }
  }
  function relax(map) {
    for (let i = 0; i < map.length - 1; i++) {
      const d = map[i] - map[i + 1];
      if (d > 2.2 || d < -2.2) { const m = d * .12; map[i] -= m; map[i + 1] += m; }
    }
  }
  const mapSum = m => { let s = 0; for (let i = 0; i < m.length; i++) s += m[i]; return s; };

  /* ---------- поверхні (вікна) ---------- */
  function visRect(el) {
    if (el.hidden) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 40 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) return null;
    if (parseFloat(getComputedStyle(el).opacity) < .15) return null;
    return r;
  }
  function releaseSurface(s) {   // вікно закрилось: сніг із нього сиплеться вниз
    const r = s.r, h = s.h;
    for (let i = 0; i < h.length; i++) {
      if (h[i] < .8) continue;
      const n = Math.ceil(h[i] / 2.2);
      for (let k = 0; k < n && flakes.length < 900; k++) {
        const sz = rnd(.9, 2.2) * O.snowSize / 100;
        flakes.push({ x: r.left + i * BW + rnd(0, BW), y: r.top - rnd(0, h[i]), r: sz, vy: rnd(10, 60), vx: rnd(-22, 22), amp: rnd(2, 8), sw: rnd(.8, 2.2), ph: rnd(0, 6.28), a: rnd(.7, .95), free: true });
      }
    }
  }
  function collectSurfaces(dt) {
    const seen = new Set();
    if (O.snow && O.snowOnWin) {
      for (const sel of WIN_SEL) for (const el of document.querySelectorAll(sel)) {
        const r = visRect(el); if (!r) continue;
        seen.add(el);
        let s = surfaces.get(el); const n = Math.ceil(r.width / BW) + 2;
        if (!s) { s = { el, r, h: new Float32Array(n), born: T }; surfaces.set(el, s); }
        else { s.r = r; if (n > s.h.length) { const nh = new Float32Array(n); nh.set(s.h); s.h = nh; } else if (n < s.h.length) s.h = s.h.slice(0, n); }   // вікно зменшили: сніг за його краєм не лишається в повітрі
      }
    } else if (!O.snow) {   // сніг вимкнено: замети на вікнах тануть
      for (const [el, s] of surfaces) {
        const r = el.isConnected ? visRect(el) : null;
        if (!r) { surfaces.delete(el); continue; }
        s.r = r; let mx = 0; for (let i = 0; i < s.h.length; i++) { s.h[i] = Math.max(0, s.h[i] - 5 * dt); if (s.h[i] > mx) mx = s.h[i]; }
        if (mx < .3) surfaces.delete(el);
      }
      return;
    }
    for (const [el, s] of surfaces) if (!seen.has(el)) { if (O.snow) releaseSurface(s); surfaces.delete(el); }
  }

  /* ---------- сніжинки ---------- */
  function spawn() {
    const sz = (.8 + Math.pow(Math.random(), 2) * 2.8) * O.snowSize / 100, speed = O.snowSpeed / 100, wind = O.snowWind * .6;
    const vy = (22 + sz * 16) * speed, drift = Math.abs(wind) * (H / Math.max(20, vy));
    const x = wind >= 0 ? rnd(-drift, W) : rnd(0, W + drift);
    flakes.push({ x, y: -sz - rnd(0, 30), r: sz, vy, vx: wind, amp: rnd(5, 16), sw: rnd(.8, 2.2), ph: rnd(0, 6.28), a: rnd(.6, .95), free: false });
  }
  function stepFlakes(dt) {
    const surf = [...surfaces.values()];
    for (const f of flakes) {
      f.py = f.y;
      f.x += (f.vx + Math.sin(T * f.sw + f.ph) * f.amp) * dt; f.y += f.vy * dt;
      if (f.x < -80 || f.x > W + 80 || f.y > H + 10) { f.dead = true; continue; }
      let hit = false;
      for (const s of surf) {
        const r = s.r;
        if (f.x < r.left || f.x > r.right) continue;
        const i = ((f.x - r.left) / BW) | 0, top = r.top - (s.h[i] || 0);
        if (f.py <= top && f.y > top && Math.random() < .3) { addSnow(s.h, i, f.r * .9, WMAX); f.dead = true; hit = true; break; }   // частина снігу лягає на верхній край вікна, решта падає по вікну
      }
      if (hit) continue;
      const gi = (f.x / BW) | 0, gt = floorAt(f.x) - (ground[gi] || 0);
      if (f.y >= gt) { if (O.snow && O.ground) addSnow(ground, gi, f.r * .35, GMAX); f.dead = true; }
    }
    flakes = flakes.filter(f => !f.dead);
  }
  function drawFlakes() {
    cx.fillStyle = '#fff';
    if (light) { cx.strokeStyle = 'rgba(95,120,165,.6)'; cx.lineWidth = .8; }
    for (const f of flakes) {
      cx.globalAlpha = f.a; cx.beginPath(); cx.arc(f.x, f.y, f.r, 0, 6.2832); cx.fill();
      if (light) cx.stroke();
    }
    cx.globalAlpha = 1;
  }

  /* ---------- замети ---------- */
  function drawPile(map, x0, base, scale, from, to) {
    // малює сніг по висотах map; base - лінія, на якій лежить сніг; ділянки без снігу пропускаються
    const n = Math.min(to == null ? map.length : to, map.length);
    let i = from || 0, maxH = 0;
    cx.fillStyle = '#f4f8ff';
    if (light) { cx.strokeStyle = 'rgba(95,120,165,.55)'; cx.lineWidth = 1; }
    while (i < n) {
      while (i < n && map[i] * scale < .35) i++;
      if (i >= n) break;
      let j = i; maxH = 0;
      while (j < n && map[j] * scale >= .35) { maxH = Math.max(maxH, map[j] * scale); j++; }
      const pts = []; for (let k = i; k < j; k++) pts.push([x0 + k * BW + BW / 2, base - map[k] * scale]);
      const xa = x0 + i * BW, xb = x0 + j * BW;
      const g = cx.createLinearGradient(0, base - maxH, 0, base + 2); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#cddbf0');
      cx.fillStyle = g;
      cx.beginPath(); cx.moveTo(xa, base + 1.5);
      cx.lineTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) { const mx = (pts[k - 1][0] + pts[k][0]) / 2, my = (pts[k - 1][1] + pts[k][1]) / 2; cx.quadraticCurveTo(pts[k - 1][0], pts[k - 1][1], mx, my); }
      cx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); cx.lineTo(xb, base + 1.5); cx.closePath(); cx.fill();
      if (light) cx.stroke();
      i = j;
    }
  }
  /* ---------- гірлянди, іграшки, ялинка ---------- */
  function garland(x0, x1, y) {   // тонка гірлянда з дрібними вогниками, що майже не заходить на вміст
    const len = x1 - x0; if (len < 80) return;
    const n = Math.max(1, Math.round(len / 240)), sw = len / n, sag = Math.min(8, sw * .04);
    cx.lineWidth = 1.2; cx.strokeStyle = light ? 'rgba(40,70,45,.8)' : 'rgba(35,70,40,.9)'; cx.lineCap = 'round';
    for (let k = 0; k < n; k++) {
      const ax = x0 + k * sw, bx = ax + sw;
      cx.beginPath(); cx.moveTo(ax, y); cx.quadraticCurveTo((ax + bx) / 2, y + sag * 2, bx, y); cx.stroke();
      const m = Math.max(4, Math.round(sw / 30));
      for (let j = 1; j < m; j++) {
        const u = j / m, px = ax + sw * u, py = y + 4 * sag * u * (1 - u) + 3;
        const col = LIGHTS[(k * 3 + j) % LIGHTS.length], tw = .55 + .45 * Math.sin(T * 3.2 + (k * 5 + j) * 1.9);
        cx.fillStyle = col; cx.globalAlpha = .2 * tw; cx.beginPath(); cx.arc(px, py, 7, 0, 6.2832); cx.fill();
        cx.globalAlpha = .65 + .35 * tw; cx.beginPath(); cx.arc(px, py, 3.1, 0, 6.2832); cx.fill();
      }
    }
    cx.globalAlpha = 1;
  }
  /* ---------- ялинка ---------- */
  let treeC = null;
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function bauble(g, x, y, r, col) {
    const gr = g.createRadialGradient(x - r * .35, y - r * .35, r * .1, x, y, r);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(.3, col); gr.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    g.fillStyle = '#d4af37'; g.fillRect(x - r * .3, y - r - 1.6, r * .6, 2);
  }
  function bigStar(g, x, y, r) {
    const gr = g.createRadialGradient(x, y, r * .1, x, y, r); gr.addColorStop(0, '#fff6b0'); gr.addColorStop(1, '#e8a800');
    g.fillStyle = gr; g.strokeStyle = '#b87800'; g.lineWidth = .8; g.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    g.closePath(); g.fill(); g.stroke();
  }
  function gift(g, x, y, s, col, rib) {   // подарунок зі стрічкою й бантом; (x, y) - лівий нижній кут
    const gr = g.createLinearGradient(x, 0, x + s, 0); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = col; g.fillRect(x, y - s, s, s); g.fillStyle = gr; g.fillRect(x, y - s, s, s);
    g.fillStyle = rib; g.fillRect(x + s * .43, y - s, s * .14, s); g.fillRect(x, y - s * .58, s, s * .14);
    g.strokeStyle = rib; g.lineWidth = Math.max(1, s * .07);
    g.beginPath(); g.ellipse(x + s * .36, y - s - s * .1, s * .17, s * .1, -.5, 0, 6.2832); g.ellipse(x + s * .64, y - s - s * .1, s * .17, s * .1, .5, 0, 6.2832); g.stroke();
  }
  function buildTree(h, d) {   // статичну частину ялинки малюємо один раз у окремий canvas
    const w = h * .68, CW = Math.ceil(w + h * .9), CH = Math.ceil(h + 8 + h * .12), lx = CW / 2, base = CH - 4;
    const c = document.createElement('canvas'); c.width = Math.round(CW * d); c.height = Math.round(CH * d);
    const g = c.getContext('2d'); g.scale(d, d);
    const R = rng(11), N = 7, trunkH = h * .09, fh = h - trunkH - h * .03, top = base - h, th = fh * 2.15 / N;
    const greens = ['#0c3a1c', '#14502a', '#1c6b36', '#2a8a4a', '#3aa05c'], lights = [];
    g.fillStyle = '#5a3a1e'; g.fillRect(lx - w * .05, base - trunkH - 3, w * .1, trunkH + 3);
    for (let k = N - 1; k >= 0; k--) {
      const ty = top + h * .03 + k * (fh - th) / (N - 1), by = ty + th, hw = w / 2 * (.3 + .7 * k / (N - 1)), m = Math.max(4, Math.round(hw / 5));
      const edge = []; for (let i = 0; i <= m; i++) edge.push([lx + hw - 2 * hw * (i / m), by + (i % 2 ? -th * (.08 + R() * .07) : th * (.02 + R() * .05))]);
      const path = () => {
        g.beginPath(); g.moveTo(lx, ty); g.quadraticCurveTo(lx + hw * .35, ty + th * .45, lx + hw * 1.05, by);
        for (const p of edge) g.lineTo(p[0], p[1]);
        g.lineTo(lx - hw * 1.05, by); g.quadraticCurveTo(lx - hw * .35, ty + th * .45, lx, ty); g.closePath();
      };
      g.save(); path(); g.clip();
      const gr = g.createLinearGradient(0, ty, 0, by); gr.addColorStop(0, '#2a8a4a'); gr.addColorStop(.55, '#1c6b36'); gr.addColorStop(1, '#0f3d1f');
      g.fillStyle = gr; g.fillRect(lx - hw * 1.2, ty - 2, hw * 2.4, th + 8);
      const cnt = Math.round(hw * th / 7);
      for (let i = 0; i < cnt; i++) {   // голки: короткі штрихи різних відтінків зеленого
        const py = ty + R() * th, px = lx + (R() * 2 - 1) * hw * (py - ty) / th * 1.05;
        const side = px < lx ? -1 : 1, a = Math.PI / 2 + side * (.35 + R() * .5) + (R() - .5) * .5, len = 3 + R() * 5;
        g.strokeStyle = greens[(R() * 5) | 0]; g.lineWidth = 1.1; g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); g.stroke();
      }
      const sh = g.createLinearGradient(0, by - th * .45, 0, by + 4); sh.addColorStop(0, 'rgba(0,15,0,0)'); sh.addColorStop(1, 'rgba(0,15,0,.6)');
      g.fillStyle = sh; g.fillRect(lx - hw * 1.2, by - th * .45, hw * 2.4, th * .45 + 6);
      g.restore();
      g.strokeStyle = 'rgba(0,20,0,.45)'; g.lineWidth = 1; path(); g.stroke();
      if (k > 0) {   // мішура-гірлянда складками через ярус
        const ex = hw * .58, ey = ty + th * .62;
        g.strokeStyle = 'rgba(255,205,110,.95)'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(lx - ex, ey); g.quadraticCurveTo(lx, ty + th * .98, lx + ex, ey); g.stroke();
        g.strokeStyle = 'rgba(255,245,200,.8)'; g.lineWidth = .8; g.beginPath(); g.moveTo(lx - ex, ey - 1); g.quadraticCurveTo(lx, ty + th * .98 - 1, lx + ex, ey - 1); g.stroke();
      }
      g.fillStyle = 'rgba(255,255,255,.88)';   // сніг на схилах і кінчиках гілок
      for (const s of [-1, 1]) for (let j = 0; j < 5; j++) { const t = .22 + R() * .72; g.beginPath(); g.ellipse(lx + s * hw * t * .96, ty + th * t * .9, 2 + R() * 3, 1.1 + R() * 1.5, s * .55, 0, 6.2832); g.fill(); }
      for (let i = 1; i < edge.length - 1; i += 2) if (R() < .5) { g.beginPath(); g.ellipse(edge[i][0], edge[i][1] - 1, 2 + R() * 2, 1.2, 0, 0, 6.2832); g.fill(); }
      for (let i = 0; i < 4; i++) lights.push({ x: lx + (R() * 2 - 1) * hw * .8, y: by - th * (.1 + R() * .2), col: LIGHTS[(k + i) % LIGHTS.length], ph: R() * 6.28 });
      if (k > 0) for (let i = 0; i < 2; i++) bauble(g, lx + (R() * 2 - 1) * hw * .7, by - th * (.22 + R() * .22), clamp(h * .03, 3, 6.5), LIGHTS[(k * 2 + i * 3) % LIGHTS.length]);
    }
    g.fillStyle = '#a82a30'; g.beginPath(); g.ellipse(lx, base - 1, w * .62, h * .035, 0, 0, 6.2832); g.fill();   // килимок під ялинкою
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 2; g.stroke();
    const gs = h * .15;
    gift(g, lx - w * .66, base, gs, '#d94a4a', '#ffe08a'); gift(g, lx + w * .36, base, gs * .78, '#3f7fd9', '#ffffff'); gift(g, lx - w * .36, base, gs * .6, '#8a4fd1', '#ffd34d'); gift(g, lx + w * .6, base, gs * .55, '#2fa86b', '#ffe08a');
    bigStar(g, lx, top + 2, h * .075);
    return { c, CW, CH, lx, base, lights, star: { x: lx, y: top + 2, r: h * .075 } };
  }
  function drawTree() {
    if (W < 280 || H < 260) return;
    // ялинка стоїть на верхньому краї нижньої панелі (лічильники, CPU/GPU), а не поверх неї
    const floor = barRect ? barRect.top + 1 : H - 3;
    const h = clamp(Math.min(H * .3, floor - 8), 60, 200), key = Math.round(h) + '|' + dpr;
    if (!treeC || treeC.key !== key) { treeC = buildTree(h, dpr); treeC.key = key; }
    const pad = 4, fl = barRect ? barRect.left : 0, fr = barRect ? barRect.right : W, mx = O.xmasTreePos === 'left' ? fl + pad + treeC.CW / 2 : fr - pad - treeC.CW / 2,   // ліворуч - у полі чату, а не над лівою панеллю
       ox = mx - treeC.lx, oy = floor - treeC.base;
    cx.drawImage(treeC.c, ox, oy, treeC.CW, treeC.CH);
    for (const l of treeC.lights) {
      const tw = .5 + .5 * Math.sin(T * 3 + l.ph);
      cx.fillStyle = l.col; cx.globalAlpha = .2 * tw; cx.beginPath(); cx.arc(ox + l.x, oy + l.y, 5, 0, 6.2832); cx.fill();
      cx.globalAlpha = .5 + .5 * tw; cx.beginPath(); cx.arc(ox + l.x, oy + l.y, 1.9, 0, 6.2832); cx.fill();
    }
    { const sx = ox + treeC.star.x, sy = oy + treeC.star.y, gr = cx.createRadialGradient(sx, sy, 0, sx, sy, treeC.star.r * 2.4), a = .45 + .2 * Math.sin(T * 2.4); gr.addColorStop(0, 'rgba(255,226,122,' + a + ')'); gr.addColorStop(1, 'rgba(255,226,122,0)'); cx.fillStyle = gr; cx.beginPath(); cx.arc(sx, sy, treeC.star.r * 2.4, 0, 6.2832); cx.fill(); }
  }
  function drawHat() {   // шапка Діда Мороза на логотипі
    const im = document.querySelector('.brand-head img'); if (!im) return;
    const r = im.getBoundingClientRect(); if (r.width < 60 || r.bottom < 0 || r.top > H) return;
    const s = r.width * .17, x = r.left + r.width * .125, y = r.top + r.height * .12;
    cx.save(); cx.translate(x, y); cx.rotate(-.32);
    cx.fillStyle = '#d62b2b'; cx.strokeStyle = 'rgba(80,0,0,.55)'; cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(-s * .62, 0); cx.quadraticCurveTo(-s * .35, -s * 1.15, s * .95, -s * .62); cx.quadraticCurveTo(s * .62, -s * .2, s * .62, 0); cx.closePath(); cx.fill(); cx.stroke();
    cx.fillStyle = '#f7f7fb'; cx.beginPath(); cx.moveTo(-s * .7, s * .1); cx.arc(-s * .7, s * .1, 0, 0, 0);
    const bx = -s * .72, bw = s * 1.46, bh = s * .3, rr = bh / 2;
    cx.beginPath(); cx.moveTo(bx + rr, -bh * .35); cx.lineTo(bx + bw - rr, -bh * .35); cx.arc(bx + bw - rr, -bh * .35 + rr, rr, -Math.PI / 2, Math.PI / 2); cx.lineTo(bx + rr, bh * .65); cx.arc(bx + rr, -bh * .35 + rr, rr, Math.PI / 2, Math.PI * 1.5); cx.closePath(); cx.fill();
    cx.beginPath(); cx.arc(s * .95, -s * .62, s * .2, 0, 6.2832); cx.fill();
    cx.restore();
  }
  function drawGarlands() {
    if (!O.xmasGarland) return;
    garland(0, W, 0);
  }

  /* ---------- світла/темна тема ---------- */
  function checkLight() {
    try {
      const c = getComputedStyle(document.body).backgroundColor || '', m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(c);
      if (!m || (m[4] !== undefined && parseFloat(m[4]) < .3)) { light = false; return; }
      light = (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) > 150;
    } catch { light = false; }
  }

  /* ---------- цикл ---------- */
  function wanted() {   // чи потрібно ще малювати: функції ввімкнено або лишився сніг/замети, що ще падають чи тануть
    if (active()) return true;
    if (O.off) return false;
    return flakes.length > 0 || mapSum(ground) > .3 || surfaces.size > 0;
  }
  function tick(now) {
    raf = 0;
    if (!wanted()) { dropCanvas(); flakes = []; surfaces.clear(); ground.fill(0); return; }
    ensureCanvas();
    const dt = clamp((now - (last || now)) / 1000, 0, .05); last = now; T += dt; frame++;
    if (T - lightAt > 1.5) { lightAt = T; checkLight(); }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);
    // сніг
    if (O.snow && !O.off) {
      const area = clamp(W * H / (1600 * 900), .1, 2.5), target = clamp(Math.round(O.snowCount * area), 12, 700);
      const avgVy = (22 + 2 * 16) * O.snowSpeed / 100, rate = target / Math.max(1, H / avgVy);
      spawnAcc += rate * dt;
      let normal = 0; for (const f of flakes) if (!f.free) normal++;
      while (spawnAcc >= 1) { spawnAcc -= 1; if (normal < target) { spawn(); normal++; } }
    }
    barRect = findBar();
    collectSurfaces(dt);
    stepFlakes(dt);
    if (frame % 3 === 0) { relax(ground); for (const s of surfaces.values()) relax(s.h); }
    if (!O.snow) for (let i = 0; i < ground.length; i++) if (ground[i] > 0) ground[i] = Math.max(0, ground[i] - 4 * dt);   // сніг вимкнено: замет унизу тане
    // малювання: прикраси, замети, сніжинки
    for (const s of surfaces.values()) drawPile(s.h, s.r.left, s.r.top + 1, 1, 0, Math.ceil(s.r.width / BW) + 1);
    if (barRect) { const i0 = Math.max(0, Math.floor(barRect.left / BW)), i1 = Math.min(ground.length, Math.ceil(barRect.right / BW)); drawPile(ground, 0, H + 1, 1, 0, i0); drawPile(ground, 0, barRect.top + 1, 1, i0, i1); drawPile(ground, 0, H + 1, 1, i1, ground.length); }   // замет лежить на нижній панелі, а поза нею (під лівою панеллю) - на дні вікна
    else drawPile(ground, 0, H + 1, 1);
    if (O.xmas && !O.off) { drawGarlands(); if (O.xmasTree) drawTree(); if (O.xmasHat) drawHat(); }
    drawFlakes();
    raf = requestAnimationFrame(tick);
  }
  function kick() { if (!raf && wanted()) { last = 0; raf = requestAnimationFrame(tick); } }

  window.Festive = {
    set(o) {
      if (!o) return;
      const n = { ...O };
      for (const k of Object.keys(D)) {
        if (o[k] === undefined) continue;
        n[k] = typeof D[k] === 'boolean' ? !!o[k] : typeof D[k] === 'string' ? (o[k] === 'left' ? 'left' : 'right') : Number.isFinite(Number(o[k])) ? Number(o[k]) : D[k];
      }
      n.snowCount = clamp(n.snowCount, 10, 400); n.snowSpeed = clamp(n.snowSpeed, 30, 300); n.snowSize = clamp(n.snowSize, 40, 250); n.snowWind = clamp(n.snowWind, -100, 100);
      const wasSnow = O.snow; O = n;
      if (wasSnow && !O.snow) { /* сніг вимкнено: сніжинки, що вже летять, долітають донизу, а замети тануть у циклі */ }
      if (O.off) { flakes = []; surfaces.clear(); ground.fill(0); }
      kick();
    },
  };
})();
