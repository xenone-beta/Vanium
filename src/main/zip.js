'use strict';
/**
 * Минимальные чтение и запись ZIP без зависимостей (Node zlib).
 * Поддерживаются методы store/deflate, без шифрования и ZIP64.
 * Чтение защищено от zip-bomb и выхода за пределы папки (zip-slip).
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const LIMITS = { entries: 2000, file: 20 * 1024 * 1024, total: 60 * 1024 * 1024 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Нормализует имя записи; возвращает null для опасных/служебных путей. */
function safeName(raw) {
  let name = String(raw).replace(/\\/g, '/');
  if (name.includes('\0')) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/');
  for (const p of parts) if (p === '..') return null;
  if (parts[0] === '__MACOSX') return '';
  return name;
}

function listEntries(buf) {
  if (buf.length < 22) throw new Error('Файл не является ZIP-архивом');
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Файл не является ZIP-архивом');

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 не поддерживается');
  if (total > LIMITS.entries) throw new Error('Слишком много файлов в архиве');

  const entries = [];
  let p = cdOffset;
  let sum = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждённый архив');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;

    const name = safeName(rawName);
    if (name === null) throw new Error('Небезопасный путь в архиве: ' + rawName);
    if (name === '') continue;
    const isDir = name.endsWith('/');
    const mode = (attr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new Error('Символические ссылки в архиве запрещены');
    if (!isDir) {
      if (usize > LIMITS.file) throw new Error('Файл слишком большой: ' + name);
      sum += usize;
      if (sum > LIMITS.total) throw new Error('Архив слишком большой после распаковки');
    }
    entries.push({ name, isDir, flags, method, crc, csize, usize, lho });
  }
  return entries;
}

function readEntry(buf, e) {
  if (e.flags & 1) throw new Error('Зашифрованные архивы не поддерживаются');
  const p = e.lho;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error('Повреждённый архив');
  const nlen = buf.readUInt16LE(p + 26);
  const elen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nlen + elen;
  const data = buf.subarray(start, start + e.csize);
  let out;
  if (e.method === 0) out = Buffer.from(data);
  else if (e.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: LIMITS.file + 1 });
  else throw new Error('Неподдерживаемый метод сжатия: ' + e.method);
  if (out.length !== e.usize) throw new Error('Размер файла не совпадает: ' + e.name);
  if (crc32(out) !== e.crc) throw new Error('Контрольная сумма не совпадает: ' + e.name);
  return out;
}

/** Возвращает { имя: Buffer } для файлов; директории пропускаются. */
function readAll(buf) {
  const files = {};
  for (const e of listEntries(buf)) {
    if (!e.isDir) files[e.name] = readEntry(buf, e);
  }
  return files;
}

/** Распаковывает файлы в папку (она должна быть пустой/новой). */
function extractTo(files, destDir) {
  const root = path.resolve(destDir);
  for (const [name, data] of Object.entries(files)) {
    const full = path.resolve(root, name);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Небезопасный путь: ' + name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
}

/** Собирает ZIP из [{ name, data:Buffer }]. */
function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const deflated = zlib.deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12); // 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0o100644 << 16 >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { listEntries, readEntry, readAll, extractTo, writeZip, safeName, crc32, LIMITS };
