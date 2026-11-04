'use strict';
// Preload для popup-окна расширения (vex://<id>/…). Даёт API vex.* без доступа к Node.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'vex:') {
  const id = location.hostname;
  const storage = (op) => (arg) => ipcRenderer.invoke('vex:storage', id, op, arg);

  contextBridge.exposeInMainWorld('vex', {
    id,
    storage: { get: storage('get'), set: storage('set'), remove: storage('remove'), clear: storage('clear') },
    tabs: {
      getActive: () => ipcRenderer.invoke('vex:tabs', 'active'),
      open: (url) => ipcRenderer.invoke('vex:tabs', 'open', url),
      sendMessage: (message) => ipcRenderer.invoke('vex:tabs', 'message', message)
    },
    close: () => ipcRenderer.send('vex:popup-close')
  });

  // Закрываем popup при потере фокуса и по Esc
  window.addEventListener('blur', () => {
    setTimeout(() => {
      if (!document.hasFocus()) ipcRenderer.send('vex:popup-close');
    }, 120);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipcRenderer.send('vex:popup-close');
  });
}
