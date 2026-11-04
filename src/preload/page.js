'use strict';
// Preload для страниц-вкладок.
// 1) API vanium.* выдаётся ТОЛЬКО внутренним страницам vanium:// (главный процесс дополнительно проверяет адрес).
// 2) На сайтах http(s) здесь запускаются content scripts установленных расширений (.vex)
//    в отдельном изолированном мире: у скрипта есть DOM страницы, но нет её JS-переменных и нет Node.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

if (location.protocol === 'vanium:') {
  const INVOKE = new Set([
    'page:getMeta',
    'page:getSettings',
    'page:setSettings',
    'page:getBookmarks',
    'page:removeBookmark',
    'page:getHistory',
    'page:removeHistory',
    'page:clearHistory',
    'page:getDownloads',
    'page:downloadAction',
    'page:clearDownloads',
    'page:clearData',
    'page:resolve',
    'page:quickLinks',
    'page:getExtensions',
    'page:setExtensionEnabled',
    'page:removeExtension',
    'page:installExtension',
    'page:getSites',
    'page:resetSite',
    'page:resetSitePerm',
    'page:clearSites',
    'page:allowHttp',
    'page:getUpdate',
    'page:checkUpdate',
    'page:installUpdate',
    'page:openDefaultApps'
  ]);

  contextBridge.exposeInMainWorld('vanium', {
    invoke(channel, ...args) {
      if (!INVOKE.has(channel)) return Promise.reject(new Error('blocked channel'));
      return ipcRenderer.invoke(channel, ...args);
    },
    onEvent(callback) {
      const handler = (_e, kind) => callback(kind);
      ipcRenderer.on('page:event', handler);
      return () => ipcRenderer.removeListener('page:event', handler);
    }
  });
} else if (location.protocol === 'http:' || location.protocol === 'https:') {
  try {
    runExtensions();
  } catch (_) {
    /* расширения не должны ломать загрузку страницы */
  }
}

function runExtensions() {
  let list = [];
  try {
    list = ipcRenderer.sendSync('vex:match', location.href) || [];
  } catch (_) {
    list = [];
  }
  if (!list.length) return;

  const listeners = new Map(); // extId -> Set<function>
  ipcRenderer.on('vex:message', (_e, extId, message) => {
    const set = listeners.get(extId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(message);
      } catch (_) {
        /* ошибка в обработчике расширения не должна влиять на остальные */
      }
    }
  });

  const apiFor = (ext) => {
    const storage = (op) => (arg) => ipcRenderer.invoke('vex:storage', ext.id, op, arg);
    const api = {
      id: ext.id,
      version: ext.version,
      onMessage(callback) {
        if (typeof callback !== 'function') return;
        if (!listeners.has(ext.id)) listeners.set(ext.id, new Set());
        listeners.get(ext.id).add(callback);
      }
    };
    if (ext.storage) api.storage = { get: storage('get'), set: storage('set'), remove: storage('remove'), clear: storage('clear') };
    return api;
  };

  const exec = (ext, files) => {
    for (const f of files) {
      webFrame
        .executeJavaScriptInIsolatedWorld(ext.world, [{ code: f.code, url: `vex://${ext.id}/${f.file}` }])
        .catch((e) => console.error(`[${ext.name}] ${f.file}:`, e && e.message));
    }
  };

  const whenReady = (stage, fn) => {
    if (stage === 'document_start') return fn();
    if (stage === 'document_end') {
      if (document.readyState !== 'loading') return fn();
      return document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
    // document_idle: после DOMContentLoaded, без блокировки отрисовки
    const go = () => setTimeout(fn, 0);
    if (document.readyState !== 'loading') return go();
    document.addEventListener('DOMContentLoaded', go, { once: true });
  };

  for (const ext of list) {
    try {
      webFrame.setIsolatedWorldInfo(ext.world, { name: ext.name });
    } catch (_) {
      /* необязательно */
    }
    contextBridge.exposeInIsolatedWorld(ext.world, 'vex', apiFor(ext));
    for (const sc of ext.scripts) {
      whenReady(sc.runAt, () => {
        for (const css of sc.css) {
          try {
            webFrame.insertCSS(css);
          } catch (_) {
            /* ignore */
          }
        }
        exec(ext, sc.js);
      });
    }
  }
}
