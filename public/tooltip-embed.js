/* Підказки для вікон-редакторів, що відкриваються всередині програми (нагороди, мульти-віджет).
   Вигляд і поведінка як у головної підказки програми: title -> спливна підказка, налаштування «Підказки» враховується,
   підказки біля значка ⓘ лишаються завжди. Якщо напис на кнопці обрізано (...), при наведенні показується її повна назва. */
(() => {
  if (window.__embedTip) return; window.__embedTip = true;
  const st = document.createElement('style');
  st.textContent = '.no-info-tips .tipi,.no-info-tips .ib{display:none!important}.app-tooltip{position:fixed;z-index:5000;display:none;width:max-content;max-width:min(380px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:10px 13px;border:1px solid var(--tooltip-border,#555467);border-radius:11px;background:var(--tooltip-bg,#24242e);color:var(--txt,#f0f0f5);box-shadow:0 10px 32px rgba(0,0,0,.38);font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none}'
    + '.app-tooltip.show{display:block}.app-tooltip .tip-head{display:block;margin:0 0 4px;font-weight:750;font-size:13.5px;color:var(--txt,#f0f0f5)}.app-tooltip .tip-copy{display:block;color:var(--mut-strong,#c8c8d2)}';
  document.head.appendChild(st);
  const tip = document.createElement('div'); tip.className = 'app-tooltip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip);
  let anchor = null, pinned = null;   // клік по ⓘ закріплює підказку, повторний клік ховає
  const infoOn = () => { try { return typeof parent.__infoTipsOn === 'function' ? parent.__infoTipsOn() !== false : true; } catch { return true; } };
  const syncInfo = () => document.documentElement.classList.toggle('no-info-tips', !infoOn());   // пункт «Показувати підказки ⓘ» вимкнено - значки ⓘ зникають
  syncInfo();
  const tipsOn = () => { try { return typeof parent.__hoverTipsOn === 'function' ? parent.__hoverTipsOn() !== false : true; } catch { return true; } };
  const syncVars = () => {   // кольори підказки беремо з головного вікна, щоб тема збігалась
    try {
      const cs = parent.getComputedStyle(parent.document.documentElement);
      for (const v of ['--tooltip-bg', '--tooltip-border', '--mut-strong', '--txt']) { const x = cs.getPropertyValue(v).trim(); if (x) tip.style.setProperty(v, x); }
    } catch {}
  };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const ingest = el => { if (el && el.nodeType === 1 && el.hasAttribute('title')) { const v = el.getAttribute('title'); if (v) el.dataset.tooltip = v; el.removeAttribute('title'); } };
  const ingestAll = root => { ingest(root); (root.querySelectorAll ? root.querySelectorAll('[title]') : []).forEach(ingest); };
  const ownText = el => {   // повна назва кнопки без значка-емодзі на початку
    const c = el.cloneNode(true); c.querySelectorAll('img,svg').forEach(n => n.remove());
    return clean(c.textContent).replace(/^[^\p{L}\p{N}«"(]+/u, '');
  };
  const clipped = el => {   // напис обрізано (з «…»)
    if (!el || el.nodeType !== 1 || el === document.body) return false;
    const cs = getComputedStyle(el); if (cs.display === 'inline') return false;
    if (el.scrollWidth > el.clientWidth + 1 && (cs.textOverflow === 'ellipsis' || el.matches('button,summary,option,.nm,.chip'))) return true;
    const lc = cs.webkitLineClamp; return !!lc && lc !== 'none' && el.scrollHeight > el.clientHeight + 1;
  };
  const clippedFrom = n => { let e = n && n.nodeType === 1 ? n : n && n.parentElement; for (let i = 0; e && i < 4 && e !== document.body; i++, e = e.parentElement) if (clipped(e)) return e; return null; };
  function textFor(el) {
    if (el.dataset.tooltip) return el.dataset.tooltip;
    return clipped(el) ? ownText(el) : '';   // обрізаний напис: показуємо повністю
  }
  function hide(force) { if (pinned && !force) return; if (force) pinned = null; anchor = null; tip.classList.remove('show'); tip.replaceChildren(); }
  function show(el, value) {
    if (!value) return hide();
    if (el.closest('.tipi,.ib')) { if (!infoOn()) return hide(); }
    else if (!tipsOn() && !clipped(el)) return hide();   // обрізаний текст показуємо завжди
    anchor = el;
    tip.replaceChildren();
    value.split(/\n+/).map(l => l.trim()).filter(Boolean).forEach((line, i) => {
      const p = document.createElement('span'); p.className = line.startsWith('# ') ? 'tip-head' : 'tip-copy'; p.textContent = line.startsWith('# ') ? line.slice(2) : line; tip.appendChild(p);
    });
    syncVars(); tip.classList.add('show');
    requestAnimationFrame(() => {
      if (anchor !== el) return;
      const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect(), pad = 10;
      let left = Math.max(pad, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - pad));
      let top = r.bottom + 8; if (top + tr.height > innerHeight - pad) top = r.top - tr.height - 8;
      tip.style.left = left + 'px'; tip.style.top = Math.max(pad, top) + 'px';
    });
  }
  const find = t => (t && t.closest ? t.closest('[data-tooltip],[title]') : null) || clippedFrom(t);
  ingestAll(document);
  new MutationObserver(rs => rs.forEach(m => {
    if (m.type === 'attributes') { ingest(m.target); if (anchor === m.target) show(m.target, m.target.dataset.tooltip); }
    else m.addedNodes.forEach(n => { if (n.nodeType === 1) ingestAll(n); });
  })).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  document.addEventListener('pointerover', e => { syncInfo(); const el = find(e.target); if (!el) return hide(); if (el !== anchor) { ingest(el); show(el, textFor(el)); } });
  document.addEventListener('pointerout', e => { if (anchor && !anchor.contains(e.relatedTarget)) hide(); });
  document.addEventListener('pointerdown', e => { if (e.target.closest && e.target.closest('.tipi')) return; hide(true); }, true);
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('.tipi'); if (!el) return;
    ingest(el); if (!el.dataset.tooltip) return;
    if (pinned === el) { hide(true); return; }
    hide(true); show(el, el.dataset.tooltip); pinned = el;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(true); });
  addEventListener('scroll', () => hide(), true); addEventListener('blur', () => hide(true));
})();
