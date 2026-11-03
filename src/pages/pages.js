/* Внутренние страницы Vanium: vanium://newtab | history | bookmarks | downloads | settings | error */
(function () {
  'use strict';
  const api = window.vanium;
  const root = document.getElementById('root');
  const page = location.hostname;

  let meta = { engines: [], version: '', private: false };
  let settings = { language: 'ru', searchEngine: 'google', tabLayout: 'top' };
  const lang = () => settings.language;
  const T = (k, v) => I18N.t(lang(), k, v);
  const ic = (n, s) => ICONS.svg(n, s);

  // ---------- мини-конструктор DOM ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v; // только статичные иконки
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function favicon(url, iconUrl) {
    const box = h('span', { class: 'fav' });
    const fallback = () => {
      box.textContent = '';
      box.innerHTML = ic('globe', 16);
    };
    if (iconUrl) {
      const img = h('img', { alt: '' });
      img.addEventListener('error', fallback);
      img.src = iconUrl;
      box.append(img);
    } else fallback();
    return box;
  }

  function host(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return url;
    }
  }

  function fmtSize(n) {
    if (!n || n < 0) return '0 ' + T('sizeB');
    const u = ['sizeB', 'sizeKB', 'sizeMB', 'sizeGB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)) + ' ' + T(u[i]);
  }

  const locale = () => (lang() === 'ru' ? 'ru-RU' : 'en-US');

  // ---------- каркас страниц управления ----------
  const NAV = [
    ['bookmarks', 'bookmark', 'pgBookmarks'],
    ['history', 'clock', 'pgHistory'],
    ['downloads', 'download', 'pgDownloads'],
    ['settings', 'settings', 'pgSettings']
  ];

  function shellPage(title, headExtras, content) {
    const nav = h(
      'nav',
      { class: 'nav' },
      h('div', { class: 'brand' }, h('img', { src: '/logo.svg', alt: '' }), h('span', null, 'Vanium')),
      NAV.map(([p, icon, key]) =>
        h('a', { href: `vanium://${p}/`, class: p === page ? 'active' : '' }, h('span', { html: ic(icon, 18), style: 'display:grid' }), h('span', null, T(key)))
      )
    );
    return h(
      'div',
      { class: 'layout' },
      nav,
      h('main', { class: 'main' }, h('div', { class: 'wrap' }, h('div', { class: 'head' }, h('h1', null, title), headExtras), content))
    );
  }

  function searchField(placeholder, value, onInput) {
    const input = h('input', { class: 'input', type: 'search', placeholder, value: value || '', autocomplete: 'off' });
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => onInput(input.value), 150);
    });
    return { el: h('div', { class: 'field' }, h('span', { html: ic('search', 16) }), input), input };
  }

  function empty(iconName, text) {
    return h('div', { class: 'empty' }, h('div', { html: ic(iconName, 40) }), h('div', null, text));
  }

  // =====================================================================
  // Новая вкладка
  // =====================================================================
  async function renderNewtab() {
    document.title = T('pgNewtab');
    const engine = (meta.engines.find((e) => e.key === settings.searchEngine) || { name: 'Google' }).name;
    const links = await api.invoke('page:quickLinks');

    const clock = h('div', { class: 'nt-clock' });
    const greet = h('div', { class: 'nt-greet' });
    const tick = () => {
      const d = new Date();
      clock.textContent = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
      const hr = d.getHours();
      const g = hr < 5 ? 'greetNight' : hr < 12 ? 'greetMorning' : hr < 18 ? 'greetDay' : 'greetEvening';
      greet.textContent = T(g) + ' · ' + d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
    };
    tick();
    clearInterval(renderNewtab.timer);
    renderNewtab.timer = setInterval(tick, 10000);

    const input = h('input', { class: 'input', type: 'text', placeholder: T('searchPlaceholder', { engine }), autocomplete: 'off', spellcheck: 'false' });
    const form = h('form', { class: 'nt-search' }, h('div', { class: 'field' }, h('span', { html: ic('search', 20) }), input));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      location.href = await api.invoke('page:resolve', input.value);
    });

    const tiles = links.length
      ? h(
          'div',
          { class: 'quick' },
          links.map((l) => {
            const ti = h('span', { class: 'ti' });
            const letter = () => {
              ti.textContent = (l.host[0] || '?').toUpperCase();
            };
            if (l.icon) {
              const img = h('img', { alt: '' });
              img.addEventListener('error', () => {
                ti.textContent = '';
                letter();
              });
              img.src = l.icon;
              ti.append(img);
            } else letter();
            return h('a', { class: 'tile', href: l.url, title: l.url }, ti, h('span', { class: 'tt' }, l.title.length > 22 ? l.title.slice(0, 22) + '…' : l.title));
          })
        )
      : h('div', { class: 'nt-hint' }, T('noQuickLinks'));

    root.textContent = '';
    root.append(
      h(
        'div',
        { class: 'newtab' },
        h('div', { class: 'nt-brand' }, h('img', { src: '/logo.svg', alt: '' }), 'Vanium'),
        h(
          'div',
          { class: 'nt-inner' },
          clock,
          greet,
          meta.private ? h('div', { class: 'nt-private' }, h('span', { html: ic('eyeOff', 15), style: 'display:grid' }), T('private')) : null,
          form,
          tiles
        )
      )
    );
  }

  // =====================================================================
  // История
  // =====================================================================
  const hist = { q: '', items: [], total: 0 };

  async function loadHistory(append) {
    const r = await api.invoke('page:getHistory', { q: hist.q, limit: 200, offset: append ? hist.items.length : 0 });
    hist.total = r.total;
    hist.items = append ? hist.items.concat(r.items) : r.items;
    drawHistory();
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date();
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return T('today');
    if (d.toDateString() === y.toDateString()) return T('yesterday');
    return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function drawHistory() {
    const box = document.getElementById('hist-box');
    if (!box) return;
    box.textContent = '';
    if (!hist.items.length) {
      box.append(empty('clock', hist.q ? T('historyNothing') : T('historyEmpty')));
      return;
    }
    let lastDay = '';
    let list = null;
    for (const it of hist.items) {
      const label = dayLabel(it.last);
      if (label !== lastDay) {
        lastDay = label;
        box.append(h('div', { class: 'group-title' }, label));
        list = h('div', { class: 'list' });
        box.append(list);
      }
      list.append(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'time' }, new Date(it.last).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })),
          favicon(it.url, it.icon),
          h('a', { class: 'body', href: it.url, title: it.url }, h('span', { class: 't' }, it.title || host(it.url)), h('span', { class: 'u' }, host(it.url))),
          h('button', {
            class: 'icon-btn danger',
            title: T('remove'),
            html: ic('close', 16),
            onclick: async () => {
              await api.invoke('page:removeHistory', it.id);
            }
          })
        )
      );
    }
    if (hist.items.length < hist.total) {
      box.append(h('div', { class: 'more' }, h('button', { class: 'btn', onclick: () => loadHistory(true) }, T('showMore'))));
    }
  }

  function renderHistory() {
    document.title = T('pgHistory');
    const s = searchField(T('searchHistory'), hist.q, (v) => {
      hist.q = v;
      loadHistory(false);
    });
    const clear = h(
      'button',
      {
        class: 'btn danger',
        onclick: async () => {
          if (confirm(T('stConfirmClear'))) await api.invoke('page:clearHistory');
        }
      },
      h('span', { html: ic('trash', 16), style: 'display:grid' }),
      T('clearHistory')
    );
    root.textContent = '';
    root.append(shellPage(T('pgHistory'), [s.el, clear], h('div', { id: 'hist-box' })));
    loadHistory(false);
  }

  // =====================================================================
  // Закладки
  // =====================================================================
  const bm = { q: '' };

  async function drawBookmarks() {
    const box = document.getElementById('bm-box');
    if (!box) return;
    const items = await api.invoke('page:getBookmarks', bm.q);
    box.textContent = '';
    if (!items.length) {
      box.append(empty('star', bm.q ? T('historyNothing') : T('bookmarksEmpty')));
      return;
    }
    const list = h('div', { class: 'list' });
    for (const b of items) {
      list.append(
        h(
          'div',
          { class: 'row' },
          favicon(b.url, b.icon),
          h('a', { class: 'body', href: b.url, title: b.url }, h('span', { class: 't' }, b.title || host(b.url)), h('span', { class: 'u' }, host(b.url))),
          h('button', {
            class: 'icon-btn danger',
            title: T('remove'),
            html: ic('trash', 16),
            onclick: () => api.invoke('page:removeBookmark', b.id)
          })
        )
      );
    }
    box.append(list);
  }

  function renderBookmarks() {
    document.title = T('pgBookmarks');
    const s = searchField(T('searchBookmarks'), bm.q, (v) => {
      bm.q = v;
      drawBookmarks();
    });
    root.textContent = '';
    root.append(shellPage(T('pgBookmarks'), s.el, h('div', { id: 'bm-box' })));
    drawBookmarks();
  }

  // =====================================================================
  // Загрузки
  // =====================================================================
  async function drawDownloads() {
    const box = document.getElementById('dl-box');
    if (!box) return;
    const items = await api.invoke('page:getDownloads');
    box.textContent = '';
    if (!items.length) {
      box.append(empty('download', T('downloadsEmpty')));
      return;
    }
    const list = h('div', { class: 'list' });
    for (const d of items) {
      const active = d.state === 'progressing' || d.state === 'paused';
      const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
      let status;
      if (active) status = d.total > 0 ? T('dlProgress', { done: fmtSize(d.received), total: fmtSize(d.total) }) + ` · ${pct}%` : T('dlProgressUnknown', { done: fmtSize(d.received) });
      else if (d.state === 'completed') status = d.missing ? h('span', { class: 'bad' }, T('dlFileMissing')) : T('dlCompleted') + ' · ' + fmtSize(d.total || d.received);
      else if (d.state === 'cancelled') status = T('dlCancelled');
      else status = h('span', { class: 'bad' }, T('dlInterrupted'));

      const acts = h('div', { class: 'acts' });
      if (active) acts.append(h('button', { class: 'btn sm', onclick: () => api.invoke('page:downloadAction', d.id, 'cancel') }, T('dlCancel')));
      else {
        if (d.state === 'completed' && !d.missing) {
          acts.append(h('button', { class: 'icon-btn', title: T('dlOpen'), html: ic('open', 17), onclick: () => api.invoke('page:downloadAction', d.id, 'open') }));
          acts.append(h('button', { class: 'icon-btn', title: T('dlShow'), html: ic('folder', 17), onclick: () => api.invoke('page:downloadAction', d.id, 'show') }));
        }
        acts.append(h('button', { class: 'icon-btn danger', title: T('dlRemove'), html: ic('close', 17), onclick: () => api.invoke('page:downloadAction', d.id, 'remove') }));
      }

      list.append(
        h(
          'div',
          { class: 'dl' },
          h('div', { class: 'file', html: ic('download', 19) }),
          h(
            'div',
            { class: 'info' },
            h('div', { class: 'name' + (d.missing ? ' missing' : ''), title: d.path || d.name }, d.name),
            h('div', { class: 'meta' }, status, ' · ', host(d.url)),
            active ? h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null
          ),
          acts
        )
      );
    }
    box.append(list);
  }

  function renderDownloads() {
    document.title = T('pgDownloads');
    const clear = h('button', { class: 'btn', onclick: () => api.invoke('page:clearDownloads') }, T('clearList'));
    root.textContent = '';
    root.append(shellPage(T('pgDownloads'), clear, h('div', { id: 'dl-box' })));
    drawDownloads();
  }

  // =====================================================================
  // Настройки
  // =====================================================================
  async function save(patch) {
    settings = await api.invoke('page:setSettings', patch);
  }

  function setRow(name, desc, control) {
    return h('div', { class: 'set' }, h('div', { class: 'lbl' }, h('div', { class: 'n' }, name), desc ? h('div', { class: 'd' }, desc) : null), control);
  }

  function toggle(key) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!settings[key];
    input.addEventListener('change', () => save({ [key]: input.checked }));
    return h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
  }

  function select(options, value, onChange) {
    const el = h('select', { class: 'select' }, options.map(([v, label]) => h('option', { value: v }, label)));
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function clearBtn(kind) {
    const btn = h('button', { class: 'btn danger sm' }, T('stClearBtn'));
    btn.addEventListener('click', async () => {
      if (!confirm(T('stConfirmClear'))) return;
      if (kind === 'history') await api.invoke('page:clearHistory');
      else if (kind === 'downloads') await api.invoke('page:clearDownloads');
      else await api.invoke('page:clearData', 'cookies');
      btn.textContent = T('stCleared');
      btn.classList.add('flash');
      setTimeout(() => {
        btn.textContent = T('stClearBtn');
        btn.classList.remove('flash');
      }, 1600);
    });
    return btn;
  }

  const SHORTCUTS = {
    ru: [
      ['Ctrl+T', 'Новая вкладка'],
      ['Ctrl+W', 'Закрыть вкладку'],
      ['Ctrl+Shift+T', 'Открыть закрытую вкладку'],
      ['Ctrl+Tab / Ctrl+1…9', 'Переключение вкладок'],
      ['Ctrl+L', 'Адресная строка'],
      ['Ctrl+D', 'Добавить в закладки'],
      ['Ctrl+N / Ctrl+Shift+N', 'Новое / приватное окно'],
      ['Ctrl+H / Ctrl+J', 'История / загрузки'],
      ['Ctrl + + / − / 0', 'Масштаб страницы'],
      ['F12', 'Инструменты разработчика']
    ],
    en: [
      ['Ctrl+T', 'New tab'],
      ['Ctrl+W', 'Close tab'],
      ['Ctrl+Shift+T', 'Reopen closed tab'],
      ['Ctrl+Tab / Ctrl+1…9', 'Switch tabs'],
      ['Ctrl+L', 'Address bar'],
      ['Ctrl+D', 'Bookmark page'],
      ['Ctrl+N / Ctrl+Shift+N', 'New / private window'],
      ['Ctrl+H / Ctrl+J', 'History / downloads'],
      ['Ctrl + + / − / 0', 'Page zoom'],
      ['F12', 'Developer tools']
    ]
  };

  function renderSettings() {
    document.title = T('pgSettings');
    const layoutSeg = h(
      'div',
      { class: 'seg' },
      [['top', 'stLayoutTop'], ['side', 'stLayoutSide']].map(([v, k]) =>
        h('button', { class: settings.tabLayout === v ? 'active' : '', type: 'button', onclick: () => save({ tabLayout: v }) }, T(k))
      )
    );

    const general = h(
      'section',
      { class: 'card' },
      h('h2', null, T('stGeneral')),
      setRow(T('stLanguage'), null, select(Object.entries(I18N.languages), settings.language, (v) => save({ language: v }))),
      setRow(T('stSearchEngine'), null, select(meta.engines.map((e) => [e.key, e.name]), settings.searchEngine, (v) => save({ searchEngine: v }))),
      setRow(T('stTabLayout'), null, layoutSeg),
      setRow(T('stRestore'), T('stRestoreHint'), toggle('restoreSession'))
    );

    const privacy = h(
      'section',
      { class: 'card' },
      h('h2', null, T('stPrivacy')),
      setRow(T('stAdblock'), T('stAdblockHint'), toggle('adblock')),
      setRow(T('stAskDownload'), T('stAskDownloadHint'), toggle('askDownload'))
    );

    const data = h(
      'section',
      { class: 'card' },
      h('h2', null, T('stData')),
      setRow(T('stClearHistory'), null, clearBtn('history')),
      setRow(T('stClearCookies'), null, clearBtn('cookies')),
      setRow(T('stClearDownloads'), null, clearBtn('downloads'))
    );

    const keys = h(
      'section',
      { class: 'card' },
      h('h2', null, lang() === 'ru' ? 'Горячие клавиши' : 'Keyboard shortcuts'),
      h(
        'div',
        { class: 'keys' },
        SHORTCUTS[lang()].map(([k, d]) => [
          h('div', null, k.split(' / ').map((part) => h('kbd', null, part))),
          h('div', { style: 'color:var(--text-2)' }, d)
        ])
      )
    );

    const about = h(
      'section',
      { class: 'card' },
      h('h2', null, T('stAbout')),
      h('div', { class: 'about-text' }, T('stAboutText')),
      h(
        'div',
        { class: 'kv', style: 'padding-top:14px' },
        h('b', null, T('stVersion')),
        h('span', null, 'Vanium ' + meta.version),
        h('b', null, 'Chromium'),
        h('span', null, meta.chrome || ''),
        h('b', null, 'Electron'),
        h('span', null, meta.electron || '')
      )
    );

    const scrollY = window.scrollY;
    root.textContent = '';
    root.append(shellPage(T('pgSettings'), null, h('div', null, general, privacy, data, keys, about)));
    window.scrollTo(0, scrollY);
  }

  // =====================================================================
  // Страница ошибки
  // =====================================================================
  function renderError() {
    document.title = T('pgError');
    const p = new URLSearchParams(location.search);
    const code = p.get('code') || '';
    const url = p.get('url') || '';
    let key = 'err_' + code;
    if (code.startsWith('ERR_CERT')) key = 'err_ERR_CERT';
    else if (code.startsWith('ERR_BLOCKED')) key = 'err_ERR_BLOCKED';
    const known = I18N.dict.en[key] !== undefined;
    root.textContent = '';
    root.append(
      h(
        'div',
        { class: 'err' },
        h(
          'div',
          { class: 'err-card' },
          h('div', { class: 'err-ic', html: ic('alert', 28) }),
          h('h1', null, T('errTitle')),
          url ? h('div', { class: 'url' }, url) : null,
          h('p', null, T(known ? key : 'err_generic')),
          code ? h('div', { class: 'code' }, T('errCode', { code })) : null,
          h(
            'div',
            { style: 'display:flex;gap:10px' },
            url ? h('button', { class: 'btn primary', onclick: () => (location.href = url) }, T('errRetry')) : null,
            h('a', { class: 'btn', href: 'vanium://newtab/' }, T('errGoNewtab'))
          )
        )
      )
    );
  }

  // =====================================================================
  // Запуск
  // =====================================================================
  function render() {
    switch (page) {
      case 'newtab':
        return renderNewtab();
      case 'history':
        return renderHistory();
      case 'bookmarks':
        return renderBookmarks();
      case 'downloads':
        return renderDownloads();
      case 'settings':
        return renderSettings();
      case 'error':
        return renderError();
    }
  }

  async function init() {
    [meta, settings] = await Promise.all([api.invoke('page:getMeta'), api.invoke('page:getSettings')]);
    document.documentElement.lang = lang();
    render();

    api.onEvent(async (kind) => {
      if (kind === 'settings') {
        settings = await api.invoke('page:getSettings');
        document.documentElement.lang = lang();
        render();
      } else if (kind === 'history' && page === 'history') loadHistory(false);
      else if (kind === 'bookmarks' && page === 'bookmarks') drawBookmarks();
      else if (kind === 'downloads' && page === 'downloads') drawDownloads();
    });
  }

  if (api) init();
  else root.textContent = 'Vanium API unavailable';
})();
