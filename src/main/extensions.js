'use strict';
/**
 * Расширения Vanium (.vex): установка, реестр, сопоставление со страницами, хранилище.
 * Расширения лежат в <userData>/extensions/<id>/ и пересобираются из файлов при каждом запуске.
 */
const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const S = require('./services');
const { JsonStore } = require('./store');
const zip = require('./zip');
const vm = require('./vex-manifest');
const { t } = require('../shared/i18n');

const MAX_VEX_SIZE = 25 * 1024 * 1024;
const MAX_ICON_SIZE = 256 * 1024;
const MAX_STORAGE_BYTES = 1024 * 1024;
const POPUP_EXT = new Set(['.html', '.htm', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.json', '.woff2', '.woff', '.ttf', '.ico']);

let registry = null; // JsonStore { items: { id: { enabled, world, installedAt } }, nextWorld }
const loaded = new Map(); // id -> { manifest, scripts, icon, error }
const dataStores = new Map();
let installing = false;

const extRoot = () => path.join(app.getPath('userData'), 'extensions');
const extDir = (id) => path.join(extRoot(), id);

function init() {
  registry = new JsonStore('extensions', { items: {}, nextWorld: 1000 });
  fs.mkdirSync(extRoot(), { recursive: true });
  for (const id of Object.keys(registry.data.items)) {
    if (!fs.existsSync(extDir(id))) {
      delete registry.data.items[id];
      registry.save();
      continue;
    }
    loadFromDisk(id);
  }
}

function readInside(dir, rel, maxSize) {
  const full = path.resolve(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('Недопустимый путь: ' + rel);
  const st = fs.statSync(full);
  if (st.size > maxSize) throw new Error('Файл слишком большой: ' + rel);
  return fs.readFileSync(full);
}

function iconDataUrl(dir, rel) {
  if (!rel) return '';
  try {
    const buf = readInside(dir, rel, MAX_ICON_SIZE);
    const ext = path.extname(rel).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (_) {
    return '';
  }
}

function loadFromDisk(id) {
  const dir = extDir(id);
  try {
    const manifest = vm.parseManifest(fs.readFileSync(path.join(dir, 'manifest.json')));
    if (manifest.id !== id) throw new Error('id в манифесте не совпадает с папкой');
    const scripts = vm.compile(manifest).map((c) => ({
      include: c.include,
      exclude: c.exclude,
      runAt: c.runAt,
      js: c.js.map((file) => ({ file, code: readInside(dir, file, 2 * 1024 * 1024).toString('utf8') })),
      css: c.css.map((file) => readInside(dir, file, 1024 * 1024).toString('utf8'))
    }));
    for (const f of vm.requiredFiles(manifest)) if (!fs.existsSync(path.join(dir, f))) throw new Error('Нет файла ' + f);
    loaded.set(id, { manifest, scripts, icon: iconDataUrl(dir, manifest.icon), error: null });
  } catch (e) {
    loaded.set(id, { manifest: null, scripts: [], icon: '', error: e.message });
  }
}

// ---------- запросы ----------
function list() {
  return Object.entries(registry.data.items).map(([id, rec]) => {
    const l = loaded.get(id) || {};
    const m = l.manifest;
    return {
      id,
      name: m ? m.name : id,
      version: m ? m.version : '',
      description: m ? m.description : '',
      enabled: !!rec.enabled,
      permissions: m ? m.permissions : [],
      hosts: m ? vm.hostsOf(m) : [],
      hasPopup: !!(m && m.action && m.action.popup),
      icon: l.icon || '',
      error: l.error || ''
    };
  });
}

/** Кнопки расширений для панели инструментов. */
function actions() {
  const out = [];
  for (const [id, rec] of Object.entries(registry.data.items)) {
    const l = loaded.get(id);
    if (!rec.enabled || !l || !l.manifest || !l.manifest.action || !l.manifest.action.popup) continue;
    out.push({ id, name: l.manifest.name, title: l.manifest.action.title, icon: l.icon });
  }
  return out;
}

function get(id) {
  const rec = registry.data.items[id];
  const l = loaded.get(id);
  return rec && l && l.manifest ? { rec, ...l } : null;
}

function has(id, perm) {
  const e = get(id);
  return !!(e && e.rec.enabled && e.manifest.permissions.includes(perm));
}

/** Что нужно выполнить на странице: список расширений со скриптами и стилями. */
function matchFor(url) {
  const out = [];
  for (const [id, rec] of Object.entries(registry.data.items)) {
    if (!rec.enabled) continue;
    const l = loaded.get(id);
    if (!l || !l.manifest) continue;
    const hit = [];
    for (const sc of l.scripts) {
      if (vm.matches([sc], url).length) hit.push({ runAt: sc.runAt, js: sc.js, css: sc.css });
    }
    if (hit.length) {
      out.push({
        id,
        name: l.manifest.name,
        version: l.manifest.version,
        world: rec.world,
        storage: l.manifest.permissions.includes('storage'),
        scripts: hit
      });
    }
  }
  return out;
}

/** Файл для popup-страницы (протокол vex://<id>/<путь>). */
function popupFile(id, rel) {
  const e = get(id);
  if (!e || !e.rec.enabled) return null;
  const dir = path.resolve(extDir(id));
  let p = rel.replace(/^\/+/, '');
  if (!p) p = e.manifest.action ? e.manifest.action.popup : '';
  const full = path.resolve(dir, p);
  if (!full.startsWith(dir + path.sep)) return null;
  if (!POPUP_EXT.has(path.extname(full).toLowerCase())) return null;
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch (_) {
    return null;
  }
}

function popupInfo(id) {
  const e = get(id);
  return e && e.rec.enabled && e.manifest.action && e.manifest.action.popup ? e.manifest.action : null;
}

// ---------- управление ----------
function changed() {
  registry.flush(); // установка/удаление должны пережить внезапное закрытие
  S.broadcastState();
  S.emitPages('extensions');
}

function setEnabled(id, enabled) {
  const rec = registry.data.items[id];
  if (!rec) return false;
  rec.enabled = !!enabled;
  changed();
  return true;
}

function remove(id) {
  if (!registry.data.items[id]) return false;
  delete registry.data.items[id];
  loaded.delete(id);
  const st = dataStores.get(id);
  if (st) {
    st.destroy();
    dataStores.delete(id);
  } else {
    try {
      fs.rmSync(path.join(app.getPath('userData'), 'extdata-' + id + '.json'), { force: true });
    } catch (_) {
      /* ignore */
    }
  }
  try {
    fs.rmSync(extDir(id), { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  changed();
  return true;
}

// ---------- установка ----------
function permissionLines(T, manifest) {
  const lines = [];
  if (manifest.contentScripts.length) {
    const hosts = vm.hostsOf(manifest);
    lines.push(hosts.includes('*') ? T('extAllSites') : T('extHosts', { hosts: hosts.slice(0, 8).join(', ') + (hosts.length > 8 ? '…' : '') }));
  }
  if (manifest.permissions.includes('storage')) lines.push(T('extPermStorage'));
  if (manifest.permissions.includes('tabs')) lines.push(T('extPermTabs'));
  if (manifest.action && manifest.action.popup) lines.push(T('extPopup'));
  return lines;
}

async function installFromFile(filePath, win) {
  if (installing) return false;
  installing = true;
  const T = (k, v) => t(S.lang(), k, v);
  const parent = win && !win.isDestroyed() ? win : undefined;
  try {
    const st = fs.statSync(filePath);
    if (st.size > MAX_VEX_SIZE) throw new Error(T('extTooBig'));
    const files = zip.readAll(fs.readFileSync(filePath));
    if (!files['manifest.json']) throw new Error(T('extNoManifest'));
    const manifest = vm.parseManifest(files['manifest.json']);
    for (const f of vm.requiredFiles(manifest)) if (!files[f]) throw new Error(T('extMissingFile', { file: f }));
    if (manifest.icon && files[manifest.icon].length > MAX_ICON_SIZE) throw new Error(T('extTooBig'));

    const existing = registry.data.items[manifest.id];
    const lines = permissionLines(T, manifest).map((l) => '• ' + l);
    const opts = {
      type: 'question',
      buttons: [existing ? T('extUpdateBtn') : T('extInstallBtn'), T('cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: T('extInstallTitle'),
      message: T(existing ? 'extUpdateMsg' : 'extInstallMsg', { name: manifest.name, version: manifest.version }),
      detail: [manifest.description, T('extWillAccess'), ...lines, '', T('extWarn')].filter((x, i) => x !== '' || i > 0).join('\n')
    };
    const r = await (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts));
    if (r.response !== 0) return false;

    const dest = extDir(manifest.id);
    const tmp = dest + '.tmp-' + Date.now();
    zip.extractTo(files, tmp);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);

    if (existing) {
      existing.installedAt = Date.now();
    } else {
      registry.data.items[manifest.id] = { enabled: true, world: registry.data.nextWorld++, installedAt: Date.now() };
    }
    loadFromDisk(manifest.id);
    changed();
    return true;
  } catch (e) {
    dialog.showErrorBox(T('extFailed'), e.message);
    return false;
  } finally {
    installing = false;
  }
}

async function installWithDialog(win) {
  const T = (k) => t(S.lang(), k);
  const opts = { title: T('extPickFile'), properties: ['openFile'], filters: [{ name: 'Vanium Extension', extensions: ['vex'] }] };
  const r = await (win && !win.isDestroyed() ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return false;
  return installFromFile(r.filePaths[0], win);
}

// ---------- хранилище расширения ----------
function dataStore(id) {
  let s = dataStores.get(id);
  if (!s) {
    s = new JsonStore('extdata-' + id, {});
    dataStores.set(id, s);
  }
  return s;
}

function jsonClone(v) {
  return JSON.parse(JSON.stringify(v === undefined ? null : v));
}

function storage(id, op, arg) {
  if (!has(id, 'storage')) throw new Error('Нет разрешения storage');
  const s = dataStore(id);
  switch (op) {
    case 'get': {
      if (arg === null || arg === undefined) return jsonClone(s.data);
      const keys = Array.isArray(arg) ? arg : [arg];
      const out = {};
      for (const k of keys) if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(s.data, k)) out[k] = s.data[k];
      return jsonClone(out);
    }
    case 'set': {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new Error('set: ожидается объект');
      const next = { ...s.data };
      for (const [k, v] of Object.entries(arg)) {
        if (k.length > 100) throw new Error('Слишком длинный ключ');
        next[k] = jsonClone(v);
      }
      if (JSON.stringify(next).length > MAX_STORAGE_BYTES) throw new Error('Превышен лимит хранилища (1 МБ)');
      s.data = next;
      s.save();
      return true;
    }
    case 'remove': {
      const keys = Array.isArray(arg) ? arg : [arg];
      for (const k of keys) delete s.data[k];
      s.save();
      return true;
    }
    case 'clear':
      s.data = {};
      s.save();
      return true;
    default:
      throw new Error('Неизвестная операция');
  }
}

module.exports = { init, list, actions, get, has, matchFor, popupFile, popupInfo, setEnabled, remove, installFromFile, installWithDialog, storage };
