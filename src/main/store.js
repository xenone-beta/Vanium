'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const registry = new Set();

/** Небольшое JSON-хранилище с отложенной атомарной записью. */
class JsonStore {
  constructor(name, defaults) {
    this.file = path.join(app.getPath('userData'), name + '.json');
    this.defaults = defaults;
    this.data = clone(defaults);
    this._timer = null;
    this._load();
    registry.add(this);
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(this.defaults)) {
        if (Array.isArray(raw)) this.data = raw;
      } else if (raw && typeof raw === 'object') {
        this.data = Object.assign(clone(this.defaults), raw);
      }
    } catch (_) {
      /* файла нет или он повреждён — используем значения по умолчанию */
    }
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] write failed', this.file, e.message);
    }
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function flushAll() {
  for (const s of registry) s.flush();
}

module.exports = { JsonStore, flushAll };
