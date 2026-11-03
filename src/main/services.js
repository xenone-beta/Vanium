'use strict';
const crypto = require('crypto');
const { app } = require('electron');
const { JsonStore } = require('./store');
const { ENGINES } = require('./engines');

/**
 * Общее состояние приложения: данные пользователя и реестр окон.
 * Окна (BrowserCtx) регистрируются здесь, чтобы изменения настроек, закладок и
 * загрузок мгновенно отражались во всех окнах.
 */
const S = {
  settings: null,
  bookmarks: null,
  history: null,
  lastSession: null,
  downloads: null, // DownloadManager (создаётся в main.js)
  windows: new Set(), // BrowserCtx
  tabByWc: new Map(), // webContents.id -> { ctx, tab }
  ctxByWc: new Map(), // webContents.id оболочки/оверлея -> ctx
  privateSessions: new WeakSet()
};

const SETTING_VALIDATORS = {
  language: (v) => v === 'ru' || v === 'en',
  tabLayout: (v) => v === 'top' || v === 'side',
  sidebarCollapsed: (v) => typeof v === 'boolean',
  searchEngine: (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ENGINES, v),
  adblock: (v) => typeof v === 'boolean',
  askDownload: (v) => typeof v === 'boolean',
  restoreSession: (v) => typeof v === 'boolean'
};

S.init = function init() {
  const locale = String(app.getLocale() || 'en').toLowerCase();
  S.settings = new JsonStore('settings', {
    language: locale.startsWith('ru') ? 'ru' : 'en',
    tabLayout: 'top',
    sidebarCollapsed: false,
    searchEngine: 'google',
    adblock: true,
    askDownload: false,
    restoreSession: true
  });
  S.bookmarks = new JsonStore('bookmarks', []);
  S.history = new JsonStore('history', []);
  S.lastSession = new JsonStore('session', { urls: [], active: 0, bounds: null, maximized: false });
};

S.id = () => crypto.randomUUID();
S.lang = () => S.settings.data.language;

// ---------- настройки ----------
S.updateSettings = function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return S.settings.data;
  const prev = Object.assign({}, S.settings.data);
  for (const [k, v] of Object.entries(patch)) {
    const ok = SETTING_VALIDATORS[k];
    if (ok && ok(v)) S.settings.data[k] = v;
  }
  S.settings.save();
  for (const ctx of S.windows) ctx.onSettingsChanged(prev);
  S.emitPages('settings');
  return S.settings.data;
};

// ---------- закладки ----------
S.isBookmarked = (url) => S.bookmarks.data.some((b) => b.url === url);

S.toggleBookmark = function toggleBookmark(url, title, icon) {
  const list = S.bookmarks.data;
  const i = list.findIndex((b) => b.url === url);
  if (i >= 0) list.splice(i, 1);
  else list.unshift({ id: S.id(), url, title: title || url, icon: icon || '', added: Date.now() });
  S.bookmarks.save();
  S.broadcastState();
  S.emitPages('bookmarks');
  return i < 0;
};

S.removeBookmark = function removeBookmark(id) {
  const i = S.bookmarks.data.findIndex((b) => b.id === id);
  if (i >= 0) S.bookmarks.data.splice(i, 1);
  S.bookmarks.save();
  S.broadcastState();
  S.emitPages('bookmarks');
};

// ---------- история ----------
S.addHistory = function addHistory(url, title, icon) {
  const h = S.history.data;
  const i = h.findIndex((e) => e.url === url);
  let e;
  if (i >= 0) {
    e = h.splice(i, 1)[0];
    e.visits = (e.visits || 1) + 1;
  } else {
    e = { id: S.id(), url, title: '', icon: '', visits: 1 };
  }
  e.last = Date.now();
  if (title) e.title = title;
  if (icon) e.icon = icon;
  h.unshift(e);
  if (h.length > 5000) h.length = 5000;
  S.history.save();
  S.emitPagesThrottled('history');
};

S.updateHistory = function updateHistory(url, patch) {
  const h = S.history.data;
  const lim = Math.min(h.length, 30);
  for (let i = 0; i < lim; i++) {
    if (h[i].url === url) {
      Object.assign(h[i], patch);
      S.history.save();
      return;
    }
  }
};

S.removeHistory = function removeHistory(id) {
  const i = S.history.data.findIndex((e) => e.id === id);
  if (i >= 0) S.history.data.splice(i, 1);
  S.history.save();
  S.emitPages('history');
};

S.clearHistory = function clearHistory() {
  S.history.data = [];
  S.history.save();
  S.emitPages('history');
};

S.topSites = function topSites(n) {
  const byHost = new Map();
  for (const e of S.history.data) {
    let u;
    try {
      u = new URL(e.url);
    } catch (_) {
      continue;
    }
    const host = u.hostname.replace(/^www\./, '');
    let rec = byHost.get(host);
    if (!rec) {
      rec = { host, url: u.origin + '/', title: '', icon: '', visits: 0 };
      byHost.set(host, rec);
    }
    rec.visits += e.visits || 1;
    if (!rec.icon && e.icon) rec.icon = e.icon;
    if (!rec.title && e.title && (u.pathname === '/' || u.pathname === '')) rec.title = e.title;
  }
  return [...byHost.values()].sort((a, b) => b.visits - a.visits).slice(0, n);
};

// ---------- подсказки адресной строки ----------
S.suggest = function suggest(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const out = [];
  const seen = new Set();

  const score = (url, title) => {
    const u = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
    const ti = (title || '').toLowerCase();
    const hay = u + ' ' + ti;
    if (!tokens.every((t) => hay.includes(t))) return -1;
    let s = 1;
    if (u.startsWith(q)) s += 6;
    else if (u.includes(q)) s += 3;
    if (ti.startsWith(q)) s += 3;
    else if (ti.includes(q)) s += 1;
    return s;
  };

  for (const b of S.bookmarks.data) {
    const s = score(b.url, b.title);
    if (s >= 0 && !seen.has(b.url)) {
      seen.add(b.url);
      out.push({ type: 'bookmark', title: b.title, url: b.url, icon: b.icon, s: s + 2 });
    }
  }
  const h = S.history.data;
  const lim = Math.min(h.length, 3000);
  for (let i = 0; i < lim; i++) {
    const e = h[i];
    const s = score(e.url, e.title);
    if (s >= 0 && !seen.has(e.url)) {
      seen.add(e.url);
      out.push({ type: 'history', title: e.title, url: e.url, icon: e.icon, s: s + Math.min(3, (e.visits || 1) / 5) - i / 3000 });
    }
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, 6).map(({ s, ...rest }) => rest);
};

// ---------- рассылка ----------
S.broadcastState = function broadcastState() {
  for (const ctx of S.windows) ctx.sendState();
};

S.emitPages = function emitPages(kind) {
  for (const ctx of S.windows) ctx.emitToPages(kind);
};

let pagesTimer = null;
const pendingKinds = new Set();
S.emitPagesThrottled = function emitPagesThrottled(kind) {
  pendingKinds.add(kind);
  if (pagesTimer) return;
  pagesTimer = setTimeout(() => {
    pagesTimer = null;
    for (const k of pendingKinds) S.emitPages(k);
    pendingKinds.clear();
  }, 500);
};

S.firstWindow = () => {
  for (const ctx of S.windows) return ctx;
  return null;
};

module.exports = S;
