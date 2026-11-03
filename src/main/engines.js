'use strict';

const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  yandex: { name: 'Яндекс', url: 'https://yandex.ru/search/?text=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' }
};

function engineFor(key) {
  return ENGINES[key] || ENGINES.google;
}

const NEWTAB = 'vanium://newtab/';

/**
 * Превращает введённый в адресную строку текст в URL:
 * адрес сайта → https://…, localhost/IP → http://…, всё остальное → поиск.
 */
function resolveInput(text, engineKey) {
  const t = String(text || '').trim();
  if (!t) return NEWTAB;

  if (/^vanium:\/\//i.test(t)) return t;
  if (/^(https?|file):\/\//i.test(t)) return t;
  if (/^view-source:https?:\/\//i.test(t)) return t;
  if (/^about:blank$/i.test(t)) return t;

  if (!/\s/.test(t)) {
    const local = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i;
    if (local.test(t)) return 'http://' + t;
    // домен с точкой и буквенной зоной: example.com, кошка.рф, sub.site.io/path?x=1
    const domain = /^[^\s/?#:.]+(?:\.[^\s/?#:.]+)*\.[^\s/?#:.\d]{2,}(:\d+)?([/?#]\S*)?$/;
    if (domain.test(t)) return 'https://' + t;
  }

  return searchUrl(t, engineKey);
}

/** Всегда поиск, даже если текст похож на адрес. */
function searchUrl(text, engineKey) {
  return engineFor(engineKey).url.replace('%s', encodeURIComponent(String(text).trim()));
}

module.exports = { ENGINES, engineFor, resolveInput, searchUrl, NEWTAB };
