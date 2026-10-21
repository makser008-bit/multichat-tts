// Контекстне меню (права кнопка миші) для вікна програми. Окремий модуль без залежності від Electron, щоб його можна було перевіряти тестами.
// params - параметри події 'context-menu' від Electron; ctx - що під курсором у чаті ({ inFeed, user, text }) або null; api - дії, які виконує головний процес.
function isWebLink(u) { return /^https?:\/\//i.test(String(u || '')); }

function buildTemplate(params, ctx, api) {
  params = params || {};
  const f = params.editFlags || {};
  // поле введення: стандартні дії редагування (доступність береться від Chromium, тому «Вставити» неактивне, якщо буфер порожній)
  if (params.isEditable) {
    return [
      { label: 'Скасувати', role: 'undo', enabled: !!f.canUndo },
      { label: 'Повторити', role: 'redo', enabled: !!f.canRedo },
      { type: 'separator' },
      { label: 'Вирізати', role: 'cut', enabled: !!f.canCut },
      { label: 'Копіювати', role: 'copy', enabled: !!f.canCopy },
      { label: 'Вставити', role: 'paste', enabled: !!f.canPaste },
      { type: 'separator' },
      { label: 'Виділити все', role: 'selectAll', enabled: !!f.canSelectAll }
    ];
  }
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  if (isWebLink(params.linkURL)) {   // лише http/https: javascript:, file: та інше не відкриваємо
    items.push({ label: 'Відкрити посилання в браузері', click: () => api.openExternal(params.linkURL) });
    items.push({ label: 'Копіювати адресу посилання', click: () => api.writeText(params.linkURL) });
  }
  const sel = String(params.selectionText || '').trim();
  if (sel) {
    sep();
    items.push({ label: 'Копіювати', role: 'copy' });
  } else if (ctx && (ctx.text || ctx.user)) {   // виділення немає, але курсор над повідомленням чату
    sep();
    if (ctx.text) items.push({ label: 'Копіювати текст повідомлення', click: () => api.writeText(ctx.text) });
    if (ctx.user) items.push({ label: 'Копіювати нік', click: () => api.writeText(ctx.user) });
  }
  if (ctx && ctx.inFeed) {
    sep();
    items.push({ label: 'Виділити весь чат', click: () => api.selectFeed() });
  } else if (!items.length) {
    items.push({ label: 'Виділити все', role: 'selectAll' });   // щоб права кнопка завжди щось пропонувала
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  return items;
}

module.exports = { buildTemplate, isWebLink };

