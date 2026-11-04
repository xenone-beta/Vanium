/* Выбор области для скриншота: рисуем замороженный снимок страницы, пользователь выделяет прямоугольник. */
(function () {
  'use strict';
  const api = window.vanium;
  const $ = (id) => document.getElementById(id);
  let lang = 'ru';
  let start = null;
  let rect = null; // { x, y, w, h }
  let dragging = false;

  const T = (k) => I18N.t(lang, k);

  function applyRect() {
    const sel = $('sel');
    sel.hidden = !rect;
    $('shade').hidden = !!rect; // когда есть выделение, затемнение делает box-shadow
    if (!rect) return;
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.w + 'px';
    sel.style.height = rect.h + 'px';
    sel.dataset.size = Math.round(rect.w) + ' × ' + Math.round(rect.h);
  }

  function placeBar() {
    const bar = $('bar');
    bar.hidden = false;
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    let x = rect.x + rect.w - bw;
    let y = rect.y + rect.h + 8;
    if (y + bh > innerHeight - 4) y = Math.max(4, rect.y + rect.h - bh - 8);
    x = Math.max(4, Math.min(innerWidth - bw - 4, x));
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  }

  const submit = (mode) => {
    if (rect && rect.w >= 4 && rect.h >= 4) api.send('shot:done', rect, mode);
    else api.send('shot:cancel');
  };

  window.addEventListener('mousedown', (e) => {
    if (e.target.closest('#bar') || e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    rect = null;
    dragging = true;
    $('bar').hidden = true;
    applyRect();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(innerWidth, e.clientX));
    const y = Math.max(0, Math.min(innerHeight, e.clientY));
    rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
    applyRect();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (rect && rect.w >= 8 && rect.h >= 8) placeBar();
    else {
      rect = null;
      applyRect();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.send('shot:cancel');
    else if (e.key === 'Enter' && rect) submit('save');
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.send('shot:cancel');
  });

  $('b-save').addEventListener('click', () => submit('save'));
  $('b-copy').addEventListener('click', () => submit('copy'));
  $('b-cancel').addEventListener('click', () => api.send('shot:cancel'));

  api.on('shot:image', (data) => {
    lang = data.lang || 'ru';
    $('bg').src = data.url;
    $('hint').textContent = T('shotHint');
    $('b-save').textContent = T('shotSave');
    $('b-copy').textContent = T('shotCopy');
    $('b-cancel').textContent = T('shotCancel');
  });
})();
