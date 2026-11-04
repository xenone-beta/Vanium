'use strict';
const { session, dialog } = require('electron');
const S = require('./services');
const webrequest = require('./webrequest');
const vaniumProtocol = require('./protocol');
const { t } = require('../shared/i18n');

const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);
const PROMPT = new Set(['geolocation', 'media', 'notifications', 'midi', 'midiSysex', 'clipboard-read']);

function cleanUserAgent(ua) {
  // Убираем «Electron/x» и имя приложения — многие сайты иначе считают браузер «встроенным».
  return ua.replace(/\s(?:Electron|Vanium|vanium)\/\S+/g, '');
}

function permLabel(permission) {
  const key =
    permission === 'geolocation'
      ? 'perm_geolocation'
      : permission === 'media'
        ? 'perm_media'
        : permission === 'notifications'
          ? 'perm_notifications'
          : permission === 'midi' || permission === 'midiSysex'
            ? 'perm_midi'
            : permission === 'clipboard-read'
              ? 'perm_clipboard'
              : 'perm_other';
  return t(S.lang(), key);
}

function parseOrigin(url) {
  try {
    const u = new URL(url);
    return { origin: u.origin, host: u.hostname.toLowerCase() };
  } catch (_) {
    return { origin: String(url || ''), host: '' };
  }
}

/**
 * Разрешения сайтов. В обычной сессии решения сохраняются в настройках сайтов
 * (и видны на vanium://sites), в приватной живут только в памяти.
 */
function setupPermissions(ses, isPrivate) {
  const memory = new Map(); // "host|permission" -> 'allow' | 'block'
  const pending = new Map(); // "host|permission" -> Promise<boolean>

  const stored = (host, perm) => (isPrivate ? memory.get(host + '|' + perm) : S.sitePerm(host, perm));
  const store = (host, perm, value) => {
    if (isPrivate) memory.set(host + '|' + perm, value);
    else S.siteSetPerm(host, perm, value);
  };

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    if (!PROMPT.has(permission)) return callback(false);

    const { origin, host } = parseOrigin((details && details.requestingUrl) || wc.getURL());
    if (!host || origin.startsWith('vanium:')) return callback(false);

    const known = stored(host, permission);
    if (known) return callback(known === 'allow');

    const key = host + '|' + permission;
    let promise = pending.get(key);
    if (!promise) {
      const entry = S.tabByWc.get(wc.id);
      const win = entry && entry.ctx && !entry.ctx.win.isDestroyed() ? entry.ctx.win : undefined;
      const lang = S.lang();
      const opts = {
        type: 'question',
        buttons: [t(lang, 'permAllow'), t(lang, 'permDeny')],
        defaultId: 1,
        cancelId: 1,
        title: t(lang, 'permTitle'),
        message: t(lang, 'permText', { origin, perm: permLabel(permission) }),
        noLink: true
      };
      promise = (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
        .then((r) => r.response === 0)
        .catch(() => false)
        .then((ok) => {
          store(host, permission, ok ? 'allow' : 'block');
          pending.delete(key);
          return ok;
        });
      pending.set(key, promise);
    }
    promise.then(callback);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    const { host } = parseOrigin(requestingOrigin);
    return !!host && stored(host, permission) === 'allow';
  });
}

function setup(ses, isPrivate) {
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  vaniumProtocol.attach(ses);
  webrequest.attach(ses, (wcId) => {
    const entry = S.tabByWc.get(wcId);
    if (entry) entry.ctx.countBlocked(entry.tab);
  });
  setupPermissions(ses, isPrivate);
  S.downloads.attach(ses, isPrivate);
  return ses;
}

let mainSession = null;
function getMainSession() {
  if (!mainSession) mainSession = setup(session.fromPartition('persist:vanium'), false);
  return mainSession;
}

let privateCounter = 0;
/** Приватная сессия живёт только в памяти (раздел без префикса persist:). */
function createPrivateSession() {
  const ses = session.fromPartition('vanium-private-' + Date.now() + '-' + ++privateCounter);
  S.privateSessions.add(ses);
  return setup(ses, true);
}

/** Отдельная изолированная сессия для popup-окон расширений (протокол vex://). */
let extSession = null;
function getExtSession() {
  if (!extSession) {
    extSession = session.fromPartition('persist:vanium-ext');
    extSession.setUserAgent(cleanUserAgent(extSession.getUserAgent()));
    vaniumProtocol.attachVex(extSession);
    extSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    extSession.setPermissionCheckHandler(() => false);
  }
  return extSession;
}

module.exports = { getMainSession, createPrivateSession, getExtSession };
