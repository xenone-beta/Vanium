'use strict';
/**
 * Формат расширений Vanium (.vex) — это ZIP-архив с manifest.json в корне.
 * Этот модуль не зависит от Electron: разбор манифеста и сопоставление адресов.
 */
const { safeName } = require('./zip');

const PERMISSIONS = ['storage', 'tabs'];
const RUN_AT = ['document_start', 'document_end', 'document_idle'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const ICON_EXT = /\.(png|jpe?g|webp|svg)$/i;

const LIMITS = { scripts: 10, patterns: 20, files: 10, popupMin: 200, popupMax: 700 };

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Паттерн как в Chrome: <all_urls> или схема://хост/путь, где схема — *, http, https;
 * хост — *, *.example.com или example.com; путь может содержать *.
 */
function patternToRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 300) return null;
  if (pattern === '<all_urls>') return /^https?:\/\/[^/]+(\/.*)?$/i;
  const m = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return null;
  const scheme = m[1] === '*' ? 'https?' : m[1];
  let host;
  if (m[2] === '*') host = '[^/]+';
  else if (m[2].startsWith('*.')) host = '(?:[^/]+\\.)?' + escapeRe(m[2].slice(2));
  else host = escapeRe(m[2]);
  const path = m[3].split('*').map(escapeRe).join('.*');
  return new RegExp('^' + scheme + ':\\/\\/' + host + path + '$', 'i');
}

function urlTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.protocol + '//' + u.hostname + u.pathname + u.search;
}

function fail(msg) {
  throw new Error(msg);
}

function str(v, name, max, required) {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`manifest.json: поле «${name}» обязательно`);
    return '';
  }
  if (typeof v !== 'string' || v.length > max) fail(`manifest.json: поле «${name}» должно быть строкой до ${max} символов`);
  return v;
}

function filePath(v, name, extRe) {
  if (typeof v !== 'string' || !v) fail(`manifest.json: «${name}» — ожидается путь к файлу`);
  const n = safeName(v);
  if (!n || n.endsWith('/') || n.startsWith('./')) fail(`manifest.json: недопустимый путь «${v}»`);
  if (!extRe.test(n)) fail(`manifest.json: недопустимый тип файла «${v}»`);
  return n;
}

function list(v, name, max) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) fail(`manifest.json: «${name}» должен быть списком (до ${max} элементов)`);
  return v;
}

function parseManifest(raw) {
  let m = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try {
      m = JSON.parse(String(raw));
    } catch (e) {
      fail('manifest.json: некорректный JSON');
    }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest.json: ожидается объект');

  const id = str(m.id, 'id', 48, true);
  if (!ID_RE.test(id)) fail('manifest.json: «id» — строчные латинские буквы, цифры и дефис (2–48 символов)');
  const name = str(m.name, 'name', 60, true);
  const version = str(m.version, 'version', 20, true);
  if (!VERSION_RE.test(version)) fail('manifest.json: «version» — например 1.0.0');
  const description = str(m.description, 'description', 300, false);

  const permissions = [];
  for (const p of list(m.permissions, 'permissions', 10)) {
    if (!PERMISSIONS.includes(p)) fail(`manifest.json: неизвестное разрешение «${p}» (доступны: ${PERMISSIONS.join(', ')})`);
    if (!permissions.includes(p)) permissions.push(p);
  }

  const contentScripts = [];
  for (const cs of list(m.content_scripts, 'content_scripts', LIMITS.scripts)) {
    if (!cs || typeof cs !== 'object') fail('manifest.json: элемент content_scripts должен быть объектом');
    const matches = list(cs.matches, 'matches', LIMITS.patterns);
    if (!matches.length) fail('manifest.json: у content_scripts нужен непустой «matches»');
    const excludes = list(cs.exclude_matches, 'exclude_matches', LIMITS.patterns);
    for (const p of [...matches, ...excludes]) if (!patternToRegex(p)) fail(`manifest.json: некорректный шаблон адреса «${p}»`);
    const js = list(cs.js, 'js', LIMITS.files).map((f) => filePath(f, 'js', /\.js$/i));
    const css = list(cs.css, 'css', LIMITS.files).map((f) => filePath(f, 'css', /\.css$/i));
    if (!js.length && !css.length) fail('manifest.json: у content_scripts нужен хотя бы один js или css файл');
    const runAt = cs.run_at === undefined ? 'document_idle' : cs.run_at;
    if (!RUN_AT.includes(runAt)) fail(`manifest.json: run_at должен быть одним из ${RUN_AT.join(', ')}`);
    contentScripts.push({ matches, excludes, js, css, runAt });
  }

  let action = null;
  if (m.action !== undefined) {
    const a = m.action;
    if (!a || typeof a !== 'object') fail('manifest.json: «action» должен быть объектом');
    action = {
      title: str(a.title, 'action.title', 60, false) || name,
      popup: a.popup === undefined ? '' : filePath(a.popup, 'action.popup', /\.html?$/i),
      width: clampInt(a.popup_width, 360),
      height: clampInt(a.popup_height, 480)
    };
  }

  const icon = m.icon === undefined ? '' : filePath(m.icon, 'icon', ICON_EXT);

  if (!contentScripts.length && !(action && action.popup)) fail('manifest.json: расширение ничего не делает: добавьте content_scripts или action.popup');

  return { id, name, version, description, permissions, contentScripts, action, icon };
}

function clampInt(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(LIMITS.popupMin, Math.min(LIMITS.popupMax, Math.round(n)));
}

/** Список файлов, которые манифест требует иметь в архиве. */
function requiredFiles(manifest) {
  const files = new Set();
  for (const cs of manifest.contentScripts) [...cs.js, ...cs.css].forEach((f) => files.add(f));
  if (manifest.action && manifest.action.popup) files.add(manifest.action.popup);
  if (manifest.icon) files.add(manifest.icon);
  return [...files];
}

/** Человекочитаемый список сайтов, на которые влияет расширение. */
function hostsOf(manifest) {
  const set = new Set();
  for (const cs of manifest.contentScripts) cs.matches.forEach((p) => set.add(p === '<all_urls>' ? '*' : p.replace(/^(\*|https?):\/\//, '').replace(/\/.*$/, '')));
  return [...set];
}

/** Компилирует content_scripts в регулярные выражения для быстрого сопоставления. */
function compile(manifest) {
  return manifest.contentScripts.map((cs) => ({
    include: cs.matches.map(patternToRegex),
    exclude: cs.excludes.map(patternToRegex),
    runAt: cs.runAt,
    js: cs.js,
    css: cs.css
  }));
}

function matches(compiled, url) {
  const t = urlTarget(url);
  if (!t) return [];
  return compiled.filter((c) => c.include.some((re) => re.test(t)) && !c.exclude.some((re) => re.test(t)));
}

module.exports = { parseManifest, patternToRegex, urlTarget, requiredFiles, hostsOf, compile, matches, PERMISSIONS, LIMITS };
