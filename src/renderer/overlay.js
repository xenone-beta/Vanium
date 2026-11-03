/* Оверлей подсказок адресной строки: только отрисовка, выбор отправляется в главный процесс. */
(function () {
  'use strict';
  const api = window.vanium;
  const panel = document.getElementById('panel');

  function shortUrl(url) {
    try {
      const u = new URL(url);
      return u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search;
    } catch (_) {
      return url;
    }
  }

  function render(data) {
    const lang = data.lang || 'ru';
    panel.textContent = '';
    data.items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'item' + (i === data.selected ? ' sel' : '');
      row.setAttribute('role', 'option');

      const fav = document.createElement('span');
      fav.className = 'fav';
      if (item.type === 'search') {
        fav.innerHTML = ICONS.svg('search', 16);
      } else if (item.icon) {
        const img = document.createElement('img');
        img.alt = '';
        img.addEventListener('error', () => {
          fav.textContent = '';
          fav.innerHTML = ICONS.svg(item.type === 'bookmark' ? 'star' : 'globe', 16);
        });
        img.src = item.icon;
        fav.appendChild(img);
      } else {
        fav.innerHTML = ICONS.svg(item.type === 'bookmark' ? 'star' : 'globe', 16);
      }

      const text = document.createElement('span');
      text.className = 'text';
      const title = document.createElement('span');
      title.className = 'title';
      const sub = document.createElement('span');
      sub.className = 'sub';

      if (item.type === 'search') {
        title.textContent = item.title;
        sub.textContent = I18N.t(lang, 'searchIn', { engine: item.sub || '' });
      } else {
        title.textContent = item.title || shortUrl(item.url);
        sub.textContent = shortUrl(item.url);
      }
      text.append(title, sub);

      row.append(fav, text);
      if (item.type === 'bookmark') {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = I18N.t(lang, 'pgBookmarks');
        row.appendChild(tag);
      }

      // mousedown, а не click: фокус адресной строки не должен успеть сняться
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        api.send('overlay:pick', item.url);
      });
      panel.appendChild(row);
    });
  }

  api.on('overlay:data', render);
})();
