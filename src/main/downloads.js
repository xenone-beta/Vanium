'use strict';
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const { JsonStore } = require('./store');
const S = require('./services');

function uniquePath(dir, filename) {
  const safe = String(filename || 'download').replace(/[\\/:*?"<>|]+/g, '_') || 'download';
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let candidate = path.join(dir, safe);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n++})${ext}`);
  }
  return candidate;
}

class DownloadManager {
  constructor() {
    this.store = new JsonStore('downloads', []);
    // всё, что не успело завершиться в прошлый раз, считаем прерванным
    this.list = this.store.data.map((d) => (d.state === 'progressing' || d.state === 'paused' ? { ...d, state: 'interrupted' } : d));
    this.items = new Map(); // id -> DownloadItem
    this._timer = null;
  }

  attach(ses, isPrivate) {
    ses.on('will-download', (_event, item) => {
      const rec = {
        id: S.id(),
        name: item.getFilename(),
        url: item.getURL(),
        path: '',
        total: item.getTotalBytes(),
        received: 0,
        state: 'progressing',
        time: Date.now(),
        private: !!isPrivate
      };

      if (!S.settings.data.askDownload) {
        const target = uniquePath(app.getPath('downloads'), item.getFilename());
        item.setSavePath(target);
        rec.path = target;
        rec.name = path.basename(target);
      }

      this.list.unshift(rec);
      this.items.set(rec.id, item);
      this._touch();

      item.on('updated', (_e, state) => {
        rec.received = item.getReceivedBytes();
        rec.total = item.getTotalBytes();
        rec.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
        const p = item.getSavePath();
        if (p) {
          rec.path = p;
          rec.name = path.basename(p);
        }
        this._touch();
      });

      item.once('done', (_e, state) => {
        rec.state = state; // completed | cancelled | interrupted
        rec.received = state === 'completed' ? item.getTotalBytes() || item.getReceivedBytes() : item.getReceivedBytes();
        rec.total = item.getTotalBytes();
        const p = item.getSavePath();
        if (p) {
          rec.path = p;
          rec.name = path.basename(p);
        }
        this.items.delete(rec.id);
        this._persist();
        this._touch(true);
      });
    });
  }

  /** Список для окна: обычные окна не видят загрузки из приватных. */
  listFor(isPrivate) {
    return this.list.filter((d) => isPrivate || !d.private).map((d) => ({ ...d }));
  }

  summary(isPrivate) {
    let active = 0;
    let received = 0;
    let total = 0;
    for (const d of this.list) {
      if (d.private && !isPrivate) continue;
      if (d.state === 'progressing' || d.state === 'paused') {
        active++;
        received += d.received || 0;
        total += d.total || 0;
      }
    }
    return { active, progress: total > 0 ? Math.min(1, received / total) : 0 };
  }

  action(id, action) {
    const rec = this.list.find((d) => d.id === id);
    if (!rec) return false;
    switch (action) {
      case 'cancel': {
        const item = this.items.get(id);
        if (item) item.cancel();
        return true;
      }
      case 'open':
        if (rec.path && fs.existsSync(rec.path)) shell.openPath(rec.path);
        return true;
      case 'show':
        if (rec.path && fs.existsSync(rec.path)) shell.showItemInFolder(rec.path);
        else if (rec.path) shell.openPath(path.dirname(rec.path));
        return true;
      case 'remove': {
        if (this.items.has(id)) return false;
        this.list = this.list.filter((d) => d.id !== id);
        this._persist();
        this._touch(true);
        return true;
      }
      default:
        return false;
    }
  }

  clear() {
    this.list = this.list.filter((d) => this.items.has(d.id));
    this._persist();
    this._touch(true);
  }

  fileExists(rec) {
    return !!rec.path && fs.existsSync(rec.path);
  }

  _persist() {
    this.store.data = this.list.filter((d) => !d.private).slice(0, 500);
    this.store.save();
  }

  _touch(now) {
    if (now) {
      clearTimeout(this._timer);
      this._timer = null;
      this._emit();
      return;
    }
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._emit();
    }, 200);
  }

  _emit() {
    S.broadcastState();
    S.emitPages('downloads');
  }
}

module.exports = { DownloadManager };
