/* PWA 装配：Service Worker 注册、桌面安装、版本更新、离线音频批量缓存。
 * 依赖 index.html 里的 #installBtn / #updateBtn 与发音面板里的 #offline* 元素。
 * 用 file:// 或局域网 http 打开时（非安全上下文）整块静默降级：不注册 SW、不显示安装入口，
 * 其余功能照旧，只在发音面板里说明原因。
 */
window.Pwa = (function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  /* 并发下载数：太小喂不满带宽，太大手机浏览器会掐连接 */
  var CONCURRENCY = 6;
  var audioTotal = 0;
  var deferredPrompt = null;
  var updateWorker = null;
  var hadController = false;
  var reloaded = false;
  var running = false;
  var cancelFlag = false;

  /* ---------- 提示条：与 app.js 的 toast 用同一个元素，实现各留一份以免互相依赖 ---------- */
  var flashTimer = null;
  function flash(msg) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* 只缓存了几条时显示成「0.0 MB」会让人以为没存上，小体积走 KB 一档 */
  function humanSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* ---------- 与 sw.js 通信 ---------- */
  function askSw(type, cb) {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) { cb(null); return; }
    var ch = new MessageChannel();
    ch.port1.onmessage = function (evt) { cb(evt.data || null); };
    try { navigator.serviceWorker.controller.postMessage({ type: type }, [ch.port2]); }
    catch (e) { cb(null); }
  }

  /* ---------- 音频文件清单：manifest 形状 { "<单元>::<词>": { us:{w,e}, gb:{w,e} } } ---------- */
  function audioFiles() {
    var m = window.AUDIO_MANIFEST || {};
    var seen = {}, out = [];
    Object.keys(m).forEach(function (key) {
      var accs = m[key] || {};
      Object.keys(accs).forEach(function (acc) {
        var f = accs[acc] || {};
        [f.w, f.e].forEach(function (name) {
          if (name && !seen[name]) { seen[name] = 1; out.push(name); }
        });
      });
    });
    return out;
  }

  /* ---------- 离线音频面板 ---------- */
  function renderStat(stat) {
    var el = $('#offlineStat');
    if (!el) return;
    if (!audioTotal) { el.textContent = '当前词库没有预生成音频'; return; }
    if (!stat || !stat.ok) { el.textContent = '离线音频：统计中…'; return; }
    var size = stat.bytes ? ' · ' + humanSize(stat.bytes) : '';
    var full = stat.count >= audioTotal;
    el.textContent = '已缓存 ' + stat.count + ' / ' + audioTotal + ' 条' + size + (full ? '（已全离线）' : '');
  }

  function refreshStat() {
    askSw('audio-stats', function (stat) {
      if (!stat || !stat.ok) { renderStat(null); return; }
      renderStat({ ok: true, count: Math.min(stat.count, audioTotal), bytes: stat.bytes });
    });
  }

  function setBusy(on) {
    running = on;
    var btn = $('#offlineBtn'), cancel = $('#offlineCancel');
    if (btn) { btn.disabled = on; btn.textContent = on ? '缓存中…' : '全部缓存到本地'; }
    if (cancel) cancel.classList.toggle('hidden', !on);
  }

  /* 已缓存的文件会被 SW 直接命中，重复 fetch 几乎不耗流量，所以不必先算差集。
   * 并发靠「初始开 CONCURRENCY 个泵 + 每完成一个再推一个」维持；
   * 取消只置标记、不复位，等在途请求跑完再收尾 —— 否则多条泵会互相覆盖状态。 */
  function cacheAll(files) {
    var idx = 0, done = 0, failed = 0, inFlight = 0, start = Date.now();
    cancelFlag = false;
    setBusy(true);

    function finish(msg) {
      var note = $('#offlineNote');
      setBusy(false);
      if (note) note.textContent = msg;
      refreshStat();
    }

    function report() {
      if (done % 25 !== 0 && done !== files.length) return;
      var btn = $('#offlineBtn'), note = $('#offlineNote');
      if (btn && running) btn.textContent = '缓存中 ' + Math.floor(done * 100 / files.length) + '%';
      if (note) note.textContent = '正在缓存 ' + done + ' / ' + files.length + ' 条…（可点「取消」中断）';
    }

    function pump() {
      if (cancelFlag) {
        if (!inFlight) finish('已取消：本次处理了 ' + done + ' 条，听过的词依然离线可用。');
        return;
      }
      if (idx >= files.length) {
        if (!inFlight) {
          var secs = Math.round((Date.now() - start) / 1000);
          finish('完成，用时 ' + secs + ' 秒。'
            + (failed ? '有 ' + failed + ' 条没取到（多为该口音尚未生成）。' : '现在断网也能听全部发音了。'));
        }
        return;
      }
      var name = files[idx++];
      inFlight++;
      fetch('audio/' + name, { cache: 'default' })
        .then(function (res) { if (!res.ok) failed++; })
        .catch(function () { failed++; })
        .then(function () {
          inFlight--; done++;
          report();
          pump();
        });
    }

    var lanes = Math.min(CONCURRENCY, files.length);
    for (var k = 0; k < lanes; k++) pump();
  }

  function bindOffline() {
    var btn = $('#offlineBtn'), cancel = $('#offlineCancel'), clear = $('#offlineClear'), open = $('#ttsBtn');
    /* 面板每次打开都重算一次：缓存是在 SW 里悄悄长的，不重查就一直是进页时那个旧数字 */
    if (open) open.addEventListener('click', function () { setTimeout(refreshStat, 0); });
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        flash('还没连上离线组件，请重新打开页面'); return;
      }
      if (!navigator.onLine) { flash('当前没有网络，无法下载音频'); return; }
      /* 请求持久化存储：否则手机存储吃紧时 Chrome 可能把 106MB 缓存悄悄清掉 */
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });
      cancelFlag = false;
      cacheAll(audioFiles());
    });
    if (cancel) cancel.addEventListener('click', function () { cancelFlag = true; });
    if (clear) clear.addEventListener('click', function () {
      askSw('clear-audio', function () {
        flash('已清除离线音频缓存');
        refreshStat();
      });
    });
  }

  /* ---------- 安装到桌面 ---------- */
  function bindInstall() {
    var btn = $('#installBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!deferredPrompt) {
        flash('浏览器没给出安装入口：Chrome 菜单 → 「添加到主屏幕」');
        return;
      }
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          deferredPrompt = null;
          btn.classList.add('hidden');
        }
      }).catch(function () { });
    });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      btn.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      btn.classList.add('hidden');
      flash('已安装到桌面，之后从桌面图标打开即可离线使用');
    });
  }

  /* ---------- 版本更新 ---------- */
  function showUpdate(worker) {
    updateWorker = worker;
    var btn = $('#updateBtn');
    if (btn) btn.classList.remove('hidden');
  }

  function bindUpdate(reg) {
    var btn = $('#updateBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      /* skip-waiting 必须发给 waiting 那个 worker，发给当前控制器是没用的 */
      var target = (reg && reg.waiting) || updateWorker;
      if (!target) { flash('没有待更新的版本'); return; }
      btn.disabled = true;
      target.postMessage({ type: 'skip-waiting' });
      /* 新 SW 接管后由 controllerchange 统一刷新；兜底 4 秒没动静就自己 reload */
      setTimeout(function () { if (!reloaded) { reloaded = true; window.location.reload(); } }, 4000);
    });
  }

  function register() {
    var secure = window.isSecureContext === true;
    var note = $('#offlineNote');
    audioTotal = audioFiles().length;

    if (!('serviceWorker' in navigator)) {
      if (note) note.textContent = '当前浏览器不支持 Service Worker，只能用浏览器合成语音朗读。';
      return;
    }
    if (!secure) {
      if (note) {
        note.textContent = '离线缓存需要 HTTPS（或 localhost）。用 file:// 打开或局域网 http 地址时只能联网使用，'
          + '标记也可能随页面关闭丢失。';
      }
      var btn = $('#offlineBtn');
      if (btn) { btn.disabled = true; btn.title = '需要 HTTPS 才能离线缓存'; }
      return;
    }

    hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      /* 只有「本来就有控制器、又换了新控制器」才需要刷新；首次安装时的 claim 不该刷 */
      if (!hadController || reloaded || !updateWorker) return;
      reloaded = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      bindUpdate(reg);
      if (reg.waiting) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && hadController) showUpdate(nw);
        });
      });
      /* 每次打开都悄悄查一次有没有新版 sw.js（Chrome 只在 24h 内比对，主动 check 更及时） */
      if (reg.update) reg.update().catch(function () { });
      refreshStat();
    }).catch(function (err) {
      if (note) note.textContent = '离线组件注册失败：' + err;
    });
  }

  function init() {
    bindInstall();
    bindOffline();
    register();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { refresh: refreshStat, audioTotal: function () { return audioTotal; } };
})();
