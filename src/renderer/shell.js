/* Оболочка браузера: вкладки (сверху или сбоку), адресная строка, кнопки. */
(function () {
  'use strict';
  const api = window.vanium;
  const $ = (id) => document.getElementById(id);
  const icon = (name, size) => ICONS.svg(name, size);

  let S = null; // последнее состояние от главного процесса
  let fullUrl = ''; // полный адрес активной вкладки
  let suggestions = [];
  let selected = -1;
  let suggestSeq = 0;
  let blurTimer = null;
  let dragId = null;

  const omni = $('omni');
  const omnibox = $('omnibox');
  const lang = () => (S ? S.settings.language : 'ru');
  const T = (k, v) => I18N.t(lang(), k, v);

  // ---------- статичные иконки ----------
  function setIcon(id, name, size) {
    const el = $(id);
    const keep = el.querySelector('.count, .dl-bar');
    el.innerHTML = icon(name, size || 18);
    if (keep) el.appendChild(keep);
  }
  setIcon('btn-back', 'back');
  setIcon('btn-forward', 'forward');
  setIcon('btn-shield', 'shield');
  setIcon('btn-downloads', 'download');
  setIcon('btn-menu', 'more');
  setIcon('top-newtab', 'plus', 16);
  setIcon('btn-star', 'star', 16);

  // ---------- помощники ----------
  function displayUrl(url) {
    if (!url || url.startsWith('vanium://newtab')) return '';
    if (url.startsWith('vanium://')) return url.replace(/\/$/, '');
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
      const path = u.pathname === '/' ? '' : u.pathname;
      return u.host.replace(/^www\./, '') + path + u.search + u.hash;
    } catch (_) {
      return url;
    }
  }

  function tabTitle(tab) {
    if (tab.url && tab.url.startsWith('vanium://newtab')) return T('newTab');
    if (tab.title) return tab.title;
    if (tab.loading) return T('loading');
    const d = displayUrl(tab.url);
    return d || T('newTab');
  }

  function isHttps(url) {
    return /^https:/i.test(url || '');
  }

  // ---------- вкладки ----------
  function makeTab(tab) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.draggable = true;
    el.dataset.id = String(tab.id);
    el.setAttribute('role', 'tab');

    const fav = document.createElement('span');
    fav.className = 'fav';
    const title = document.createElement('span');
    title.className = 'title';
    const audio = document.createElement('button');
    audio.className = 'audio';
    audio.type = 'button';
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.innerHTML = icon('close', 14);
    el.append(fav, title, audio, close);

    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('.close, .audio')) api.send('tab:activate', tab.id);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        api.send('tab:close', tab.id);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api.send('tab:context', tab.id);
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      api.send('tab:close', tab.id);
    });
    audio.addEventListener('click', (e) => {
      e.stopPropagation();
      api.send('tab:mute', tab.id);
    });

    // перетаскивание для смены порядка
    el.addEventListener('dragstart', (e) => {
      dragId = tab.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(tab.id));
    });
    el.addEventListener('dragend', () => {
      dragId = null;
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    el.addEventListener('dragover', (e) => {
      if (dragId === null || dragId === tab.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const vertical = S && S.settings.tabLayout === 'side';
      const after = vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      el.classList.toggle('drop-before', !after);
      el.classList.toggle('drop-after', after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragId === null || dragId === tab.id) return;
      const ids = S.tabs.map((t) => t.id);
      const from = ids.indexOf(dragId);
      let to = ids.indexOf(tab.id);
      if (el.classList.contains('drop-after')) to += 1;
      if (from < to) to -= 1;
      el.classList.remove('drop-before', 'drop-after');
      api.send('tab:move', dragId, to);
    });
    return el;
  }

  function updateTab(el, tab, active) {
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
    const title = tabTitle(tab);
    el.title = title;
    el.querySelector('.title').textContent = title;

    // значок: спиннер → favicon → логотип (внутренние страницы) → глобус
    const fav = el.querySelector('.fav');
    const key = tab.loading ? 'spin' : tab.url.startsWith('vanium://') ? 'logo' : tab.icon || 'globe';
    if (fav.dataset.key !== key) {
      fav.dataset.key = key;
      fav.textContent = '';
      if (key === 'spin') {
        const s = document.createElement('span');
        s.className = 'spin';
        fav.appendChild(s);
      } else if (key === 'logo') {
        const img = document.createElement('img');
        img.src = '../assets/logo.svg';
        img.alt = '';
        fav.appendChild(img);
      } else if (key === 'globe') {
        fav.innerHTML = icon('globe', 15);
      } else {
        const img = document.createElement('img');
        img.alt = '';
        img.addEventListener('error', () => {
          fav.dataset.key = 'globe';
          fav.innerHTML = icon('globe', 15);
        });
        img.src = key;
        fav.appendChild(img);
      }
    }

    const audio = el.querySelector('.audio');
    const showAudio = tab.audible || tab.muted;
    audio.style.display = showAudio ? '' : 'none';
    if (showAudio) {
      audio.innerHTML = icon(tab.muted ? 'volumeOff' : 'volume', 14);
      audio.title = tab.muted ? T('unmute') : T('mute');
    }
    el.querySelector('.close').title = T('closeTab');
  }

  function syncTabs() {
    const side = S.settings.tabLayout === 'side';
    const container = side ? $('sb-tabs') : $('top-tabs');
    const other = side ? $('top-tabs') : $('sb-tabs');
    if (other.firstChild) other.textContent = '';

    const existing = new Map();
    container.querySelectorAll('.tab').forEach((el) => existing.set(Number(el.dataset.id), el));

    const frag = [];
    S.tabs.forEach((tab) => {
      let el = existing.get(tab.id);
      if (el) existing.delete(tab.id);
      else el = makeTab(tab);
      updateTab(el, tab, tab.id === S.activeId);
      frag.push(el);
    });
    existing.forEach((el) => el.remove());
    frag.forEach((el, i) => {
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    });

    container.classList.toggle('dense', !side && S.tabs.length > 7);
  }

  // ---------- общий рендер ----------
  function render() {
    const L = S.layout;
    const root = document.documentElement.style;
    root.setProperty('--tab-h', L.tabH + 'px');
    root.setProperty('--tool-h', L.toolH + 'px');
    root.setProperty('--sidebar-w', L.sidebarW + 'px');

    document.body.dataset.layout = S.settings.tabLayout;
    document.body.dataset.platform = S.platform;
    document.body.classList.toggle('collapsed', S.settings.tabLayout === 'side' && S.settings.sidebarCollapsed);
    document.documentElement.lang = lang();

    syncTabs();

    const active = S.tabs.find((t) => t.id === S.activeId);
    fullUrl = active ? active.url : '';

    $('btn-back').disabled = !S.canBack;
    $('btn-forward').disabled = !S.canForward;
    setIcon('btn-reload', S.loading ? 'close' : 'reload', 17);
    $('btn-back').title = T('back');
    $('btn-forward').title = T('forward');
    $('btn-reload').title = S.loading ? T('stop') : T('reload');
    $('btn-menu').title = T('menu');
    $('btn-downloads').title = T('downloads');
    $('top-newtab').title = T('newTab');
    omni.placeholder = T('omniPlaceholder');

    omnibox.classList.toggle('loading', !!S.loading);
    omnibox.classList.toggle('secure', isHttps(fullUrl));
    $('omni-icon').innerHTML = icon(isHttps(fullUrl) ? 'lock' : fullUrl.startsWith('vanium://') || !fullUrl ? 'search' : 'globe', 15);
    if (document.activeElement !== omni) omni.value = displayUrl(fullUrl);

    const star = $('btn-star');
    star.classList.toggle('on', !!S.bookmarked);
    star.innerHTML = icon(S.bookmarked ? 'starFill' : 'star', 16);
    star.title = S.bookmarked ? T('bookmarkRemove') : T('bookmarkAdd');
    star.hidden = !/^https?:/i.test(fullUrl);

    const shield = $('btn-shield');
    const cnt = $('shield-count');
    shield.classList.toggle('on', S.settings.adblock);
    shield.title = S.settings.adblock ? T('adblockOn', { n: S.blocked }) : T('adblockOff');
    cnt.hidden = !(S.settings.adblock && S.blocked > 0);
    cnt.textContent = S.blocked > 99 ? '99+' : String(S.blocked);
    shield.style.opacity = S.settings.adblock ? '' : '.45';

    const dl = $('dl-bar');
    dl.hidden = !(S.downloads && S.downloads.active > 0);
    dl.style.setProperty('--p', Math.round(((S.downloads && S.downloads.progress) || 0) * 100) + '%');

    const pill = $('private-pill');
    pill.hidden = !S.private;
    if (S.private) pill.innerHTML = icon('eyeOff', 14) + '<span>' + T('privateBadge') + '</span>';

    // боковая панель
    $('sb-newtab').innerHTML = icon('plus', 16) + '<span>' + T('newTab') + '</span>';
    $('sb-newtab').title = T('newTab');
    const collapsed = S.settings.sidebarCollapsed;
    setIcon('sb-collapse', 'sidebar', 17);
    $('sb-collapse').title = collapsed ? T('expandSidebar') : T('collapseSidebar');
    renderFoot();
  }

  function renderFoot() {
    const foot = $('sb-foot');
    if (foot.dataset.lang === lang() && foot.childElementCount) return;
    foot.dataset.lang = lang();
    foot.textContent = '';
    [
      ['bookmark', 'bookmarks', 'menuBookmarks'],
      ['clock', 'history', 'menuHistory'],
      ['download', 'downloads', 'menuDownloads'],
      ['settings', 'settings', 'menuSettings']
    ].forEach(([ic, page, key]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.innerHTML = icon(ic, 17);
      b.title = T(key);
      b.addEventListener('click', () => api.send('internal:open', page));
      foot.appendChild(b);
    });
  }

  // ---------- адресная строка ----------
  function hideSuggestions() {
    suggestions = [];
    selected = -1;
    api.send('overlay:hide');
  }

  function pushOverlay() {
    if (!suggestions.length) return api.send('overlay:hide');
    const r = omnibox.getBoundingClientRect();
    api.send('overlay:update', { x: r.left, y: r.bottom + 6, w: r.width, items: suggestions, selected });
  }

  async function refreshSuggestions() {
    const q = omni.value;
    const seq = ++suggestSeq;
    if (!q.trim() || q === fullUrl) {
      hideSuggestions();
      return;
    }
    let found = [];
    try {
      found = await api.invoke('omni:suggest', q);
    } catch (_) {
      /* ignore */
    }
    if (seq !== suggestSeq || document.activeElement !== omni) return;
    suggestions = [{ type: 'search', title: q, url: q, icon: '', sub: S.settings.engine }].concat(found);
    if (selected >= suggestions.length) selected = -1;
    pushOverlay();
  }

  omni.addEventListener('focus', () => {
    clearTimeout(blurTimer);
    omnibox.classList.add('focused');
    omni.value = fullUrl.startsWith('vanium://newtab') ? '' : fullUrl;
    omni.select();
  });
  omni.addEventListener('blur', () => {
    omnibox.classList.remove('focused');
    clearTimeout(blurTimer);
    // небольшая задержка: клик по подсказке в оверлее должен успеть сработать
    blurTimer = setTimeout(() => {
      suggestSeq++;
      hideSuggestions();
      if (document.activeElement !== omni) omni.value = displayUrl(fullUrl);
    }, 180);
  });
  omni.addEventListener('input', () => {
    selected = -1;
    refreshSuggestions();
  });
  omni.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      const n = suggestions.length;
      selected = e.key === 'ArrowDown' ? (selected + 1 >= n ? -1 : selected + 1) : selected - 1 < -1 ? n - 1 : selected - 1;
      pushOverlay();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = selected >= 0 && suggestions[selected] ? suggestions[selected].url : omni.value;
      suggestSeq++;
      hideSuggestions();
      if (target.trim()) api.send('nav:go', target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (suggestions.length) {
        hideSuggestions();
      } else {
        omni.value = displayUrl(fullUrl);
        api.send('nav:focus-page');
      }
    }
  });
  omnibox.addEventListener('mousedown', (e) => {
    if (e.target !== omni && !e.target.closest('#btn-star')) {
      e.preventDefault();
      omni.focus();
    }
  });

  // ---------- кнопки ----------
  $('btn-back').addEventListener('click', () => api.send('nav:back'));
  $('btn-forward').addEventListener('click', () => api.send('nav:forward'));
  $('btn-reload').addEventListener('click', () => api.send('nav:reload'));
  $('btn-star').addEventListener('click', () => api.send('bookmark:toggle'));
  $('btn-downloads').addEventListener('click', () => api.send('downloads:open'));
  $('btn-shield').addEventListener('click', () => api.send('internal:open', 'settings'));
  $('top-newtab').addEventListener('click', () => api.send('tab:new'));
  $('sb-newtab').addEventListener('click', () => api.send('tab:new'));
  $('sb-collapse').addEventListener('click', () => api.send('layout:toggleSidebar'));
  $('btn-menu').addEventListener('click', () => {
    const r = $('btn-menu').getBoundingClientRect();
    api.send('menu:show', r.left + r.width, r.bottom + 4);
  });

  // двойной клик по пустому месту полосы вкладок — новая вкладка
  $('tabstrip').addEventListener('dblclick', (e) => {
    if (e.target === $('tabstrip')) api.send('tab:new');
  });

  // ---------- связь с главным процессом ----------
  api.on('shell:state', (state) => {
    S = state;
    render();
  });
  api.on('shell:event', (name) => {
    if (name === 'focus-omni') {
      omni.focus();
      omni.select();
    }
  });

  api.invoke('shell:init').then((state) => {
    if (state && !S) {
      S = state;
      render();
    }
  });

  window.addEventListener('resize', () => {
    if (suggestions.length) pushOverlay();
  });
})();
