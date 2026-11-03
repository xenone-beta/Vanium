'use strict';

/**
 * Лёгкий блокировщик рекламы и трекеров по встроенному списку доменов.
 * Блокируются только вложенные ресурсы (скрипты, картинки, фреймы, XHR…) —
 * переход на сам сайт (mainFrame) никогда не блокируется.
 */

const DOMAINS = `
doubleclick.net googlesyndication.com googleadservices.com googletagservices.com
2mdn.net adservice.google.com pagead2.googlesyndication.com tpc.googlesyndication.com
adnxs.com adsrvr.org advertising.com adform.net adform.com criteo.com criteo.net
taboola.com outbrain.com zemanta.com scorecardresearch.com quantserve.com quantcount.com
moatads.com moatpixel.com rubiconproject.com pubmatic.com openx.net openx.com casalemedia.com
amazon-adsystem.com media.net yieldmo.com smartadserver.com adcolony.com applovin.com
mopub.com inmobi.com chartboost.com tapjoy.com vungle.com ironsrc.com supersonicads.com
bidswitch.net sharethrough.com teads.tv 33across.com lijit.com sovrn.com indexww.com
contextweb.com adroll.com bluekai.com krxd.net demdex.net everesttech.net serving-sys.com
adtechus.com turn.com mathtag.com bidr.io rlcdn.com tapad.com liadm.com id5-sync.com agkn.com
bat.bing.com clarity.ms hotjar.com hotjar.io mouseflow.com crazyegg.com luckyorange.com
chartbeat.com chartbeat.net parsely.com google-analytics.com analytics.google.com
ssl.google-analytics.com addthis.com adsafeprotected.com doubleverify.com iasds01.com
eyeota.net exelator.com lotame.com crwdcntrl.net bounceexchange.com bouncex.net
smartclip.net adblade.com revcontent.com zedo.com adition.com adscale.de smaato.net
inner-active.mobi flurry.com yieldlab.net disqusads.com
popads.net popcash.net propellerads.com exoclick.com exosrv.com trafficjunky.net juicyads.com
adsterra.com hilltopads.net clickadu.com onclickads.net adcash.com
ads-twitter.com static.ads-twitter.com ads.linkedin.com px.ads.linkedin.com snap.licdn.com
analytics.tiktok.com ads.tiktok.com ads.youtube.com
mc.yandex.ru mc.yandex.com an.yandex.ru yandexadexchange.net awaps.yandex.net adfox.ru
adriver.ru begun.ru counter.yadro.ru top-fwz1.mail.ru top.mail.ru ad.mail.ru rb.mail.ru
tns-counter.ru relap.io 24smi.net marketgid.com mgid.com adskeeper.com
`
  .split(/\s+/)
  .filter(Boolean);

const BLOCKED = new Set(DOMAINS);

const PATH_PATTERNS = [/\/pagead\/(?:js|ads|id|conversion|viewthroughconversion)/i, /\/adsbygoogle\.js/i];
const HOST_PATTERNS = [/^adservice\.google\./i];

const FILTER = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };

function hostBlocked(host) {
  host = host.toLowerCase();
  if (HOST_PATTERNS.some((re) => re.test(host))) return true;
  let h = host;
  for (;;) {
    if (BLOCKED.has(h)) return true;
    const i = h.indexOf('.');
    if (i < 0) return false;
    h = h.slice(i + 1);
  }
}

function shouldBlock(rawUrl, resourceType) {
  if (resourceType === 'mainFrame') return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return false;
  }
  if (hostBlocked(u.hostname)) return true;
  return PATH_PATTERNS.some((re) => re.test(u.pathname));
}

/**
 * @param ses       electron Session
 * @param isEnabled () => boolean
 * @param onBlocked (webContentsId:number) => void
 */
function attach(ses, isEnabled, onBlocked) {
  ses.webRequest.onBeforeRequest(FILTER, (details, callback) => {
    if (isEnabled() && shouldBlock(details.url, details.resourceType)) {
      try {
        onBlocked(details.webContentsId);
      } catch (_) {
        /* счётчик не должен ломать блокировку */
      }
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

module.exports = { attach, shouldBlock, hostBlocked, DOMAIN_COUNT: BLOCKED.size };
