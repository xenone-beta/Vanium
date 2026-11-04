'use strict';
/**
 * Единый обработчик запросов сессии: блокировщик рекламы (с исключениями по сайтам)
 * и режим «Только HTTPS». В Electron на сессию допустим один onBeforeRequest.
 */
const S = require('./services');
const { shouldBlock } = require('./adblock');

const FILTER = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };

function isLocalHost(h) {
  h = String(h).toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    h === '[::1]' ||
    !h.includes('.') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/** Возвращает https-адрес для перехода или null. */
function upgradeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (u.port) return null; // нестандартный порт — скорее всего, локальная разработка
  if (isLocalHost(u.hostname) || S.httpAllowed.has(u.hostname)) return null;
  S.upgraded.set(u.hostname, Date.now());
  u.protocol = 'https:';
  return u.toString();
}

function siteBlockerOn(webContentsId) {
  if (!S.settings.data.adblock) return false;
  const entry = S.tabByWc.get(webContentsId);
  if (!entry) return true;
  try {
    const host = new URL(entry.tab.url).hostname.toLowerCase();
    return S.siteGet(host).adblock !== false;
  } catch (_) {
    return true;
  }
}

function attach(ses, onBlocked) {
  ses.webRequest.onBeforeRequest(FILTER, (details, callback) => {
    try {
      if (details.resourceType === 'mainFrame') {
        if (S.settings.data.httpsOnly) {
          const target = upgradeUrl(details.url);
          if (target) return callback({ redirectURL: target });
        }
        return callback({});
      }
      if (siteBlockerOn(details.webContentsId) && shouldBlock(details.url, details.resourceType)) {
        onBlocked(details.webContentsId);
        return callback({ cancel: true });
      }
    } catch (_) {
      /* ошибка в фильтре не должна ломать загрузку */
    }
    callback({});
  });
}

module.exports = { attach, upgradeUrl, isLocalHost };
