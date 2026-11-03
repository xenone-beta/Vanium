'use strict';
const path = require('path');
const fs = require('fs');
const { net, protocol } = require('electron');
const { pathToFileURL } = require('url');

const PAGES_DIR = path.join(__dirname, '..', 'pages');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

/** Адреса vanium://<имя>/ — внутренние страницы браузера. */
const PAGES = new Set(['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'error']);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: http: https:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'vanium', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ]);
}

function resolveFile(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (!PAGES.has(u.hostname)) return null;
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') return path.join(PAGES_DIR, 'index.html');
  rel = path.normalize(rel).replace(/^([/\\])+/, '');
  for (const dir of [PAGES_DIR, SHARED_DIR, ASSETS_DIR]) {
    const full = path.join(dir, rel);
    if (full.startsWith(dir + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

async function handler(request) {
  const file = resolveFile(request.url);
  if (!file) return new Response('Not found', { status: 404 });
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

/** Регистрирует обработчик vanium:// для конкретной сессии. */
function attach(ses) {
  ses.protocol.handle('vanium', handler);
}

module.exports = { registerScheme, attach, PAGES };
