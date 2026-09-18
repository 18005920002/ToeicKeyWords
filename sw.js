/* Service Worker：让应用能「安装到手机」并离线使用。
 * 分工：
 *   - 应用壳（html / css / js / 图标 / 清单，合计不到 1MB）在 install 时全量预缓存
 *   - audio/ 下 4800 个 mp3 共约 106MB，绝不做预缓存（会把安装卡死），改成首次播放时顺手落盘：
 *     cache-first，听过的词永久离线可用；想一次全离线见 js/pwa.js 的「全部缓存到本地」
 *   - 改了 js/data.js 或 audio-manifest.js 后，把下面的 CACHE_VERSION 递增再部署，
 *     否则旧缓存会一直命中（应用壳走 stale-while-revalidate，最多让用户多开一次）
 * 只处理同源 GET，跨域请求（如 CDN 字体）一律放行不拦。
 */
'use strict';

var CACHE_VERSION = 'toeic-v4';
var SHELL_CACHE = CACHE_VERSION + '-shell';
/* 音频缓存故意不带版本号：mp3 文件名里含词条 hash，同名的内容不会变，
 * 而升版会删掉旧名字的缓存 —— 把 105MB 发音一并清掉、让用户重下一遍是无妄之灾 */
var AUDIO_CACHE = 'toeic-audio';
/* 音频缓存条数上限：略高于当前 4800 个文件，超了按最旧的丢，避免无限膨胀 */
var MAX_AUDIO_ENTRIES = 5200;
var TRIP_EVERY = 200;

var SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/data.js',
  './js/tts-text.js',
  './js/audio-manifest.js',
  './js/storage.js',
  './js/tts.js',
  './js/app.js',
  './js/pwa.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* 部署在子路径（如 GitHub Pages 的 /toeic/）时，音频前缀要跟着 SW 自己的位置走 */
var AUDIO_PREFIX = new URL('audio/', self.location).pathname;
var SW_PATH = new URL('sw.js', self.location).pathname;
var puts = 0;

self.addEventListener('install', function (evt) {
  var isUpdate = !!self.registration.active;
  /* 用 allSettled 而不是 addAll：少一个图标之类的不该让整个安装失败 */
  evt.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.allSettled(SHELL_URLS.map(function (url) { return cache.add(url); }));
    }).then(function () {
      /* 首次安装：立即接管，本次会话就能离线；
       * 已在使用中的更新：停在 waiting，等用户点顶部「↻ 更新」，免得正背到一半的词被刷新打断 */
      if (!isUpdate) return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (evt) {
  evt.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('toeic-') === 0 && k !== SHELL_CACHE && k !== AUDIO_CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return caches.open(SHELL_CACHE); })
      /* 顺手清掉壳缓存里历史遗留的带 query 条目（旧版本写进去的探测 URL 等） */
      .then(function (cache) {
        return cache.keys().then(function (reqs) {
          return Promise.all(reqs.filter(function (r) { return r.url.indexOf('?') >= 0; })
            .map(function (r) { return cache.delete(r); }));
        });
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* 只把 mp3 当音频缓存：audio/ 下还躺着生成产物 jobs.json，不该混进来弄脏体积统计 */
function isAudio(url) { return url.pathname.indexOf(AUDIO_PREFIX) === 0 && /\.mp3$/i.test(url.pathname); }

/* 超上限时按 keys() 的前段丢：Chrome 的 Cache 按写入顺序返回，够用的近似 LRU */
function trimAudio(cache) {
  return cache.keys().then(function (reqs) {
    var excess = reqs.length - MAX_AUDIO_ENTRIES;
    if (excess <= 0) return;
    return Promise.all(reqs.slice(0, excess).map(function (r) { return cache.delete(r); }));
  });
}

/* 媒体请求常带 Range：透传会把 206 分片存进缓存，下次断网就只剩半截文件。
 * 所以命中失败时统一发一次不带 Range 的 GET 取整份，再把完整响应回给播放器
 * （对 Range 请求返回 200 是合法的，浏览器会从头播）。 */
function audioFirst(req) {
  return caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.match(req.url).then(function (hit) {
      if (hit) return hit;
      return fetch(req.url).then(function (res) {
        if (res && res.ok && res.status === 200) {
          cache.put(req.url, res.clone());
          if (++puts % TRIP_EVERY === 0) trimAudio(cache);
        }
        return res;
      });
    });
  });
}

/* 应用壳：先给缓存里的旧版，同时后台拉新的，下次打开就是新版。
 * 带 query 的 URL（探测、临时参数）只回源不入缓存，免得壳缓存里堆垃圾条目 */
function shellSwr(req) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.ok && req.url.indexOf('?') < 0) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || fresh;
    });
  });
}

/* 断网时点书签 / 从历史恢复：回落到已缓存的首页 */
function navigate(req) {
  return fetch(req).catch(function () {
    return caches.match('./index.html').then(function (hit) { return hit || Response.error(); });
  });
}

self.addEventListener('fetch', function (evt) {
  var req = evt.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  /* SW 自己的脚本不拦也不存，更新比对交给浏览器本身去做 */
  if (url.pathname === SW_PATH) return;

  if (isAudio(url)) { evt.respondWith(audioFirst(req)); return; }
  if (req.mode === 'navigate') { evt.respondWith(navigate(req)); return; }
  evt.respondWith(shellSwr(req));
});

/* js/pwa.js 通过 MessageChannel 问离线状态 / 清缓存，避免把版本号硬编码在两处 */
self.addEventListener('message', function (evt) {
  var data = evt.data || {};
  var port = (evt.ports && evt.ports[0]) || null;

  /* 包在 waitUntil 里：waiting 状态的 worker 处理完消息就可能被回收，
   * 不阻塞住的话 skipWaiting() 会被丢弃，用户得点两次「更新」才生效 */
  if (data.type === 'skip-waiting') { evt.waitUntil(self.skipWaiting()); return; }

  if (data.type === 'clear-audio') {
    evt.waitUntil(caches.delete(AUDIO_CACHE).then(function () { return caches.open(AUDIO_CACHE); })
      .then(function () { if (port) port.postMessage({ ok: true, count: 0, bytes: 0 }); }));
    return;
  }

  if (data.type !== 'audio-stats' || !port) return;

  caches.open(AUDIO_CACHE).then(function (cache) {
    return cache.keys().then(function (reqs) {
      /* content-length 求和：静态托管基本都会带这个头，缺了就只报条数 */
      return Promise.all(reqs.map(function (r) { return cache.match(r); })).then(function (resList) {
        var bytes = 0;
        resList.forEach(function (res) {
          var n = res && res.headers ? Number(res.headers.get('content-length')) : 0;
          if (n > 0) bytes += n;
        });
        port.postMessage({ ok: true, count: reqs.length, bytes: bytes });
      });
    });
  }).catch(function (err) { port.postMessage({ ok: false, error: String(err) }); });
});
