/* Сторінки віджетів OBS: коли в програмі змінили профіль налаштувань, сервер розсилає profileApplied, і віджет перезавантажується з новими налаштуваннями. */
(function () {
  if (window.__pfReload) return; window.__pfReload = true;
  function connect() {
    let ws; try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch { return; }
    ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m && m.type === 'profileApplied') setTimeout(() => location.reload(), 400 + Math.random() * 400); } catch {} };
    ws.onclose = () => setTimeout(connect, 3000);
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  connect();
})();
