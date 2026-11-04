'use strict';
// Быстрая проверка: синтаксис всех .js и наличие нужных файлов.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const required = [
  'src/main/main.js', 'src/preload/ui.js', 'src/preload/page.js',
  'src/renderer/index.html', 'src/renderer/overlay.html', 'src/pages/index.html',
  'src/assets/logo.svg', 'build/icon.png', 'build/icon.ico', 'build/installer.nsh',
  'src/main/extensions.js', 'src/main/updater.js', 'src/main/webrequest.js', 'src/preload/vex-popup.js',
  'src/renderer/select.html', 'docs/EXTENSIONS.md'
];
let bad = 0;
for (const f of required) if (!fs.existsSync(path.join(root, f))) { console.error('missing:', f); bad++; }

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
      catch (err) { console.error('syntax error in', p, '\n' + err.stderr); bad++; }
    }
  }
})(path.join(root, 'src'));

if (bad) process.exit(1);
console.log('OK');
