'use strict';
/**
 * Автообновление через GitHub Releases (electron-updater).
 * Работает только в установленной (NSIS) сборке: у portable-версии и при запуске из исходников
 * обновлений нет, интерфейс показывает соответствующее сообщение.
 */
const { app, dialog } = require('electron');
const S = require('./services');
const { t } = require('../shared/i18n');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

const state = { status: 'idle', version: '', progress: 0, error: '' };
let promptedVersion = '';

function supported() {
  return !!autoUpdater && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && process.platform === 'win32';
}

function set(patch) {
  Object.assign(state, patch);
  S.emitPages('update');
}

function shortError(e) {
  return String((e && e.message) || e || 'unknown').split('\n')[0].slice(0, 200);
}

function getState() {
  return { ...state, supported: supported(), current: app.getVersion() };
}

async function promptRestart(version) {
  if (promptedVersion === version) return;
  promptedVersion = version;
  const lang = S.lang();
  const ctx = S.firstWindow();
  const opts = {
    type: 'info',
    buttons: [t(lang, 'upNow'), t(lang, 'upLater')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: t(lang, 'upDialogTitle'),
    message: t(lang, 'upDialogText', { v: version })
  };
  const win = ctx && !ctx.win.isDestroyed() ? ctx.win : null;
  const r = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  if (r.response === 0) installNow();
}

function installNow() {
  if (supported() && state.status === 'ready') autoUpdater.quitAndInstall(false, true);
}

async function check() {
  if (!supported()) return getState();
  if (state.status === 'checking' || state.status === 'downloading') return getState();
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', error: shortError(e) });
  }
  return getState();
}

function init() {
  if (!supported()) {
    state.status = 'unsupported';
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version, progress: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version, progress: 100 });
    promptRestart(info.version).catch(() => {});
  });
  autoUpdater.on('error', (e) => set({ status: 'error', error: shortError(e) }));

  const auto = () => {
    if (S.settings.data.autoUpdate && state.status !== 'ready' && state.status !== 'downloading') check();
  };
  setTimeout(auto, 15000);
  setInterval(auto, 6 * 60 * 60 * 1000);
}

module.exports = { init, check, getState, installNow };
