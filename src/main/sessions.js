'use strict';
const { session, dialog } = require('electron');
const S = require('./services');
const adblock = require('./adblock');
const vaniumProtocol = require('./protocol');
const { t } = require('../shared/i18n');

const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);
const PROMPT = new Set(['geolocation', 'media', 'notifications', 'midi', 'midiSysex', 'clipboard-read']);

function cleanUserAgent(ua) {
  // Убираем «Electron/x» и имя приложения — многие сайты иначе считают браузер «встроенным».
  return ua.replace(/\s(?:Electron|Vanium|vanium)\/\S+/g, '');
}

function permLabel(permission) {
  if (permission === 'geolocation') return t(S.lang(), 'perm_geolocation');
  if (permission === 'media') return t(S.lang(), 'perm_media');
  if (permission === 'notifications') return t(S.lang(), 'perm_notifications');
  if (permission === 'midi' || permission === 'midiSysex') return t(S.lang(), 'perm_midi');
  if (permission === 'clipboard-read') return t(S.lang(), 'perm_clipboard');
  return t(S.lang(), 'perm_other');
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return String(url || '');
  }
}

function setupPermissions(ses) {
  const decided = new Map(); // "origin|permission" -> boolean
  const pending = new Map(); // "origin|permission" -> Promise<boolean>

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    if (!PROMPT.has(permission)) return callback(false);

    const origin = originOf((details && details.requestingUrl) || wc.getURL());
    if (origin.startsWith('vanium:') || origin === 'null') return callback(false);

    const key = origin + '|' + permission;
    if (decided.has(key)) return callback(decided.get(key));

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
          decided.set(key, ok);
          pending.delete(key);
          return ok;
        });
      pending.set(key, promise);
    }
    promise.then(callback);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    return decided.get(originOf(requestingOrigin) + '|' + permission) === true;
  });
}

function setup(ses, isPrivate) {
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  vaniumProtocol.attach(ses);
  adblock.attach(
    ses,
    () => S.settings.data.adblock,
    (wcId) => {
      const entry = S.tabByWc.get(wcId);
      if (entry) entry.ctx.countBlocked(entry.tab);
    }
  );
  setupPermissions(ses);
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

module.exports = { getMainSession, createPrivateSession };
