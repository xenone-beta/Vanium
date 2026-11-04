'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, ipcMain, Menu, shell } = require('electron');

// Portable-версия хранит данные рядом с exe, обычная — в %APPDATA%\Vanium
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'VaniumData'));
}

app.setAppUserModelId('com.vanium.browser');

const vaniumProtocol = require('./protocol');
vaniumProtocol.registerScheme(); // обязательно до события ready

const S = require('./services');
const { flushAll } = require('./store');
const { DownloadManager } = require('./downloads');
const { ENGINES, resolveInput, NEWTAB } = require('./engines');
const { getMainSession } = require('./sessions');
const { BrowserCtx } = require('./window');
const extensions = require('./extensions');
const updater = require('./updater');
const { languages } = require('../shared/i18n');

/** Разбирает аргументы запуска: ссылки, локальные html/pdf и файлы расширений .vex. */
function targetsFromArgv(argv) {
  const urls = [];
  const vex = [];
  for (const a of argv.slice(1)) {
    if (/^https?:\/\//i.test(a)) urls.push(a);
    else if (/\.vex$/i.test(a) && fs.existsSync(a)) vex.push(a);
    else if (/\.(html?|xhtml|svg|pdf)$/i.test(a) && fs.existsSync(a)) urls.push(pathToFileURL(path.resolve(a)).toString());
  }
  return { urls, vex };
}

function installVexFiles(files, win) {
  (async () => {
    for (const f of files) await extensions.installFromFile(f, win);
  })().catch(() => {});
}

// ---------- IPC: оболочка и оверлей ----------
function registerShellIpc() {
  const ctxOf = (e) => S.ctxByWc.get(e.sender.id);
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const str = (v) => typeof v === 'string';
  const on = (channel, fn) =>
    ipcMain.on(channel, (e, ...args) => {
      const ctx = ctxOf(e);
      if (ctx && !ctx.win.isDestroyed()) fn(ctx, ...args);
    });

  ipcMain.handle('shell:init', (e) => {
    const ctx = ctxOf(e);
    return ctx ? ctx.fullState() : null;
  });
  ipcMain.handle('omni:suggest', (e, q) => (ctxOf(e) && str(q) ? S.suggest(q.slice(0, 200)) : []));

  on('tab:new', (ctx, text) => ctx.createTab(str(text) && text ? resolveInput(text, S.settings.data.searchEngine) : NEWTAB));
  on('tab:close', (ctx, id) => num(id) && ctx.closeTab(id));
  on('tab:activate', (ctx, id) => num(id) && ctx.activate(id));
  on('tab:move', (ctx, id, index) => num(id) && num(index) && ctx.moveTab(id, index));
  on('tab:context', (ctx, id) => num(id) && ctx.showTabMenu(id));
  on('tab:mute', (ctx, id) => num(id) && ctx.toggleMute(id));
  on('nav:go', (ctx, text) => str(text) && ctx.navigate(text));
  on('nav:back', (ctx) => ctx.back());
  on('nav:forward', (ctx) => ctx.forward());
  on('nav:reload', (ctx) => ctx.reload(false));
  on('nav:focus-page', (ctx) => ctx.focusPage());
  on('bookmark:toggle', (ctx) => ctx.toggleBookmark());
  on('menu:show', (ctx, x, y) => num(x) && num(y) && ctx.showMainMenu(x, y));
  on('downloads:open', (ctx) => ctx.openInternal('downloads'));
  on('internal:open', (ctx, name) => ['bookmarks', 'history', 'downloads', 'settings', 'extensions', 'sites'].includes(name) && ctx.openInternal(name));
  on('layout:toggleSidebar', () => S.updateSettings({ sidebarCollapsed: !S.settings.data.sidebarCollapsed }));
  on('overlay:update', (ctx, p) => {
    if (!p || !p.items || !Array.isArray(p.items) || !num(p.x) || !num(p.y) || !num(p.w)) return ctx.setOverlay(null);
    const items = p.items.slice(0, 8).map((i) => ({
      type: String(i.type || ''),
      title: String(i.title || ''),
      url: String(i.url || ''),
      icon: String(i.icon || ''),
      sub: String(i.sub || '')
    }));
    ctx.setOverlay({ x: p.x, y: p.y, w: p.w, items, selected: num(p.selected) ? p.selected : -1 });
  });
  on('overlay:hide', (ctx) => ctx.setOverlay(null));
  on('vex:popup', (ctx, id, rect) => str(id) && ctx.togglePopup(id, rect && num(rect.right) && num(rect.bottom) ? rect : null));
  on('site:menu', (ctx, x, y) => num(x) && num(y) && ctx.showSiteMenu(x, y));
  on('shot:cancel', (ctx) => ctx.closeSelect());
  on('shot:done', (ctx, r, mode) => {
    if (r && num(r.x) && num(r.y) && num(r.w) && num(r.h)) ctx.finishArea(r, mode === 'copy' ? 'copy' : 'save');
    else ctx.closeSelect();
  });
  on('overlay:pick', (ctx, url) => str(url) && ctx.navigate(url));
}

// ---------- IPC: расширения (.vex) ----------
function registerExtensionIpc() {
  // Синхронно, до отрисовки страницы: какие скрипты расширений нужно выполнить
  ipcMain.on('vex:match', (e, url) => {
    let out = [];
    try {
      const entry = S.tabByWc.get(e.sender.id);
      const real = (e.senderFrame && e.senderFrame.url) || url;
      if (entry && !entry.ctx.isPrivate && typeof real === 'string') out = extensions.matchFor(real);
    } catch (_) {
      out = [];
    }
    e.returnValue = out;
  });

  // Хранилище: из popup идентификатор берётся из самого окна, из content script — из preload
  ipcMain.handle('vex:storage', (e, claimedId, op, arg) => {
    const popup = S.popupByWc.get(e.sender.id);
    let id;
    if (popup) id = popup.extId;
    else {
      const entry = S.tabByWc.get(e.sender.id);
      if (!entry || entry.ctx.isPrivate) throw new Error('forbidden');
      id = claimedId;
    }
    if (typeof id !== 'string') throw new Error('bad id');
    return extensions.storage(id, String(op), arg);
  });

  ipcMain.handle('vex:tabs', (e, op, arg) => {
    const popup = S.popupByWc.get(e.sender.id);
    if (!popup) throw new Error('forbidden');
    return popup.ctx.popupTabsOp(popup.extId, String(op), arg);
  });

  ipcMain.on('vex:popup-close', (e) => {
    const popup = S.popupByWc.get(e.sender.id);
    if (popup) popup.ctx.closePopup();
  });
}

// ---------- IPC: внутренние страницы vanium:// ----------
function registerPageIpc() {
  const page = (channel, fn) =>
    ipcMain.handle(channel, (e, ...args) => {
      const frameUrl = (e.senderFrame && e.senderFrame.url) || '';
      if (!frameUrl.startsWith('vanium://')) throw new Error('forbidden');
      const entry = S.tabByWc.get(e.sender.id);
      return fn(entry ? entry.ctx : null, ...args);
    });

  const icon = (b) => ({ id: b.id, url: b.url, title: b.title, icon: b.icon, added: b.added });

  page('page:getMeta', (ctx) => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    private: !!(ctx && ctx.isPrivate),
    engines: Object.entries(ENGINES).map(([key, v]) => ({ key, name: v.name })),
    languages
  }));

  page('page:getSettings', () => ({ ...S.settings.data }));
  page('page:setSettings', (_ctx, patch) => ({ ...S.updateSettings(patch) }));

  page('page:getBookmarks', (_ctx, q) => {
    const needle = String(q || '').trim().toLowerCase();
    const list = S.bookmarks.data.filter((b) => !needle || (b.title + ' ' + b.url).toLowerCase().includes(needle));
    return list.map(icon);
  });
  page('page:removeBookmark', (_ctx, id) => S.removeBookmark(String(id)));

  page('page:getHistory', (_ctx, opts) => {
    const o = opts || {};
    const needle = String(o.q || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(o.limit) || 200));
    const offset = Math.max(0, Number(o.offset) || 0);
    const all = needle ? S.history.data.filter((h) => (h.title + ' ' + h.url).toLowerCase().includes(needle)) : S.history.data;
    return {
      total: all.length,
      items: all.slice(offset, offset + limit).map((h) => ({ id: h.id, url: h.url, title: h.title, icon: h.icon, last: h.last }))
    };
  });
  page('page:removeHistory', (_ctx, id) => S.removeHistory(String(id)));
  page('page:clearHistory', () => S.clearHistory());

  page('page:getDownloads', (ctx) =>
    S.downloads.listFor(!!(ctx && ctx.isPrivate)).map((d) => ({
      ...d,
      missing: d.state === 'completed' && !S.downloads.fileExists(d)
    }))
  );
  page('page:downloadAction', (_ctx, id, action) => S.downloads.action(String(id), String(action)));
  page('page:clearDownloads', () => S.downloads.clear());

  page('page:clearData', async (_ctx, kind) => {
    if (kind === 'cookies') {
      const ses = getMainSession();
      await ses.clearStorageData();
      await ses.clearCache();
    }
    return true;
  });

  page('page:resolve', (_ctx, text) => resolveInput(String(text || ''), S.settings.data.searchEngine));

  page('page:getExtensions', () => extensions.list());
  page('page:setExtensionEnabled', (_ctx, id, on) => extensions.setEnabled(String(id), !!on));
  page('page:removeExtension', (_ctx, id) => extensions.remove(String(id)));
  page('page:installExtension', (ctx) => extensions.installWithDialog(ctx ? ctx.win : null));

  page('page:getSites', () => S.sitesList());
  page('page:resetSite', (_ctx, host) => S.siteReset(String(host)));
  page('page:resetSitePerm', (_ctx, host, perm) => S.siteSetPerm(String(host), String(perm), null));
  page('page:clearSites', () => S.sitesClear());
  page('page:allowHttp', (_ctx, host) => {
    const h = String(host || '').toLowerCase();
    if (/^[a-z0-9.-]{1,253}$/.test(h)) S.httpAllowed.add(h);
    return true;
  });

  page('page:getUpdate', () => updater.getState());
  page('page:checkUpdate', () => updater.check());
  page('page:installUpdate', () => updater.installNow());
  page('page:openDefaultApps', () => (process.platform === 'win32' ? shell.openExternal('ms-settings:defaultapps').then(() => true) : false));

  page('page:quickLinks', (ctx) => {
    const out = [];
    const seen = new Set();
    const push = (title, url, ic) => {
      let host;
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch (_) {
        return;
      }
      if (seen.has(host) || out.length >= 8) return;
      seen.add(host);
      out.push({ title: title || host, url, icon: ic || '', host });
    };
    for (const b of S.bookmarks.data) push(b.title, b.url, b.icon);
    if (!(ctx && ctx.isPrivate)) for (const s of S.topSites(12)) push(s.title, s.url, s.icon);
    return out;
  });
}

function start() {
  S.init();
  S.downloads = new DownloadManager();
  extensions.init();
  S.openWindow = (opts) => new BrowserCtx(opts || {});

  registerShellIpc();
  registerExtensionIpc();
  registerPageIpc();

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  const sess = S.lastSession.data;
  let urls = [];
  let pins = [];
  let active = 0;
  if (S.settings.data.restoreSession && Array.isArray(sess.urls) && sess.urls.length) {
    urls = sess.urls.slice(0, 40);
    pins = Array.isArray(sess.pins) ? sess.pins.slice(0, 40) : [];
    active = sess.active || 0;
  }
  const cli = targetsFromArgv(process.argv);
  if (cli.urls.length) {
    urls.push(...cli.urls);
    pins.length = urls.length - cli.urls.length; // новые вкладки не закреплены
    active = urls.length - 1;
  }
  const ctx = S.openWindow({ urls, pins, active, bounds: sess.bounds, maximized: !!sess.maximized });
  if (cli.vex.length) installVexFiles(cli.vex, ctx.win);
  updater.init();

  app.on('activate', () => {
    if (!S.windows.size) S.openWindow({});
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const cli = targetsFromArgv(argv);
    let ctx = S.firstWindow();
    if (!ctx) {
      ctx = S.openWindow({ urls: cli.urls });
    } else {
      if (ctx.win.isMinimized()) ctx.win.restore();
      ctx.win.focus();
      cli.urls.forEach((u, i) => ctx.createTab(u, { activate: i === cli.urls.length - 1 }));
    }
    if (cli.vex.length) installVexFiles(cli.vex, ctx.win);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => flushAll());
  app.on('will-quit', () => flushAll());

  app.whenReady().then(start);
}
