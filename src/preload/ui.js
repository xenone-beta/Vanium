'use strict';
// Preload для оболочки (панель вкладок) и оверлея подсказок.
// Наружу выдаётся только белый список каналов.
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'tab:new',
  'tab:close',
  'tab:activate',
  'tab:move',
  'tab:context',
  'tab:mute',
  'nav:go',
  'nav:back',
  'nav:forward',
  'nav:reload',
  'nav:focus-page',
  'bookmark:toggle',
  'menu:show',
  'downloads:open',
  'internal:open',
  'layout:toggleSidebar',
  'overlay:update',
  'overlay:hide',
  'overlay:pick'
]);
const INVOKE = new Set(['shell:init', 'omni:suggest']);
const ON = new Set(['shell:state', 'shell:event', 'overlay:data']);

contextBridge.exposeInMainWorld('vanium', {
  platform: process.platform,
  send(channel, ...args) {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('blocked channel'));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, callback) {
    if (!ON.has(channel)) return () => {};
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
