/* 发音引擎：三层策略，尽量接近真人发声
 *   1) 预生成神经音频（tools/gen-audio.mjs 产出 js/audio-manifest.js）——最自然；慢速走 playbackRate + preservesPitch，语调不变形
 *   2) 浏览器 speechSynthesis + 按自然度择优的英文语音（Online / Natural 系列）——无需任何资源
 *   3) 系统默认语音——至少能出声，侧栏会提示如何升级
 * 同时负责：朗读文本改写（TtsText.forSpeech）、Chrome 长句截断、cancel 后同帧 speak 被丢弃、单词与例句连读。
 *
 * 口音（'us' 美音 / 'gb' 英音）贯穿三层：预生成音频按口音分文件与分桶存放，合成语音按口音分桶择优，
 * 全局默认口音记在 ttsAccent；单次朗读也能带口音参数（卡片上的「美 / 英」按钮），不改用户设置。
 */
(function (global) {
  'use strict';

  var SS = 'speechSynthesis' in global ? global.speechSynthesis : null;
  var TT = global.TtsText || { forSpeech: function (s) { return String(s == null ? '' : s); } };

  var prefs = { get: function (k, d) { return d === undefined ? null : d; }, set: function () { } };
  var manifest = {};          // { "<单元id>::<小写词条>": { us: {w,e}, gb: {w,e} } }，setAudioManifest 里统一成这个形状
  var voices = { us: [], gb: [] };   // 每种口音各自的英文语音，已按自然度排序
  var picked = { us: null, gb: null }; // 每种口音当前选用的 SpeechSynthesisVoice（可能为 null：本机没有该口音语音）
  var changedCbs = [];
  var stateCbs = [];
  var last = null;            // 最近一次朗读请求，供「重播」复用
  var keepAlive = null;
  var playSeq = 0;            // 递增即作废所有在播/待播的音频
  var audioBroken = false;    // 一次失败后本轮不再等待，避免每次点击都卡 1.2 秒
  var audioFails = {};        // 已经取不到的音频文件名，同个文件不再重试

  /* 语速档位：慢速单独一档。原先整句固定 0.8 会拉长元音、破坏节奏，是「不像真人」的直接原因 */
  var RATE = { word: 0.95, sentence: 1, slow: 0.72 };
  var ACCENTS = ['us', 'gb'];
  var ACC_LABEL = { us: '美音', gb: '英音' };
  var PREF = {
    voice: 'ttsVoice',                                    // 旧版单一语音偏好，只作美音桶的迁移来源
    voiceAcc: { us: 'ttsVoiceUs', gb: 'ttsVoiceGb' },
    source: 'ttsSource', speed: 'ttsRate', accent: 'ttsAccent'
  };

  /* ================= 口音 ================= */

  function normAcc(a) { return String(a || '').toLowerCase() === 'gb' ? 'gb' : 'us'; }
  function accent() { return normAcc(prefs.get(PREF.accent, 'us')); }

  /* ================= 语音挑选 ================= */

  function isEnglish(v) {
    return /^en[-_]/i.test(v.lang || '') || /^(english|美国|英国)/i.test(v.name || '');
  }

  /* en-GB（或名称里带「英国」）算英音；其余英文语音（含 en-US / en-AU）都进美音桶兜底 */
  function accentOf(v) {
    return /^en[-_]gb/i.test(v.lang || '') || /英国|british|great britain/i.test(v.name || '') ? 'gb' : 'us';
  }

  /* 神经/在线语音 >> 本地桌面语音；Google 远程语音给保底高分；微软语音小加分 */
  function naturalScore(v) {
    var n = String(v.name || '');
    var s = 0;
    if (/natural|neural|online|premium|enhanced/i.test(n)) s += 100;
    if (/google/i.test(n)) s += 60;
    if (/microsoft/i.test(n)) s += 6;
    if (v.localService === false) s += 4;
    return s;
  }
  /* 带具体地区（与目标口音一致）优于笼统 en */
  function score(v, acc) { return naturalScore(v) + (accentOf(v) === normAcc(acc) ? 20 : 10); }
  function isNatural(v) { return naturalScore(v) >= 100; }

  function sameList(a, b) {
    return a.length === b.length && a.every(function (v, i) { return b[i] === v; });
  }
  function hasVoices() { return !!(voices.us.length || voices.gb.length); }

  /* 老版本只有 ttsVoice 一个键，当时只可能配的是美音 */
  function wantVoice(acc) {
    var saved = prefs.get(PREF.voiceAcc[acc], undefined);
    if (saved === undefined) return acc === 'us' ? (prefs.get(PREF.voice, null) || null) : null;
    return saved || null;
  }

  function refreshVoices() {
    if (!SS) return voices;
    var list = [];
    try { list = SS.getVoices() || []; } catch (e) { list = []; }
    var en = list.filter(isEnglish);
    if (!en.length) return voices;                           // 引擎偶发返回空列表，保留上一次结果
    ACCENTS.forEach(function (acc) {
      var next = en.filter(function (v) { return accentOf(v) === acc; })
        .sort(function (a, b) { return score(b, acc) - score(a, acc); });
      if (sameList(next, voices[acc]) && picked[acc]) return;
      voices[acc] = next;
      var want = wantVoice(acc);
      picked[acc] = (want && next.filter(function (v) { return v.voiceURI === want; })[0]) || next[0] || null;
    });
    changedCbs.forEach(function (cb) { cb(); });
    return voices;
  }

  /* 本口音一个语音都没有就退回另一口音的，至少能出声；面板另有文案提示怎么补英音语音 */
  function voiceFor(acc) {
    acc = normAcc(acc);
    return picked[acc] || picked[acc === 'gb' ? 'us' : 'gb'] || null;
  }

  function startVoiceDiscovery() {
    refreshVoices();
    /* Chrome/Firefox 首次 getVoices() 往往返回空数组，必须等 voiceschanged 并再兜底轮询 */
    if (SS && typeof SS.addEventListener === 'function') SS.addEventListener('voiceschanged', refreshVoices);
    var tries = 0;
    (function poll() {
      tries++;
      refreshVoices();
      if (!hasVoices() && tries < 8) setTimeout(poll, 250);
    })();
  }

  /* ================= 合成音播放 ================= */

  function clearKeepAlive() {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  }

  /* Chrome 已知问题：cancel() 后同一帧 speak() 会被静默丢弃；朗读超过约 15 秒会自行截断。
   * 因此等引擎确认空闲再排入，并在播放期间定时 pause/resume 续命。 */
  /* 同一次会话里可以混排多种口音：每条 item 自带 acc 就用它自己的语音，否则用传入的默认口音 */
  function speakItems(items, slow, acc) {
    if (!SS) return false;
    var defAcc = normAcc(acc || accent());
    if (!hasVoices()) refreshVoices();
    var factor = num(prefs.get(PREF.speed, 1), 1);
    var texts = items.map(function (it) {
      var a = normAcc(it.acc == null ? defAcc : it.acc);
      var v = voiceFor(a);
      var base = slow ? RATE.slow : (it.kind === 'word' ? RATE.word : RATE.sentence);
      /* 先过一遍词库级修正再口语化改写：导入的自定义词库、尚未重跑的旧 data.js 都能拿到同样的干净文本 */
      var raw = TT.correct ? TT.correct(it.text, { example: it.kind !== 'word' }) : it.text;
      return {
        text: TT.forSpeech(raw),
        rate: clampRate(base * factor),
        voice: v,
        lang: (v && v.lang) || (a === 'gb' ? 'en-GB' : 'en-US')
      };
    }).filter(function (t) { return t.text; });
    if (!texts.length) return false;

    playSeq++;
    var seq = playSeq;
    var attempts = 0;

    emitState(true);
    function launch() {
      if (seq !== playSeq) return;                            // 已被更新的朗读请求取代，状态由它接管
      if ((SS.speaking || SS.pending) && attempts++ < 12) { setTimeout(launch, 50); return; }
      clearKeepAlive();
      keepAlive = setInterval(function () {
        if (SS.speaking && !SS.paused) { try { SS.pause(); SS.resume(); } catch (e) { } }
      }, 9000);
      texts.forEach(function (t, i) {
        var u = new global.SpeechSynthesisUtterance(t.text);
        u.lang = t.lang;
        if (t.voice) u.voice = t.voice;
        u.rate = t.rate;
        u.pitch = 1;
        if (i === texts.length - 1) {                          // 只以最后一句的结束作为整段结束
          u.onend = u.onerror = function () {
            if (seq !== playSeq) return;
            clearKeepAlive();
            emitState(false);
          };
        }
        SS.speak(u);                                          // 同一次会话内排队，引擎自己衔接句间停顿
      });
    }
    if (SS.speaking || SS.pending) { try { SS.cancel(); } catch (e) { } }
    setTimeout(launch, 15);
    return true;
  }

  /* ================= 预生成音频播放 ================= */

  /* 兼容两种清单形状：旧版只有美音时写 { w, e }，现在写 { us: {w,e}, gb: {w,e} } */
  function normalizeManifest(raw) {
    var out = {};
    Object.keys(raw || {}).forEach(function (key) {
      var e = raw[key] || {}, o = {};
      ACCENTS.forEach(function (acc) {
        var a = e[acc];
        if (a && (a.w || a.e)) o[acc] = { w: a.w || null, e: a.e || null };
      });
      if (!o.us && !o.gb && (e.w || e.e)) o.us = { w: e.w || null, e: e.e || null };
      if (o.us || o.gb) out[key] = o;
    });
    return out;
  }

  function filesOf(key, acc) {
    var e = manifest[key];
    return e ? (e[normAcc(acc)] || null) : null;
  }

  function audioUrl(item, acc) {
    var f = filesOf(item.key, acc);
    var name = f ? (item.kind === 'word' ? f.w : f.e) : null;
    return name ? 'audio/' + name : null;
  }

  /* 不传口音 = 有任一口音音频的词条数；传口音 = 该口音的覆盖条数 */
  function audioCount(acc) {
    var keys = Object.keys(manifest);
    if (!acc) return keys.length;
    return keys.filter(function (k) {
      var f = filesOf(k, acc);
      return !!(f && (f.w || f.e));
    }).length;
  }

  function playChain(urls, slow, onFail) {
    var seq = ++playSeq;
    emitState(true);
    var rate = clampRate((slow ? RATE.slow : 1) * num(prefs.get(PREF.speed, 1), 1));
    (function next() {
      var url = urls.shift();
      if (seq !== playSeq) { emitState(false); return; }
      if (!url) { emitState(false); return; }
      var el = new global.Audio(url);
      var started = false;
      var bail = function () {
        if (started || seq !== playSeq) return;
        started = true;
        /* 单个文件缺失（该口音没生成、或断网又没缓存）不该关掉整条音频链路：
         * 只记下这个文件不再重试，累计两个不同文件失败才判定音频整体不可用 */
        if (url) audioFails[url] = 1;
        if (Object.keys(audioFails).length >= 2) audioBroken = true;
        emitState(false);
        onFail();
      };
      el.addEventListener('error', bail);
      el.addEventListener('loadedmetadata', function () {
        el.playbackRate = rate;
        /* 慢速靠变速而非重新合成：保留原语者的音高与语调轮廓 */
        try { el.preservesPitch = true; } catch (e) { }
        try { el.mozPreservesPitch = true; } catch (e) { }
        try { el.webkitPreservesPitch = true; } catch (e) { }
      });
      el.addEventListener('playing', function () { started = true; });
      el.addEventListener('ended', function () { if (seq === playSeq) next(); });
      var p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          if (started || seq !== playSeq) return;
          /* 浏览器自动播放限制：等用户手势后再点，不该掉回合成音 */
          if (/not allowed|gesture|permission/i.test(String((err && (err.name || err.message)) || ''))) {
            started = true;
            emitState(false);
          } else {
            bail();
          }
        });
      }
      /* file:// 下缺文件常不触发 error，1.2 秒仍未就绪即判定不可用 */
      setTimeout(function () { if (!started && !el.readyState) bail(); }, 1200);
    })();
  }

  /* ================= 工具 ================= */

  function clampRate(r) { return Math.max(0.5, Math.min(1.6, r || 1)); }
  function num(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
  function emitState(on) { stateCbs.forEach(function (cb) { cb(on); }); }

  function itemsOf(word, kind) {
    if (kind === 'word') return [{ kind: 'word', key: word.key, text: word.word }];
    if (kind === 'example') return [{ kind: 'example', key: word.key, text: word.example }];
    /* 连读：单词 + 例句一次会话内顺序播出，词与句之间的衔接由引擎负责，比两次点击自然 */
    return [
      { kind: 'word', key: word.key, text: word.word },
      { kind: 'example', key: word.key, text: word.example }
    ].filter(function (i) { return i.text; });
  }

  /* 口音朗读顺序：当前默认口音在前，其余按传入顺序补齐（例句「两种口音各读一遍」用的就是这个序列） */
  function orderedAccents(list) {
    var out = [];
    (list && list.length ? list : ACCENTS).forEach(function (a) {
      a = normAcc(a);
      if (out.indexOf(a) < 0) out.push(a);
    });
    var i = out.indexOf(accent());
    if (i > 0) { out.splice(i, 1); out.unshift(accent()); }
    return out.length ? out : [accent()];
  }

  function accList(accOverride) {
    if (Array.isArray(accOverride)) return orderedAccents(accOverride);
    if (accOverride == null || accOverride === '') return [accent()];
    return [normAcc(accOverride)];
  }

  /* 朗读一条内容，可按顺序带上多个口音（accOverride 传数组即「各读一遍」）：
   * 预生成音频把所有片段排成一条链顺序播完；缺音频时整段改走合成语音，一次会话内换语音，
   * 不做「一半音频一半合成」的混播，否则两种音色拼在一起很突兀。 */
  function play(word, kind, slow, accOverride) {
    var accs = accList(accOverride);
    var items = itemsOf(word, kind);
    if (!items.length) return false;
    last = { word: word, kind: kind, slow: !!slow, accents: accs.slice(), accent: accs[0] };

    var seq = [];
    accs.forEach(function (acc) {
      items.forEach(function (it) { seq.push({ kind: it.kind, key: it.key, text: it.text, acc: acc }); });
    });

    var src = prefs.get(PREF.source, 'auto');
    if (src !== 'synthesis' && !audioBroken) {
      var urls = [], ok = true;
      seq.forEach(function (it) {
        var url = audioUrl(it, it.acc);
        /* 上几次已经确认取不到的（断网没缓存、该口音没生成），不再白等 1.2 秒 */
        if (!url || audioFails[url]) { ok = false; return; }
        urls.push(url);
      });
      if (ok) {
        playChain(urls, slow, function () { speakItems(seq, slow); });
        return true;
      }
    }
    if (!SS) return false;
    if (src === 'audio') return false;                       // 用户锁定音频但本条/本口音没有 → 调用方给提示
    return speakItems(seq, slow);
  }

  var api = {
    RATE: RATE,
    ACCENTS: ACCENTS,
    accentLabel: function (a) { return ACC_LABEL[normAcc(a)]; },
    supported: function () { return !!SS || Object.keys(manifest).length > 0; },
    configure: function (adapter) {
      if (adapter && typeof adapter.get === 'function') prefs = adapter;
      startVoiceDiscovery();
      return this;
    },
    /* 词库装配完成后回填预生成音频清单 */
    setAudioManifest: function (map) {
      manifest = normalizeManifest(map);
      audioBroken = false;
      audioFails = {};
      return Object.keys(manifest).length;
    },
    audioCount: function (acc) { return audioCount(acc); },
    /* 面板展示两种口音各自的覆盖词条数 */
    audioCoverage: function () {
      return { us: audioCount('us'), gb: audioCount('gb'), all: Object.keys(manifest).length };
    },
    hasAudioFor: function (word, kind, acc) { return !!audioUrl({ key: word && word.key, kind: kind || 'example' }, acc); },
    /* 当前口音（以及指定口音）的可用语音列表 */
    voices: function (acc) {
      return (voices[normAcc(acc || accent())] || []).map(function (v) {
        return { uri: v.voiceURI, name: v.name, lang: v.lang, natural: isNatural(v) };
      });
    },
    hasVoiceFor: function (acc) { return !!(voices[normAcc(acc)] || []).length; },
    currentVoiceURI: function (acc) {
      var v = picked[normAcc(acc || accent())];
      return v ? v.voiceURI : null;
    },
    hasNaturalVoice: function (acc) { return (voices[normAcc(acc || accent())] || []).some(isNatural); },
    setVoiceURI: function (uri, acc) {
      acc = normAcc(acc || accent());
      picked[acc] = (voices[acc] || []).filter(function (v) { return v.voiceURI === uri; })[0] || null;
      prefs.set(PREF.voiceAcc[acc], picked[acc] ? picked[acc].voiceURI : null);
      changedCbs.forEach(function (cb) { cb(); });
      return !!picked[acc];
    },
    /* 全局默认口音：'us' | 'gb'，只影响不加参数的朗读入口 */
    accent: accent,
    setAccent: function (a) {
      var acc = normAcc(a);
      prefs.set(PREF.accent, acc);
      return acc;
    },
    /* 'auto' 有音频用音频、没音频用合成音；'synthesis' / 'audio' 为强制指定 */
    setSource: function (v) { prefs.set(PREF.source, v); audioBroken = false; audioFails = {}; },
    source: function () { return prefs.get(PREF.source, 'auto'); },
    setSpeed: function (factor) { prefs.set(PREF.speed, clampRate(factor)); },
    speed: function () { return num(prefs.get(PREF.speed, 1), 1); },
    speakWord: function (word, acc) { return play(word, 'word', false, acc); },
    speakExample: function (word, slow, acc) { return play(word, 'example', !!slow, acc); },
    /* 例句按多个口音各读一遍（不传 accs = 当前默认口音 + 另一种） */
    speakExampleAccents: function (word, slow, accs) { return play(word, 'example', !!slow, orderedAccents(accs || ACCENTS)); },
    accentOrder: function (accs) { return orderedAccents(accs || ACCENTS); },
    speakBoth: function (word, slow, acc) { return play(word, 'both', !!slow, acc); },
    preview: function (text, acc) {
      return speakItems([{ kind: 'example', key: '__preview__', text: text || 'Please submit the expense report before Friday.' }], false, acc);
    },
    replay: function () { return last ? play(last.word, last.kind, last.slow, last.accents || last.accent) : false; },
    stop: function () { playSeq++; clearKeepAlive(); if (SS) { try { SS.cancel(); } catch (e) { } } emitState(false); },
    onVoicesChanged: function (cb) { changedCbs.push(cb); cb(); },
    onState: function (cb) { stateCbs.push(cb); }
  };
  /* 注意：IIFE 的参数名 global 只在函数内可见，挂全局必须写在这份对象字面量之后 */
  global.Tts = api;
  return api;
})(typeof window !== 'undefined' ? window : globalThis);
