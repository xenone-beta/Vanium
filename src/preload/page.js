'use strict';
// Preload для страниц-вкладок. API выдаётся ТОЛЬКО внутренним страницам vanium://,
// обычные сайты не получают ничего. Главный процесс дополнительно проверяет адрес отправителя.
const { contextBridge, ipcRenderer } = require('electron');

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
    'page:quickLinks'
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
}
