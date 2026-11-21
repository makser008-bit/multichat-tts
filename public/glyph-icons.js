/* Редактори (мульти-віджет, нагороди): значки-символи в кнопках замінюються власними іконками з /icons.
   Те саме робить головна сторінка програми (index.html) своїм кодом. */
(function () {
  'use strict';
  const ICONS = { 'ⓘ': '/icons/info.png', '🗑': '/icons/trash.png', '⏮': '/icons/back.png', '⏭': '/icons/forward.png', '⏸': '/icons/pause.png', '▶': '/icons/play.png', '↻': '/icons/refresh.png', '✏': '/icons/pencil.png', '＋': '/icons/add.png', '👁': '/icons/eye.png', '⧉': '/icons/copy.png', '⇲': '/icons/size-from.png', '⤢': '/icons/fit-screen.png', '➕': '/icons/add.png', '🔑': '/icons/key.png', '⚠': '/icons/warning.png', '✅': '/icons/check.png', '⚫': '/icons/dot-black.png', '⏳': '/icons/hourglass.png', '💜': '/icons/heart.png', '⭐': '/icons/star.png', '🎁': '/icons/gift.png', '🚀': '/icons/rocket.png', '💎': '/icons/diamond.png', '🏆': '/icons/trophy.png', '🔥': '/icons/fire.png', '❄': '/icons/snowflake.png', '🎄': '/icons/tree.png', '⚙': '/icons/gear.png', '🔴': '/icons/dot-red.png', '🚫': '/icons/ban.png', '↑': '/icons/arrow-up.png', '↓': '/icons/arrow-down.png', '↕': '/icons/arrow-updown.png', '✓': '/icons/tick.png', '✕': '/icons/cross.png', '⏹': '/icons/stop.png', '■': '/icons/square.png', '🔒': '/icons/lock.png', '🔓': '/icons/unlock.png', '🔗': '/icons/chain.png', '📘': '/icons/book.png', '📁': '/icons/folder.png', '🔄': '/icons/sync.png', '🧪': '/icons/flask.png', '🧩': '/icons/puzzle.png', '🔕': '/icons/bell-off.png', '🎟': '/icons/ticket.png', 'ℹ': '/icons/info-circle.png', '✨': '/icons/sparkles.png', '●': '/icons/dot.png', '→': '/icons/a-right.png', '←': '/icons/a-left.png', '↔': '/icons/a-lr.png', '⇤': '/icons/a-left.png', '⇥': '/icons/a-right.png', '⤒': '/icons/a-up.png', '⤓': '/icons/a-down.png', '↖': '/icons/a-nw.png', '↗': '/icons/a-ne.png', '↙': '/icons/a-sw.png', '↘': '/icons/a-se.png', '⊡': '/icons/sq-open.png', '▾': '/icons/a-down.png', '↺': '/icons/refresh.png' };
  const SPLIT = /((?:ⓘ|🗑|⏮|⏭|⏸|▶|↻|✏|＋|⧉|👁|⇲|⤢|➕|🔑|⚠|✅|⚫|⏳|💜|⭐|🎁|🚀|💎|🏆|🔥|❄|🎄|⚙|🔴|🚫|↑|↓|↕|✓|✕|⏹|■|🔒|🔓|🔗|📘|📁|🔄|🧪|🧩|🔕|🎟|ℹ|✨|●|→|←|↔|⇤|⇥|⤒|⤓|↖|↗|↙|↘|⊡|▾|↺)\uFE0F?)/u, TEST = /[ⓘ🗑⏮⏭⏸▶↻✏＋⧉👁⇲⤢➕🔑⚠✅⚫⏳💜⭐🎁🚀💎🏆🔥❄🎄⚙🔴🚫↑↓↕✓✕⏹■🔒🔓🔗📘📁🔄🧪🧩🔕🎟ℹ✨●→←↔⇤⇥⤒⤓↖↗↙↘⊡▾↺]/u;
  function iconify(root) {
    if (!root || (root.closest && root.closest('.pos'))) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => TEST.test(n.nodeValue) && !/^(SCRIPT|STYLE|TEXTAREA|OPTION|TITLE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    const list = []; while (w.nextNode()) list.push(w.currentNode);
    for (const n of list) {
      const frag = document.createDocumentFragment();
      for (const p of n.nodeValue.split(SPLIT)) {
        const src = ICONS[p.replace(/\uFE0F$/, '')];
        if (src) { const i = document.createElement('img'); i.src = src; i.alt = ''; i.className = p.startsWith('ⓘ') ? 'ico ico-info' : '→←↔▾'.includes(p[0]) ? 'ico ico-arr' : 'ico'; i.draggable = false; frag.appendChild(i); }
        else if (p) frag.appendChild(document.createTextNode(p));
      }
      n.parentNode.replaceChild(frag, n);
    }
  }
  { const st = document.createElement('style'); st.textContent = '.ico.ico-arr{width:1.05em;height:1.05em;margin:0 2px;vertical-align:-.2em}'; document.head.appendChild(st); }
  iconify(document.body);
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      const host = n.nodeType === 1 ? n : n.nodeType === 3 ? n.parentNode : null;
      if (host && host.isConnected && TEST.test(n.nodeType === 1 ? n.textContent : n.nodeValue)) iconify(host);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();

/* Випадні списки: стрілка вправо, коли закрито, і вниз, коли відкрито (так само, як у головному вікні програми) */
(function () {
  'use strict';
  const st = document.createElement('style');
  st.textContent = "select:not([multiple]):not([size]):not(#_){-webkit-appearance:none;appearance:none;padding-right:36px;background-repeat:no-repeat;background-position:right 13px center;background-size:11px 11px;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M4 2l4.5 4L4 10' fill='none' stroke='%239aa0b4' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")}select:not([multiple]):not([size]):not(#_).open{background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4.5L10 4' fill='none' stroke='%239aa0b4' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")}";
  document.head.appendChild(st);
  const ok = e => e.target && e.target.tagName === 'SELECT' && !e.target.multiple && !e.target.size;
  document.addEventListener('mousedown', e => { if (ok(e)) e.target.classList.toggle('open'); }, true);
  document.addEventListener('change', e => { if (ok(e)) e.target.classList.remove('open'); }, true);
  document.addEventListener('focusout', e => { if (ok(e)) e.target.classList.remove('open'); }, true);
  document.addEventListener('keydown', e => { if (ok(e) && (e.key === 'Escape' || e.key === 'Enter')) e.target.classList.remove('open'); }, true);
})();

(function glueTips() {   // значок ⓘ завжди стоїть одразу після останнього слова: слово й значок складають один нерозривний шматок і переносяться разом
  const glue = root => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.tipi, .ib').forEach(t => {
      if (t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('tip-nb')) return;
      const p = t.previousSibling;
      if (!p || p.nodeType !== 3) return;
      const m = /(\S+)\s*$/.exec(p.nodeValue); if (!m) return;
      const w = document.createElement('span'); w.className = 'tip-nb'; w.style.whiteSpace = 'nowrap';
      p.nodeValue = p.nodeValue.slice(0, m.index);
      p.after(w); w.append(document.createTextNode(m[1]), t);
    });
  };
  glue(document);
  new MutationObserver(ms => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) glue(n.matches && n.matches('.tipi, .ib') && n.parentNode ? n.parentNode : n);
  }).observe(document.body, { childList: true, subtree: true });
})();
