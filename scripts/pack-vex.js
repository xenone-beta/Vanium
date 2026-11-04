'use strict';
// Упаковывает папку расширения в .vex:  node scripts/pack-vex.js examples/dark-pages [out.vex]
const fs = require('fs');
const path = require('path');
const { writeZip } = require('../src/main/zip');
const { parseManifest, requiredFiles } = require('../src/main/vex-manifest');

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) {
  console.error('Использование: node scripts/pack-vex.js <папка с manifest.json> [выходной.vex]');
  process.exit(1);
}

const files = [];
(function walk(d, prefix) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full, prefix + e.name + '/');
    else if (!e.name.endsWith('.vex')) files.push({ name: prefix + e.name, data: fs.readFileSync(full) });
  }
})(dir, '');

let manifest;
try {
  manifest = parseManifest(fs.readFileSync(path.join(dir, 'manifest.json')));
  const names = new Set(files.map((f) => f.name));
  for (const f of requiredFiles(manifest)) if (!names.has(f)) throw new Error('В папке нет файла ' + f + ', указанного в манифесте');
} catch (e) {
  console.error('Ошибка манифеста:', e.message);
  process.exit(1);
}

const out = process.argv[3] || path.join(path.dirname(path.resolve(dir)), manifest.id + '.vex');
fs.writeFileSync(out, writeZip(files));
console.log(`Готово: ${out} (${files.length} файлов, ${manifest.name} ${manifest.version})`);
