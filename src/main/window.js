'use strict';
const path = require('path');
const { BrowserWindow, WebContentsView, Menu, clipboard, shell, app } = require('electron');
const S = require('./services');
const { engineFor, resolveInput, searchUrl, NEWTAB } = require('./engines');
const { getMainSession, createPrivateSession } = require('./sessions');
const { t } = require('../shared/i18n');

const BG = '#0e0e10';
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const PRELOAD_UI = path.join(__dirname, '..', 'preload', 'ui.js');
const PRELOAD_PAGE = path.join(__dirname, '..', 'preload', 'page.js');
const SHELL_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const OVERLAY_HTML = path.join(__dirname, '..', 'renderer', 'overlay.html');

function computeLayout(settings) {
  if (settings.tabLayout === 'side') {
    const sw = settings.sidebarCollapsed ? 62 : 252;
    return { mode: 'side', tabH: 0, toolH: 46, sidebarW: sw, margin: 6, left: sw, top: 46, controlsH: 46 };
  }
  return { mode: 'top', tabH: 40, toolH: 44, sidebarW: 0, margin: 6, left: 6, top: 84, controlsH: 40 };
}

/** Для страницы ошибки показываем в адресной строке исходный адрес. */
function effectiveUrl(url) {
  if (url && url.startsWith('vanium://error')) {
    try {
      return new URL(url).searchParams.get('url') || url;
    } catch (_) {
      /* ignore */
    }
  }
  return url || '';
}

function isInternal(url) {
  return typeof url === 'string' && url.startsWith('vanium://');
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return url;
  }
}

class BrowserCtx {
  constructor({ isPrivate = false, urls = [], active = 0, bounds = null, maximized = false } = {}) {
    this.isPrivate = isPrivate;
    this.tabs = [];
    this.activeId = null;
    this.nextTabId = 1;
    this.closedStack = [];
    this.htmlFullscreen = false;
    this.closing = false;
    this._stateTimer = null;
    this._sessionTimer = null;
    this._overlayOpen = false;
    this.session = isPrivate ? createPrivateSession() : getMainSession();

    const layout = computeLayout(S.settings.data);
    const winOpts = {
      width: (bounds && bounds.width) || 1280,
      height: (bounds && bounds.height) || 820,
      minWidth: 640,
      minHeight: 420,
      backgroundColor: BG,
      show: false,
      title: 'Vanium',
      icon: ICON,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: PRELOAD_UI,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        additionalArguments: [isPrivate ? '--vanium-private=1' : '--vanium-private=0']
      }
    };
    if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
      winOpts.x = bounds.x;
      winOpts.y = bounds.y;
    }
    if (process.platform !== 'darwin') {
      winOpts.titleBarOverlay = { color: BG, symbolColor: '#c8c8d0', height: layout.controlsH };
    }
    this.win = new BrowserWindow(winOpts);
    this.win.setMenuBarVisibility(false);
    if (maximized) this.win.maximize();

    // --- оболочка интерфейса (панель вкладок, адресная строка) ---
    this.shell = this.win.webContents;
    S.ctxByWc.set(this.shell.id, this);
    this.shell.loadFile(SHELL_HTML, { query: { private: isPrivate ? '1' : '0' } });
    this.shell.on('before-input-event', (e, input) => this.handleKey(e, input));
    this.shell.on('will-navigate', (e) => e.preventDefault());
    this.shell.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.shell.on('did-finish-load', () => this.sendState());

    // --- оверлей подсказок адресной строки (рисуется поверх страницы) ---
    this.overlay = new WebContentsView({
      webPreferences: { preload: PRELOAD_UI, contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.setVisible(false);
    this.overlay.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.win.contentView.addChildView(this.overlay);
    S.ctxByWc.set(this.overlay.webContents.id, this);
    this.overlay.webContents.loadFile(OVERLAY_HTML);
    this.overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    this.overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    this.win.on('resize', () => this.layoutAll());
    this.win.on('ready-to-show', () => this.win.show());
    this.win.on('close', () => this._onClose());
    this.win.on('closed', () => this._onClosed());
    this.win.on('focus', () => this.sendState());

    S.windows.add(this);

    const list = urls.length ? urls : [NEWTAB];
    list.forEach((u, i) => this.createTab(u, { activate: false }));
    const idx = Math.min(Math.max(active || 0, 0), this.tabs.length - 1);
    this.activate(this.tabs[idx].id);
    if (list.length === 1 && isInternal(list[0]) && list[0].startsWith(NEWTAB)) this.focusOmni();
  }

  // ===================== вкладки =====================
  get layout() {
    return computeLayout(S.settings.data);
  }

  active() {
    return this.tabs.find((x) => x.id === this.activeId) || null;
  }

  tabById(id) {
    return this.tabs.find((x) => x.id === id) || null;
  }

  createTab(url, { activate = true, index } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: PRELOAD_PAGE,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true
      }
    });
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(10);
    view.setBackgroundColor(BG);

    const tab = {
      id: this.nextTabId++,
      view,
      wc: view.webContents,
      title: '',
      url: '',
      icon: '',
      loading: false,
      audible: false,
      muted: false,
      blocked: 0,
      zoom: 0
    };

    if (index === undefined || index < 0 || index > this.tabs.length) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);

    S.tabByWc.set(tab.wc.id, { ctx: this, tab });
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.win.contentView.addChildView(this.overlay); // оверлей всегда выше страниц
    view.setBounds(this.contentRect());
    this._wireTab(tab);

    const target = url || NEWTAB;
    tab.url = target;
    tab.wc.loadURL(target).catch(() => {});

    if (activate) this.activate(tab.id);
    this.scheduleState();
    return tab;
  }

  _wireTab(tab) {
    const wc = tab.wc;

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      if (!this.isPrivate) S.updateHistory(wc.getURL(), { title });
      this.scheduleState();
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.icon = (favicons && favicons[0]) || '';
      if (!this.isPrivate && tab.icon) S.updateHistory(wc.getURL(), { icon: tab.icon });
      this.scheduleState();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.scheduleState();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      tab.url = wc.getURL();
      this.scheduleState();
      this.scheduleSessionSave();
    });

    wc.on('did-start-navigation', (details) => {
      // старый API передавал (event, url, isInPlace, isMainFrame), новый — один объект details
      const d = details && details.url !== undefined ? details : null;
      if (d && d.isMainFrame && !d.isSameDocument) {
        tab.blocked = 0;
        this.scheduleState();
      }
    });

    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      tab.icon = isInternal(url) ? '' : tab.icon;
      this._recordVisit(tab, url);
      this.scheduleState();
    });

    wc.on('did-navigate-in-page', (e, url, isMainFrame) => {
      if (isMainFrame === undefined) isMainFrame = e && e.isMainFrame;
      if (!isMainFrame) return;
      tab.url = url;
      this._recordVisit(tab, url);
      this.scheduleState();
    });

    wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 — отмена (ERR_ABORTED)
      if (isInternal(validatedURL)) return;
      const u = `vanium://error/?code=${encodeURIComponent(desc)}&n=${code}&url=${encodeURIComponent(validatedURL)}`;
      wc.loadURL(u).catch(() => {});
    });

    wc.on('audio-state-changed', () => {
      tab.audible = wc.isCurrentlyAudible();
      this.scheduleState();
    });

    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true;
      this.layoutAll();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false;
      this.layoutAll();
    });

    // mailto:, tel: и подобные ссылки отдаём системе
    wc.on('will-navigate', (e, url) => {
      if (/^(mailto|tel):/i.test(url)) {
        e.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });

    wc.on('before-input-event', (e, input) => this.handleKey(e, input));
    wc.on('context-menu', (_e, params) => this.showPageMenu(tab, params));

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window') {
        // window.open с параметрами окна (OAuth-входы, платёжные формы) — настоящее окно
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: BG, icon: ICON }
        };
      }
      if (/^(https?:|about:blank)/i.test(url)) {
        this.createTab(url, {
          activate: disposition !== 'background-tab',
          index: this.tabs.indexOf(tab) + 1
        });
      }
      return { action: 'deny' };
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      const u = `vanium://error/?code=${encodeURIComponent('STATUS_' + String(details.reason).toUpperCase())}&n=0&url=${encodeURIComponent(
        tab.url
      )}`;
      wc.loadURL(u).catch(() => {});
    });
  }

  _recordVisit(tab, url) {
    if (this.isPrivate || !/^https?:/i.test(url)) return;
    S.addHistory(url, tab.title && tab.url === url ? tab.title : '', tab.icon);
  }

  countBlocked(tab) {
    tab.blocked++;
    this.scheduleState();
  }

  activate(id) {
    const tab = this.tabById(id);
    if (!tab) return;
    this.activeId = id;
    for (const x of this.tabs) x.view.setVisible(x.id === id);
    this.layoutAll();
    this.setOverlay(null);
    this.scheduleState();
    // Фокус на страницу, кроме случая пустой новой вкладки (там фокус в адресной строке)
    if (!(isInternal(tab.url) && tab.url.startsWith(NEWTAB))) tab.wc.focus();
    this.scheduleSessionSave();
  }

  closeTab(id) {
    const i = this.tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const tab = this.tabs[i];
    const url = effectiveUrl(tab.wc.getURL());
    if (!this.isPrivate && /^https?:/i.test(url)) {
      this.closedStack.push(url);
      if (this.closedStack.length > 20) this.closedStack.shift();
    }
    this.tabs.splice(i, 1);
    S.tabByWc.delete(tab.wc.id);
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch (_) {
      /* ignore */
    }
    if (!tab.wc.isDestroyed()) tab.wc.close();

    if (!this.tabs.length) {
      this.win.close();
      return;
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activate(next.id);
    }
    this.scheduleState();
    this.scheduleSessionSave();
  }

  closeOthers(id) {
    for (const x of [...this.tabs]) if (x.id !== id) this.closeTab(x.id);
  }

  closeRight(id) {
    const i = this.tabs.findIndex((x) => x.id === id);
    for (const x of this.tabs.slice(i + 1)) this.closeTab(x.id);
  }

  moveTab(id, toIndex) {
    const from = this.tabs.findIndex((x) => x.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.tabs.length - 1, toIndex));
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.scheduleState();
    this.scheduleSessionSave();
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((x) => x.id === this.activeId);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  activateIndex(n) {
    if (!this.tabs.length) return;
    const tab = n === 8 ? this.tabs[this.tabs.length - 1] : this.tabs[n];
    if (tab) this.activate(tab.id);
  }

  reopenClosed() {
    const url = this.closedStack.pop();
    if (url) this.createTab(url);
  }

  duplicateTab(id) {
    const tab = this.tabById(id);
    if (!tab) return;
    this.createTab(effectiveUrl(tab.wc.getURL()), { index: this.tabs.indexOf(tab) + 1 });
  }

  toggleMute(id) {
    const tab = this.tabById(id);
    if (!tab) return;
    tab.muted = !tab.muted;
    tab.wc.setAudioMuted(tab.muted);
    this.scheduleState();
  }

  /** Открывает внутреннюю страницу (история, загрузки…) — переключается на уже открытую. */
  openInternal(name) {
    const url = `vanium://${name}/`;
    const found = this.tabs.find((x) => x.wc.getURL().startsWith(url));
    if (found) this.activate(found.id);
    else this.createTab(url);
  }

  // ===================== навигация =====================
  navigate(text) {
    const url = resolveInput(text, S.settings.data.searchEngine);
    const tab = this.active();
    if (!tab) {
      this.createTab(url);
      return;
    }
    tab.wc.loadURL(url).catch(() => {});
    tab.wc.focus();
    this.setOverlay(null);
  }

  _nav() {
    const tab = this.active();
    return tab ? tab.wc.navigationHistory || null : null;
  }

  back() {
    const tab = this.active();
    if (!tab) return;
    const nh = this._nav();
    if (nh && nh.canGoBack()) nh.goBack();
  }

  forward() {
    const tab = this.active();
    if (!tab) return;
    const nh = this._nav();
    if (nh && nh.canGoForward()) nh.goForward();
  }

  reload(hard) {
    const tab = this.active();
    if (!tab) return;
    if (tab.loading && !hard) {
      tab.wc.stop();
      return;
    }
    const cur = tab.wc.getURL();
    if (cur.startsWith('vanium://error')) {
      const orig = effectiveUrl(cur);
      if (orig && orig !== cur) {
        tab.wc.loadURL(orig).catch(() => {});
        return;
      }
    }
    if (hard) tab.wc.reloadIgnoringCache();
    else tab.wc.reload();
  }

  zoom(delta) {
    const tab = this.active();
    if (!tab) return;
    tab.zoom = delta === 0 ? 0 : Math.max(-3, Math.min(5, tab.zoom + delta));
    tab.wc.setZoomLevel(tab.zoom);
  }

  toggleDevTools() {
    const tab = this.active();
    if (!tab) return;
    if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools();
    else tab.wc.openDevTools({ mode: 'detach' });
  }

  toggleFullscreen() {
    this.win.setFullScreen(!this.win.isFullScreen());
  }

  toggleBookmark() {
    const tab = this.active();
    if (!tab) return;
    const url = effectiveUrl(tab.wc.getURL());
    if (!/^https?:/i.test(url)) return;
    S.toggleBookmark(url, tab.title, tab.icon);
  }

  focusOmni() {
    if (this.win.isDestroyed()) return;
    this.shell.focus();
    this.shell.send('shell:event', 'focus-omni');
  }

  focusPage() {
    const tab = this.active();
    if (tab) tab.wc.focus();
    this.setOverlay(null);
  }

  // ===================== раскладка =====================
  contentRect() {
    const [w, h] = this.win.getContentSize();
    if (this.htmlFullscreen) return { x: 0, y: 0, width: w, height: h };
    const L = this.layout;
    return {
      x: L.left,
      y: L.top,
      width: Math.max(0, w - L.left - L.margin),
      height: Math.max(0, h - L.top - L.margin)
    };
  }

  layoutAll() {
    if (this.win.isDestroyed()) return;
    const rect = this.contentRect();
    for (const x of this.tabs) x.view.setBounds(rect);
    this.scheduleState();
  }

  applyTitleBar() {
    if (process.platform === 'darwin') return;
    try {
      if (typeof this.win.setTitleBarOverlay === 'function') {
        this.win.setTitleBarOverlay({ color: BG, symbolColor: '#c8c8d0', height: this.layout.controlsH });
      }
    } catch (_) {
      /* платформа не поддерживает */
    }
  }

  onSettingsChanged(prev) {
    const cur = S.settings.data;
    if (prev.tabLayout !== cur.tabLayout || prev.sidebarCollapsed !== cur.sidebarCollapsed) {
      this.applyTitleBar();
      this.layoutAll();
    }
    this.sendState();
  }

  // ===================== оверлей подсказок =====================
  setOverlay(p) {
    if (this.win.isDestroyed()) return;
    if (!p || !p.items || !p.items.length) {
      if (this._overlayOpen) {
        this.overlay.setVisible(false);
        this._overlayOpen = false;
      }
      return;
    }
    const height = Math.min(p.items.length * 40 + 14, 420);
    this.overlay.setBounds({ x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.w), height });
    if (!this._overlayOpen) {
      this.overlay.setVisible(true);
      this.win.contentView.addChildView(this.overlay);
      this._overlayOpen = true;
    }
    this.overlay.webContents.send('overlay:data', { items: p.items, selected: p.selected, lang: S.lang() });
  }

  // ===================== состояние для оболочки =====================
  scheduleState() {
    if (this._stateTimer) return;
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this.sendState();
    }, 30);
  }

  fullState() {
    const s = S.settings.data;
    const active = this.active();
    const nh = active ? active.wc.navigationHistory : null;
    const curUrl = active ? effectiveUrl(active.wc.getURL()) : '';
    return {
      private: this.isPrivate,
      platform: process.platform,
      layout: this.layout,
      settings: {
        language: s.language,
        tabLayout: s.tabLayout,
        sidebarCollapsed: s.sidebarCollapsed,
        adblock: s.adblock,
        engine: engineFor(s.searchEngine).name
      },
      tabs: this.tabs.map((x) => ({
        id: x.id,
        title: x.title,
        url: effectiveUrl(x.wc.isDestroyed() ? x.url : x.wc.getURL() || x.url),
        icon: x.icon,
        loading: x.loading,
        audible: x.audible,
        muted: x.muted
      })),
      activeId: this.activeId,
      canBack: !!(nh && nh.canGoBack()),
      canForward: !!(nh && nh.canGoForward()),
      loading: !!(active && active.loading),
      bookmarked: !!curUrl && S.isBookmarked(curUrl),
      blocked: active ? active.blocked : 0,
      downloads: S.downloads ? S.downloads.summary(this.isPrivate) : { active: 0, progress: 0 },
      fullscreen: this.htmlFullscreen
    };
  }

  sendState() {
    if (this.win.isDestroyed() || this.shell.isDestroyed() || this.shell.isLoading()) return;
    this.shell.send('shell:state', this.fullState());
  }

  emitToPages(kind) {
    for (const x of this.tabs) {
      if (x.wc.isDestroyed()) continue;
      if (x.wc.getURL().startsWith('vanium://')) x.wc.send('page:event', kind);
    }
  }

  // ===================== сессия =====================
  scheduleSessionSave() {
    if (this.isPrivate || this.closing) return;
    clearTimeout(this._sessionTimer);
    this._sessionTimer = setTimeout(() => this.saveSession(), 1500);
  }

  saveSession() {
    if (this.isPrivate || this.win.isDestroyed()) return;
    const urls = this.tabs
      .map((x) => effectiveUrl(x.wc.isDestroyed() ? x.url : x.wc.getURL()))
      .filter((u) => /^https?:/i.test(u) || (isInternal(u) && !u.startsWith('vanium://error')));
    const active = Math.max(0, this.tabs.findIndex((x) => x.id === this.activeId));
    const maximized = this.win.isMaximized();
    S.lastSession.data = {
      urls,
      active,
      bounds: this.win.getNormalBounds(),
      maximized
    };
    S.lastSession.save();
  }

  _onClose() {
    if (this.isPrivate) return;
    clearTimeout(this._sessionTimer);
    // сохраняем состояние только когда закрывается последнее обычное окно
    const others = [...S.windows].filter((c) => c !== this && !c.isPrivate && !c.win.isDestroyed());
    if (!others.length) this.saveSession();
    else {
      S.lastSession.data.bounds = this.win.getNormalBounds();
      S.lastSession.save();
    }
    this.closing = true;
  }

  _onClosed() {
    this.closing = true;
    clearTimeout(this._stateTimer);
    clearTimeout(this._sessionTimer);
    for (const tab of this.tabs) {
      S.tabByWc.delete(tab.wc.id);
      if (!tab.wc.isDestroyed()) tab.wc.close();
    }
    this.tabs = [];
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.close();
    S.ctxByWc.delete(this.shell.id);
    S.windows.delete(this);
    if (this.isPrivate) {
      this.session.clearStorageData().catch(() => {});
      this.session.clearCache().catch(() => {});
    }
  }

  // ===================== горячие клавиши =====================
  handleKey(event, input) {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const { code, shift, alt } = input;
    const run = (fn) => {
      event.preventDefault();
      fn();
    };

    if (!mod && !alt) {
      if (code === 'F5') return run(() => this.reload(false));
      if (code === 'F11') return run(() => this.toggleFullscreen());
      if (code === 'F12') return run(() => this.toggleDevTools());
      return;
    }
    if (alt && !mod) {
      if (code === 'ArrowLeft') return run(() => this.back());
      if (code === 'ArrowRight') return run(() => this.forward());
      return;
    }
    if (alt) return;

    // Коды клавиш не зависят от раскладки: Ctrl+T работает и на русской раскладке
    switch (code) {
      case 'KeyT':
        return run(() => (shift ? this.reopenClosed() : this.createTab(NEWTAB)));
      case 'KeyW':
      case 'F4':
        return run(() => this.active() && this.closeTab(this.activeId));
      case 'KeyN':
        return run(() => S.openWindow({ isPrivate: !!shift }));
      case 'KeyL':
        return run(() => this.focusOmni());
      case 'KeyR':
        return run(() => this.reload(shift));
      case 'KeyD':
        return run(() => this.toggleBookmark());
      case 'KeyH':
        return run(() => this.openInternal('history'));
      case 'KeyJ':
        return run(() => this.openInternal('downloads'));
      case 'KeyB':
        if (shift) return run(() => this.openInternal('bookmarks'));
        return;
      case 'KeyI':
        if (shift) return run(() => this.toggleDevTools());
        return;
      case 'Tab':
        return run(() => this.cycle(shift ? -1 : 1));
      case 'PageDown':
        return run(() => this.cycle(1));
      case 'PageUp':
        return run(() => this.cycle(-1));
      case 'Equal':
      case 'NumpadAdd':
        return run(() => this.zoom(0.5));
      case 'Minus':
      case 'NumpadSubtract':
        return run(() => this.zoom(-0.5));
      case 'Digit0':
      case 'Numpad0':
        return run(() => this.zoom(0));
      case 'Comma':
        return run(() => this.openInternal('settings'));
      default:
        if (/^Digit[1-9]$/.test(code)) return run(() => this.activateIndex(Number(code.slice(5)) - 1));
    }
  }

  // ===================== меню =====================
  _t(key, vars) {
    return t(S.lang(), key, vars);
  }

  showMainMenu(x, y) {
    const T = (k, v) => this._t(k, v);
    const side = S.settings.data.tabLayout === 'side';
    const menu = Menu.buildFromTemplate([
      { label: T('menuNewTab'), accelerator: 'CmdOrCtrl+T', click: () => this.createTab(NEWTAB) },
      { label: T('menuNewWindow'), accelerator: 'CmdOrCtrl+N', click: () => S.openWindow({}) },
      { label: T('menuNewPrivate'), accelerator: 'CmdOrCtrl+Shift+N', click: () => S.openWindow({ isPrivate: true }) },
      { type: 'separator' },
      { label: T('menuBookmarks'), accelerator: 'CmdOrCtrl+Shift+B', click: () => this.openInternal('bookmarks') },
      { label: T('menuHistory'), accelerator: 'CmdOrCtrl+H', click: () => this.openInternal('history') },
      { label: T('menuDownloads'), accelerator: 'CmdOrCtrl+J', click: () => this.openInternal('downloads') },
      { type: 'separator' },
      {
        label: T('menuZoom'),
        submenu: [
          { label: T('menuZoomIn'), accelerator: 'CmdOrCtrl+=', click: () => this.zoom(0.5) },
          { label: T('menuZoomOut'), accelerator: 'CmdOrCtrl+-', click: () => this.zoom(-0.5) },
          { label: T('menuZoomReset'), accelerator: 'CmdOrCtrl+0', click: () => this.zoom(0) }
        ]
      },
      { label: T('menuFullscreen'), accelerator: 'F11', click: () => this.toggleFullscreen() },
      {
        label: side ? T('menuLayoutTop') : T('menuLayoutSide'),
        click: () => S.updateSettings({ tabLayout: side ? 'top' : 'side' })
      },
      { label: T('menuDevTools'), accelerator: 'F12', click: () => this.toggleDevTools() },
      { type: 'separator' },
      { label: T('menuSettings'), accelerator: 'CmdOrCtrl+,', click: () => this.openInternal('settings') },
      { label: `${T('menuAbout')} ${app.getVersion()}`, click: () => this.openInternal('settings') },
      { type: 'separator' },
      { label: T('menuQuit'), click: () => app.quit() }
    ]);
    menu.popup({ window: this.win, x: Math.round(x), y: Math.round(y) });
  }

  showTabMenu(id) {
    const tab = this.tabById(id);
    if (!tab) return;
    const T = (k, v) => this._t(k, v);
    const idx = this.tabs.indexOf(tab);
    const menu = Menu.buildFromTemplate([
      { label: T('tabReload'), click: () => tab.wc.reload() },
      { label: T('tabDuplicate'), click: () => this.duplicateTab(id) },
      { label: tab.muted ? T('tabUnmute') : T('tabMute'), click: () => this.toggleMute(id) },
      { type: 'separator' },
      { label: T('tabReopen'), enabled: this.closedStack.length > 0, click: () => this.reopenClosed() },
      { type: 'separator' },
      { label: T('tabClose'), click: () => this.closeTab(id) },
      { label: T('tabCloseOthers'), enabled: this.tabs.length > 1, click: () => this.closeOthers(id) },
      { label: T('tabCloseRight'), enabled: idx < this.tabs.length - 1, click: () => this.closeRight(id) }
    ]);
    menu.popup({ window: this.win });
  }

  showPageMenu(tab, params) {
    const T = (k, v) => this._t(k, v);
    const wc = tab.wc;
    const items = [];
    const sep = () => {
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
    };
    const openTab = (url) => this.createTab(url, { index: this.tabs.indexOf(tab) + 1, activate: false });

    if (params.linkURL) {
      items.push({ label: T('ctxOpenLinkTab'), click: () => openTab(params.linkURL) });
      items.push({ label: T('ctxCopyLink'), click: () => clipboard.writeText(params.linkURL) });
      sep();
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ label: T('ctxOpenImageTab'), click: () => openTab(params.srcURL) });
      items.push({ label: T('ctxSaveImage'), click: () => wc.downloadURL(params.srcURL) });
      items.push({ label: T('ctxCopyImage'), click: () => wc.copyImageAt(params.x, params.y) });
      items.push({ label: T('ctxCopyImageUrl'), click: () => clipboard.writeText(params.srcURL) });
      sep();
    }
    if (params.isEditable) {
      const f = params.editFlags || {};
      items.push({ label: T('ctxUndo'), enabled: !!f.canUndo, click: () => wc.undo() });
      items.push({ label: T('ctxRedo'), enabled: !!f.canRedo, click: () => wc.redo() });
      sep();
      items.push({ label: T('ctxCut'), enabled: !!f.canCut, click: () => wc.cut() });
      items.push({ label: T('ctxCopy'), enabled: !!f.canCopy, click: () => wc.copy() });
      items.push({ label: T('ctxPaste'), enabled: !!f.canPaste, click: () => wc.paste() });
      items.push({ label: T('ctxSelectAll'), click: () => wc.selectAll() });
      sep();
    } else if (params.selectionText) {
      const sel = params.selectionText.trim();
      const short = sel.length > 28 ? sel.slice(0, 28) + '…' : sel;
      items.push({ label: T('ctxCopy'), click: () => wc.copy() });
      items.push({
        label: T('ctxSearchSel', { q: short }),
        click: () => openTab(searchUrl(sel.replace(/\s+/g, ' '), S.settings.data.searchEngine))
      });
      sep();
    }
    if (!params.linkURL && !params.selectionText && !params.isEditable && params.mediaType !== 'image') {
      const nh = wc.navigationHistory;
      items.push({ label: T('back'), enabled: !!(nh && nh.canGoBack()), click: () => this.back() });
      items.push({ label: T('forward'), enabled: !!(nh && nh.canGoForward()), click: () => this.forward() });
      items.push({ label: T('reload'), click: () => this.reload(false) });
      sep();
      const url = wc.getURL();
      if (/^https?:/i.test(url)) items.push({ label: T('ctxViewSource'), click: () => openTab('view-source:' + url) });
    }
    items.push({
      label: T('ctxInspect'),
      click: () => {
        wc.inspectElement(params.x, params.y);
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
      }
    });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }
}

module.exports = { BrowserCtx, computeLayout, effectiveUrl };
