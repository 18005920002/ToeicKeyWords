/* 应用主逻辑：主题导航、筛选、卡片渲染、生词/熟词标记、单卡浏览与复习、JSON 导入导出 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var state = {
    topics: [],
    topicId: null,
    filter: 'all',
    search: '',
    flipped: {},
    viewer: { open: false, list: [], index: 0, mode: 'browse', flipped: false },
    /* 单元连读：只记当前播到哪一段，卡片高亮靠 data-key 回填，不重建 DOM */
    unitPlay: { active: false, list: [], total: 0, index: -1, step: null, card: null, timer: null }
  };

  /* 侧栏首项“全部单元”的虚拟 id：用于浏览全部词条与承载跨单元检索 */
  var ALL_ID = '__all_units__';

  /* ================= 工具 ================= */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function slugify(s) {
    return String(s).trim().toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'topic';
  }

  function shortHash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }

  /* ================= 朗读 ================= */

  /* 发音实现在 js/tts.js：预生成神经音频优先 → 择优后的浏览器神经语音 → 系统默认语音；
   * 文本由 TtsText.forSpeech() 做口语化改写（展开缩写、修数字、补句末标点等）。
   * 默认原速最接近真人，慢速单独一档；口音（美 / 英）由全局默认决定，单次朗读也能临时指定。
   */
  function speakFailTip(word, kind, acc) {
    var label = Tts.accentLabel(acc);
    if (word && kind !== 'word' && !word.example) { toast('这个词还没有例句'); return; }
    if (!Tts.supported()) { toast('当前浏览器不支持语音朗读'); return; }
    if (!Tts.audioCount() && !Tts.voices(acc).length) {
      toast('系统里还没有英文语音：Windows 设置 → 时间和语言 → 语音 → 添加语音（选 English）');
      return;
    }
    if (Tts.source() === 'audio') {
      toast('还没有' + label + '预生成音频，可改回「自动」音源，或跑 tools/gen-audio.mjs --accent ' + (acc === 'gb' ? 'gb' : 'us'));
      return;
    }
    if (!Tts.voices(acc).length) {
      toast(label + '音频还没生成，本机也没有' + label + '合成语音：Windows 语音设置里添加 English (United Kingdom)，或跑 tools/gen-audio.mjs --accent gb');
      return;
    }
    toast('没取到可用发音，到顶部「发音」里换个语音试试');
  }

  function speakWord(word, acc) { if (word && !Tts.speakWord(word, acc)) speakFailTip(word, 'word', acc || Tts.accent()); }
  function speakExample(word, slow, acc) { if (word && !Tts.speakExample(word, slow, acc)) speakFailTip(word, 'example', acc || Tts.accent()); }
  /* 点例句整行：两种口音各读一遍（当前默认口音在前） */
  function speakExampleAll(word, slow) { if (word && !Tts.speakExampleAccents(word, slow)) speakFailTip(word, 'example', Tts.accent()); }
  function speakBoth(word, slow, acc) { if (word && !Tts.speakBoth(word, slow, acc)) speakFailTip(word, 'example', acc || Tts.accent()); }

  /* 美 / 英两个口音按钮：点一下只试听该口音，默认口音仍在顶部「发音」里选 */
  var ACC_SHORT = { us: '美', gb: '英' };
  function accTitle(acc) {
    return '只用' + Tts.accentLabel(acc) + '读一遍' + (acc === Tts.accent() ? '（当前默认口音）' : '（不改变默认口音）');
  }
  function accentBtn(act, acc, asSpan) {
    var cls = 'tbtn acc-btn' + (acc === Tts.accent() ? ' is-on' : '');
    return asSpan
      ? '<span class="' + cls + '" data-act="' + act + '" data-accent="' + acc + '" role="button" tabindex="0" title="' + accTitle(acc) + '">' + ACC_SHORT[acc] + '</span>'
      : '<button type="button" class="' + cls + '" data-act="' + act + '" data-accent="' + acc + '" title="' + accTitle(acc) + '">' + ACC_SHORT[acc] + '</button>';
  }
  function accentPair(act, asSpan) {
    return Tts.ACCENTS.map(function (a) { return accentBtn(act, a, asSpan); }).join('');
  }
  /* 另一种口音，给「换口音对比」的快捷键用 */
  function otherAcc() { return Tts.accent() === 'gb' ? 'us' : 'gb'; }

  /* 例句行的提示文字跟着默认口音变，说清“先听哪个” */
  function exampleTitle(shortcut) {
    var order = Tts.accentOrder().map(function (a) { return Tts.accentLabel(a); }).join('、');
    return '朗读例句：' + order + ' 各读一遍' + (shortcut ? '（快捷键 S）' : '');
  }

  /* 口音变了就同步按钮高亮与提示文字，不必重绘整片卡片 */
  function syncAccentUI() {
    var cur = Tts.accent();
    $$('[data-accent]').forEach(function (el) {
      if (el.tagName === 'INPUT') return;
      var acc = String(el.getAttribute('data-accent'));
      el.classList.toggle('is-on', acc === cur);
      if (el.hasAttribute('title') && el.hasAttribute('data-act')) el.setAttribute('title', accTitle(acc));
    });
    $$('.ex-line[data-act="speak-example"]').forEach(function (el) {
      el.setAttribute('title', exampleTitle(el.hasAttribute('data-shortcut')));
    });
  }

  function downloadJson(fileName, obj) {
    try {
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    } catch (e) {
      toast('导出失败：' + e.message);
    }
  }

  /* ================= 数据装配 ================= */

  function stripKey(w) {
    return { word: w.word, phonetic: w.phonetic, pos: w.pos, englishDef: w.englishDef, meaning: w.meaning, example: w.example, exampleCn: w.exampleCn, part: w.part };
  }

  function normalizeTopic(raw) {
    var en = function (v, asExample) {
      var s = String(v && v || '').trim();
      if (!window.TtsText || !s) return s;
      return TtsText.correct(s, asExample ? { example: true } : null);   // 导入词库套用与构建期同一套清洗规则
    };
    var words = (raw.words || []).map(function (w) {
      var o = {
        word: en(w && w.word),
        phonetic: en(w && w.phonetic),
        pos: String(w && w.pos || '').trim(),
        englishDef: en(w && w.englishDef),
        meaning: (w && w.meaning || '').trim(),
        example: en(w && w.example, true),
        exampleCn: (w && w.exampleCn || '').trim(),
        part: (w && w.part || '').trim(),
        unit: raw.name || ''
      };
      o.key = Store.wordKey(raw.id, o.word);
      return o;
    }).filter(function (w) { return w.word; });
    return {
      id: raw.id,
      name: raw.name,
      icon: raw.icon || '📚',
      custom: !!raw.custom,
      words: words
    };
  }

  function buildTopics() {
    var list = (window.BUILTIN_TOPICS || []).map(function (t) {
      return normalizeTopic({ id: t.id, name: t.name, icon: t.icon, custom: false, words: t.words });
    });
    Store.getCustomTopics().forEach(function (t) {
      list.push(normalizeTopic({ id: t.id, name: t.name, icon: t.icon, custom: true, words: t.words }));
    });
    return list;
  }

  /* 把全部单元的词条汇成一个虚拟主题，用于“全部单元”浏览与跨单元检索 */
  function allUnitsTopic() {
    var words = [];
    state.topics.forEach(function (t) { t.words.forEach(function (w) { words.push(w); }); });
    return { id: ALL_ID, name: '全部单元', icon: '🔎', custom: false, words: words };
  }

  function hasTopic(id) {
    if (id === ALL_ID) return true;
    return state.topics.some(function (t) { return t.id === id; });
  }

  function getTopic(id) {
    if (id === ALL_ID) return allUnitsTopic();
    for (var i = 0; i < state.topics.length; i++) { if (state.topics[i].id === id) return state.topics[i]; }
    return state.topics[0] || null;
  }

  function markOf(word) { return Store.getMark(word.key); }

  function matchSearch(word, q) {
    if (!q) return true;
    return [word.word, word.meaning, word.englishDef, word.example, word.exampleCn, word.pos].join(' ').toLowerCase().indexOf(q) >= 0;
  }

  function wordsByFilter(topic, filter, search) {
    var q = (search || '').trim().toLowerCase();
    return topic.words.filter(function (w) {
      var m = markOf(w);
      if (filter === 'new' && m !== 'new') return false;
      if (filter === 'known' && m !== 'known') return false;
      if (filter === 'unmarked' && m) return false;
      return matchSearch(w, q);
    });
  }

  /* 有检索词时跨全部单元检索；否则按所选单元（或“全部单元”）浏览 */
  function activeScope() {
    var q = (state.search || '').trim();
    if (q) return { topic: allUnitsTopic(), global: true, searching: true };
    return { topic: getTopic(state.topicId), global: state.topicId === ALL_ID, searching: false };
  }

  /* 当前网格实际展示的词条列表（放大浏览时复用，保证所见即所得） */
  function visibleWords() {
    var s = activeScope();
    return s.topic ? wordsByFilter(s.topic, state.filter, state.search) : [];
  }

  /* ================= 渲染 ================= */

  function renderTopics() {
    var allKeys = [];
    state.topics.forEach(function (t) { t.words.forEach(function (w) { allKeys.push(w.key); }); });
    var allCounts = Store.markCounts(allKeys);
    var allPct = allCounts.all ? Math.round(allCounts.known / allCounts.all * 100) : 0;

    var html = '<li>' +
      '<button type="button" class="topic-item topic-all' + (state.topicId === ALL_ID ? ' is-active' : '') + '" data-topic="' + ALL_ID + '">' +
      '<span class="t-name">🔎 全部单元</span>' +
      '<span class="t-meta"><span>' + allCounts.all + ' 词</span>' +
      (allCounts.new ? '<span class="t-new">生词 ' + allCounts.new + '</span>' : '') +
      '<span>' + allPct + '% 已掌握</span></span>' +
      '<span class="t-bar"><i style="width:' + allPct + '%"></i></span>' +
      '</button></li>';

    html += state.topics.map(function (t) {
      var counts = Store.markCounts(t.words.map(function (w) { return w.key; }));
      var pct = t.words.length ? Math.round(counts.known / t.words.length * 100) : 0;
      return '<li>' +
        '<button type="button" class="topic-item' + (t.id === state.topicId ? ' is-active' : '') + '" data-topic="' + escapeHtml(t.id) + '">' +
        (t.custom ? '<span class="t-del" data-del="' + escapeHtml(t.id) + '" title="删除这个自定义词库">✕</span>' : '') +
        '<span class="t-name">' + escapeHtml(t.icon) + ' ' + escapeHtml(t.name) + '</span>' +
        '<span class="t-meta"><span>' + t.words.length + ' 词</span>' +
        (counts.new ? '<span class="t-new">生词 ' + counts.new + '</span>' : '') +
        '<span>' + pct + '% 已掌握</span></span>' +
        '<span class="t-bar"><i style="width:' + pct + '%"></i></span>' +
        '</button></li>';
    }).join('');
    $('#topicList').innerHTML = html;

    var customCount = state.topics.filter(function (t) { return t.custom; }).length;
    $('#customTip').textContent = customCount
      ? '已导入 ' + customCount + ' 个自定义词库，点右上角 ✕ 可删除。'
      : '导入的自定义词库会显示在这里。';
  }

  function badgeHtml(mark) {
    if (mark === 'new') return '<span class="badge badge-new">生词</span>';
    if (mark === 'known') return '<span class="badge badge-known">熟词</span>';
    return '<span class="badge" style="background:#f2f4f7;color:#8b949e">未标记</span>';
  }

  /* 释义：英文注释 + 中文注释，同卡直接展示 */
  function defsHtml(word) {
    var html = '';
    if (word.englishDef) html += '<p class="def-en">' + escapeHtml(word.englishDef) + '</p>';
    if (word.meaning) html += '<p class="def-cn">' + escapeHtml(word.meaning) + '</p>';
    return html;
  }

  /* 例句：点整行（或 🔊）两种口音各读一遍；下方一排是单口音试听与慢速，再下方为中文译文 */
  function exampleHtml(word, shortcut) {
    if (!word.example && !word.exampleCn) return '';
    var html = '<div class="ex-block">';
    if (word.example) {
      html += '<div class="ex-line" data-act="speak-example"' + (shortcut ? ' data-shortcut="1"' : '') + ' role="button" tabindex="0" title="' + exampleTitle(shortcut) + '">' +
        '<span class="ex-speak" aria-hidden="true">🔊</span>' +
        '<span class="ex-en">' + escapeHtml(word.example) + '</span>' +
        '</div>' +
        '<div class="ex-tools">' +
        accentPair('speak-example-acc', true) +
        '<span class="tbtn ex-slow" data-act="speak-example-slow" role="button" tabindex="0" title="按当前默认口音慢速朗读，便于跟读' + (shortcut ? '（Shift + S）' : '') + '">慢</span>' +
        '</div>';
    }
    if (word.exampleCn) html += '<p class="ex-cn">' + escapeHtml(word.exampleCn) + '</p>';
    return html + '</div>';
  }

  /* 单卡展示全部字段：词条(点击朗读 + 美/英口音) / 音标 / 词性 / 英文注释 / 中文注释 / 例句(整句朗读) / 译文 */
  function cardHtml(word, index, showUnit) {
    var mark = markOf(word);
    var markClass = mark ? ' is-mark-' + mark : '';
    var tag = '';
    if (word.part) {
      var u = (showUnit && word.unit) ? word.unit.replace(/^(Unit\s+\d+).*$/i, '$1') + ' · ' : '';
      tag = u + 'Part ' + word.part;
    } else if (showUnit && word.unit) {
      tag = word.unit;
    }
    return '<article class="card' + markClass + '" data-key="' + escapeHtml(word.key) + '" data-i="' + index + '">' +
      '<div class="card-top">' +
        (tag ? '<span class="part-badge">' + escapeHtml(tag) + '</span>' : '') +
        '<span class="grow"></span>' +
        badgeHtml(mark) +
      '</div>' +
      '<div class="card-head">' +
        '<button type="button" class="card-word" data-act="speak" title="点击按当前默认口音朗读单词">' +
          '<span class="w-text">' + escapeHtml(word.word) + '</span>' +
          '<span class="w-speak" aria-hidden="true">🔊</span>' +
        '</button>' +
        '<span class="acc-group">' + accentPair('speak-acc', false) + '</span>' +
        '<span class="card-meta">' +
          (word.phonetic ? '<span class="card-phonetic">' + escapeHtml(word.phonetic) + '</span>' : '') +
          (word.pos ? '<span class="card-pos">' + escapeHtml(word.pos) + '</span>' : '') +
        '</span>' +
      '</div>' +
      '<div class="card-defs">' + defsHtml(word) + '</div>' +
      exampleHtml(word) +
      '<div class="card-foot">' +
        '<button type="button" class="mini" data-act="open">放大浏览</button>' +
        '<span class="grow"></span>' +
        '<button type="button" class="mini' + (mark === 'new' ? ' on-new' : '') + '" data-act="new">生词</button>' +
        '<button type="button" class="mini' + (mark === 'known' ? ' on-known' : '') + '" data-act="known">熟词</button>' +
      '</div>' +
    '</article>';
  }

  function renderCards() {
    var scope = activeScope();
    var topic = scope.topic;
    if (!topic) {
      $('#topicTitle').textContent = '词库为空';
      $('#topicMeta').textContent = '';
      $('#counters').innerHTML = '';
      $('#cards').innerHTML = '';
      $('#emptyTip').classList.remove('hidden');
      $('#emptyTip').textContent = '请导入自定义词汇 JSON 后开始学习。';
      return;
    }
    var words = wordsByFilter(topic, state.filter, state.search);
    var counts = Store.markCounts(topic.words.map(function (w) { return w.key; }));

    if (scope.searching) {
      $('#topicTitle').textContent = '🔎 检索 “' + state.search.trim() + '”';
      $('#topicMeta').textContent = '跨全部 ' + state.topics.length + ' 个单元匹配到 ' + words.length + ' 词';
    } else {
      $('#topicTitle').textContent = topic.icon + ' ' + topic.name;
      $('#topicMeta').textContent = (topic.id === ALL_ID
        ? '全部 ' + state.topics.length + ' 个单元，共 '
        : '本单元共 ') + topic.words.length + ' 词' + (topic.custom ? '（自定义导入）' : '');
    }
    $('#counters').innerHTML =
      '<span class="c-new">生词 <b>' + counts.new + '</b></span>' +
      '<span class="c-known">熟词 <b>' + counts.known + '</b></span>' +
      '<span>未标记 <b>' + counts.unmarked + '</b></span>';

    $('#cards').innerHTML = words.map(function (w, i) { return cardHtml(w, i, scope.global); }).join('');
    var empty = $('#emptyTip');
    empty.classList.toggle('hidden', words.length > 0);
    empty.textContent = (state.search && state.search.trim())
      ? '没有匹配「' + state.search.trim() + '」的词汇，换个关键词或筛选条件试试。'
      : '当前筛选条件下没有词汇（点上方「全部」查看所有）。';
    /* 卡片重建完了再把连读的高亮贴回去，否则标一个生词就会丢当前词 */
    syncPlayBtn(scope, words);
    syncPlayHighlight();
  }

  function renderOverall() {
    var keys = [];
    state.topics.forEach(function (t) { t.words.forEach(function (w) { keys.push(w.key); }); });
    var counts = Store.markCounts(keys);
    var pct = counts.all ? Math.round(counts.known / counts.all * 100) : 0;
    $('#overallProgress').innerHTML =
      '总进度 ' + counts.known + '/' + counts.all +
      '<span class="bar"><i style="width:' + pct + '%"></i></span>' + pct + '%';
    $('#reviewBtn').textContent = counts.new ? '🔥 只看生词（' + counts.new + '）' : '🔥 只看生词';
  }

  function renderAll() {
    renderTopics();
    renderCards();
    renderOverall();
    renderViewer();
  }

  /* ================= 单卡浏览 / 生词复习 ================= */

  function openViewer(list, index, mode) {
    if (!list || !list.length) {
      toast(mode === 'review' ? '还没有生词，先在卡片上标记“生词”吧' : '当前筛选下没有词汇');
      return;
    }
    if (state.unitPlay.active) stopUnitPlay();        // 一次只听一路，免得弹层里点朗读跟连读抢嘴
    state.viewer = {
      open: true,
      list: list,
      index: Math.max(0, Math.min(index || 0, list.length - 1)),
      mode: mode,
      flipped: mode !== 'review'
    };
    $('#viewer').classList.remove('hidden');
    $('#viewerTag').classList.toggle('hidden', mode !== 'review');
    document.body.style.overflow = 'hidden';
    renderViewer();
  }

  function closeViewer() {
    state.viewer.open = false;
    $('#viewer').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function viewerWord() { return state.viewer.list[state.viewer.index]; }

  function renderViewer() {
    var v = state.viewer;
    if (!v.open) return;
    var w = viewerWord();
    if (!w) { closeViewer(); return; }
    var mark = markOf(w);

    $('#viewerTitle').textContent = v.mode === 'review' ? '🔥 生词复习' : (getTopic(state.topicId) || {}).name || '';
    $('#viewerIndex').textContent = (v.index + 1) + ' / ' + v.list.length;
    $('#viewerCard').className = 'card-inner' + (v.flipped ? ' is-flipped' : '');
    $('#viewerCard').innerHTML =
      '<div class="card-face card-front">' +
        '<div class="card-top">' + badgeHtml(mark) + '</div>' +
        '<h3 class="card-word">' + escapeHtml(w.word) + '</h3>' +
        '<div class="card-phonetic">' + escapeHtml(w.phonetic) + '</div>' +
        '<div class="muted">' + escapeHtml(w.pos) + '</div>' +
        (v.mode === 'review' ? '<div class="muted">点击卡片（或按空格）查看释义</div>' : '') +
      '</div>' +
      '<div class="card-face card-back">' +
        '<div class="back-pos">' + escapeHtml(w.pos) + ' ' + escapeHtml(w.word) + ' ' + escapeHtml(w.phonetic) + '</div>' +
        '<div class="back-defs">' + defsHtml(w) + '</div>' +
        exampleHtml(w, true) +
      '</div>';

    $('#vNew').classList.toggle('is-on', mark === 'new');
    $('#vKnown').classList.toggle('is-on', mark === 'known');
    $('#vPrev').disabled = v.index <= 0;
    $('#vNext').disabled = v.index >= v.list.length - 1;
  }

  function stepViewer(delta) {
    var v = state.viewer;
    var next = v.index + delta;
    if (next < 0 || next >= v.list.length) {
      if (v.mode === 'review' && next >= v.list.length) {
        toast('本轮生词复习完成 🎉');
        closeViewer();
      }
      return;
    }
    v.index = next;
    v.flipped = v.mode !== 'review';
    renderViewer();
  }

  function flipViewer() {
    state.viewer.flipped = !state.viewer.flipped;
    renderViewer();
  }

  /* ================= 标记 ================= */

  function markWord(word, status) {
    var turnedOff = markOf(word) === status;
    Store.setMark(word.key, turnedOff ? null : status);
    renderTopics();
    renderCards();
    renderOverall();
    toast(turnedOff
      ? '已取消标记：' + word.word
      : (status === 'new' ? '已标为生词：' : '已标为熟词：') + word.word);
    if (state.viewer.open) {
      renderViewer();
      if (!turnedOff && state.viewer.mode === 'review') stepViewer(1);
    }
  }

  function findWord(key) {
    var found = null;
    state.topics.forEach(function (t) {
      t.words.forEach(function (w) { if (w.key === key) found = w; });
    });
    return found;
  }

  function selectTopic(id) {
    if (state.unitPlay.active) stopUnitPlay();
    state.topicId = id;
    state.flipped = {};
    Store.setPref('topicId', id);
    renderTopics();
    renderCards();
  }

  /* 删除导入的自定义主题（同时清理其标记记录） */
  function removeCustomTopic(id) {
    var topic = getTopic(id);
    if (!topic || !topic.custom) return;
    var msg = '确定删除自定义主题「' + topic.name + '」（共 ' + topic.words.length + ' 词）？\n该主题的标记记录也会一并清除，内置主题不受影响。';
    if (!window.confirm(msg)) return;
    Store.setCustomTopics(Store.getCustomTopics().filter(function (x) { return x.id !== id; }));
    Store.clearTopicMarks(id);
    state.topics = buildTopics();
    if (state.topicId === id) {
      state.topicId = (state.topics[0] || {}).id || null;
      Store.setPref('topicId', state.topicId);
    }
    renderAll();
    toast('已删除主题「' + topic.name + '」');
  }

  function startReview() {
    var list = [];
    state.topics.forEach(function (t) {
      t.words.forEach(function (w) { if (markOf(w) === 'new') list.push(w); });
    });
    openViewer(list, 0, 'review');
  }

  /* ================= 单元连读 ================= */

  var UNIT_GAP_MS = 3000;
  var PLAY_IDLE = '▶ 单元连读';
  var PLAY_STOP = '⏹ 停止连读';

  function unitPlayBtn() { return $('#unitPlayBtn'); }

  function setPlayBtn(label, on) {
    var b = unitPlayBtn();
    if (!b) return;
    b.textContent = label;
    b.classList.toggle('is-on', !!on);
  }

  /* 正在播的那张卡片：连读期间不重绘网格，只按 data-key 找元素改 class */
  function playCard() {
    var st = state.unitPlay;
    if (!st.active || !st.card) return null;
    return $('#cards .card[data-key="' + st.card.key + '"]');
  }

  function clearPlayHighlight() {
    $$('#cards .card.is-playing').forEach(function (c) { c.classList.remove('is-playing'); });
    $$('#cards .is-now').forEach(function (el) { el.classList.remove('is-now', 'is-repeat'); });
    $$('#cards [data-acc-label]').forEach(function (el) { el.removeAttribute('data-acc-label'); });
  }

  /* 高亮当前词条，并只点亮正在播的那一行（单词 / 例句），旁边用 data-acc-label 标出口音 */
  function syncPlayHighlight() {
    clearPlayHighlight();
    var st = state.unitPlay;
    var step = st.step;
    if (!st.active || !step || step.type !== 'seg') return;
    var card = playCard();
    if (!card) return;                                        // 标记 / 筛选后这条词已不在网格里，等下一段
    card.classList.add('is-playing');
    var line = step.kind === 'word' ? $('.card-word', card) : $('.ex-line', card);
    if (!line) return;
    line.classList.add('is-now');
    if (step.round > 1) line.classList.add('is-repeat');
    line.setAttribute('data-acc-label',
      Tts.accentLabel(step.acc) + (step.round > 1 ? ' 第 ' + step.round + ' 遍' : ''));
  }

  function scrollPlayCard() {
    var card = playCard();
    if (!card || typeof card.scrollIntoView !== 'function') return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }); }
    catch (e) { card.scrollIntoView(); }
  }

  function stopPlayTimer() {
    var st = state.unitPlay;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  }

  /* 3 秒静默得让用户看见是在等下一条，而不是卡住了 */
  function runCountdown(step) {
    var st = state.unitPlay;
    var left = Math.max(1, Math.round((step.ms || UNIT_GAP_MS) / 1000));
    var n = step.i + 1;
    stopPlayTimer();
    (function tick() {
      setPlayBtn(PLAY_STOP + ' · ' + left + ' 秒后第 ' + n + '/' + st.total + ' 词', true);
      if (left <= 1) { st.timer = null; return; }
      left--;
      st.timer = setTimeout(tick, 1000);
    })();
  }

  function onUnitStep(s) {
    var st = state.unitPlay;
    if (!st.active) return;
    if (s.type === 'wait') {
      /* 例句两遍之间的轻停：界面保持上一段不动，只有词条间的 3 秒才倒数 */
      if (s.ms && s.ms >= 1000) runCountdown(s);
      return;
    }
    stopPlayTimer();
    st.step = s;
    st.card = s.word;
    setPlayBtn(PLAY_STOP + ' · ' + (s.i + 1) + '/' + st.total + ' · ' + s.word.word + ' · ' + Tts.unitStepLabel(s), true);
    syncPlayHighlight();
    if (s.i !== st.index) { st.index = s.i; scrollPlayCard(); }
  }

  function resetPlayUI() {
    var st = state.unitPlay;
    stopPlayTimer();
    st.active = false; st.step = null; st.card = null; st.index = -1; st.list = []; st.total = 0;
    clearPlayHighlight();
    setPlayBtn(PLAY_IDLE, false);
  }

  function onUnitEnd(reason, info) {
    var st = state.unitPlay;
    if (!st.active) return;                                   // 用户自己点停止时已复位，不再提示
    var skipped = (info && info.skipped) || 0;
    resetPlayUI();
    if (reason === 'interrupted') toast('已插入其他朗读，单元连读停止');
    else if (reason === 'blocked') toast('浏览器拦住了自动播放，再点一次「单元连读」就好');
    else if (reason === 'done') toast('本单元连读完成' + (skipped ? '（' + skipped + ' 段没有可用发音，已跳过）' : ''));
  }

  /* 连读的就是一屏所见：当前单元 + 当前筛选 / 检索条件下真正列出来的那些词 */
  function startUnitPlay() {
    var st = state.unitPlay;
    if (st.active) { stopUnitPlay(); return; }
    var words = visibleWords();
    if (!words.length) { toast('当前筛选下没有词汇'); return; }
    st.active = true; st.list = words; st.total = words.length; st.index = -1; st.step = null; st.card = null;
    if (!Tts.playUnitWords(words, { gapMs: UNIT_GAP_MS, onStep: onUnitStep, onEnd: onUnitEnd })) {
      resetPlayUI();
      speakFailTip(null, 'example');
      return;
    }
    toast('单元连读：单词' + accOrderText() + '各一遍，例句各两遍，词条之间停 3 秒');
  }

  function stopUnitPlay() {
    var was = state.unitPlay.active;
    resetPlayUI();
    if (was) Tts.stop();
  }

  function accOrderText() {
    return Tts.unitAccents().map(function (a) { return Tts.accentLabel(a); }).join('、');
  }

  /* 按钮只在单个单元视图里出现：全部单元 1200 词太长，检索结果又随时在变 */
  function syncPlayBtn(scope, words) {
    var b = unitPlayBtn();
    if (!b) return;
    var playable = !!scope.topic && !scope.searching && scope.topic.id !== ALL_ID && words.length > 0;
    b.classList.toggle('hidden', !playable);
    if (!playable) {
      if (state.unitPlay.active) stopUnitPlay();
      return;
    }
    var mins = Math.max(1, Math.round(words.length * 25 / 60));
    b.title = '单元连读：' + words.length + ' 个词条，单词' + accOrderText() + '各一遍、例句' +
      accOrderText() + '各两遍，词条之间停 3 秒（约 ' + mins + ' 分钟，再点一次停止）';
  }

  /* ================= 导入 / 导出 ================= */

  function topicNameOf(o, fallback) {
    return String((o && (o.topic || o.name || o.title)) || fallback || '自定义词汇').trim();
  }

  function isTopicObj(o) { return o && typeof o === 'object' && Array.isArray(o.words); }

  /* 宽容解析多种 JSON 结构：单主题对象 / 主题数组 / 单词数组 / 单条词汇 / 备份文件 */
  function collectTopics(data, fallbackName) {
    var out = [];
    if (Array.isArray(data)) {
      if (data.length && data.every(function (x) { return x && typeof x.word === 'string'; })) {
        out.push({ name: fallbackName, words: data });
      } else {
        data.filter(isTopicObj).forEach(function (t) {
          out.push({ name: topicNameOf(t, fallbackName), icon: t.icon, words: t.words });
        });
      }
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.topics)) {
        data.topics.filter(isTopicObj).forEach(function (t) {
          out.push({ name: topicNameOf(t, fallbackName), icon: t.icon, words: t.words });
        });
      } else if (isTopicObj(data)) {
        out.push({ name: topicNameOf(data, fallbackName), icon: data.icon, words: data.words });
      } else if (typeof data.word === 'string') {
        out.push({ name: fallbackName, words: [data] });
      }
    }
    return out.filter(function (t) { return t.words && t.words.length; });
  }

  function uniqueTopicId(name, taken) {
    var base = 'custom-' + slugify(name) + '-' + shortHash(name);
    var id = base, n = 2;
    function used(candidate) {
      if (taken.indexOf(candidate) >= 0) return true;
      return state.topics.some(function (t) { return t.id === candidate; });
    }
    while (used(id)) { id = base + '-' + n; n++; }
    return id;
  }

  function applyImport(text, fileName) {
    var data = JSON.parse(text);
    var fallback = String(fileName || '').replace(/\.json$/i, '').trim() || '自定义词汇';
    var topics;
    var restoreMarks = null;

    if (data && typeof data === 'object' && !Array.isArray(data) && (data.customTopics || data.marks)) {
      /* 本应用导出的备份文件 */
      topics = (data.customTopics || []).filter(isTopicObj).map(function (t) {
        return { name: topicNameOf(t, fallback), icon: t.icon, words: t.words };
      });
      if (data.marks && typeof data.marks === 'object') restoreMarks = data.marks;
    } else {
      topics = collectTopics(data, fallback);
    }

    if (!topics.length) {
      throw new Error('未找到可导入的词汇，请检查 JSON 是否含有 topic / words / word 字段');
    }

    var stored = Store.getCustomTopics();
    var addedWords = 0, skipped = 0, newTopics = 0, lastTopicName = '';

    topics.forEach(function (t) {
      var name = t.name;
      var existing = null;
      stored.forEach(function (x) {
        if (String(x.name).trim().toLowerCase() === name.trim().toLowerCase()) existing = x;
      });

      var clean = normalizeTopic({
        id: existing ? existing.id : '__tmp__',
        name: name,
        icon: t.icon,
        custom: true,
        words: t.words
      });
      if (!clean.words.length) { skipped += t.words.length; return; }

      if (!existing) {
        var fresh = { id: uniqueTopicId(name, stored.map(function (x) { return x.id; })), name: name, icon: clean.icon, words: clean.words.map(stripKey) };
        clean.words.forEach(function (w) { w.key = Store.wordKey(fresh.id, w.word); });
        stored.push(fresh);
        newTopics++;
        addedWords += fresh.words.length;
      } else {
        var index = {};
        existing.words.forEach(function (w) { index[String(w.word).trim().toLowerCase()] = true; });
        clean.words.forEach(function (w) {
          var k = w.word.toLowerCase();
          if (index[k]) { skipped++; return; }
          index[k] = true;
          existing.words.push(stripKey(w));
          addedWords++;
        });
      }
      lastTopicName = name;
    });

    if (!addedWords && !restoreMarks) {
      toast('导入完成：词汇已存在，新增 0 个，跳过 ' + skipped + ' 个');
      return;
    }

    Store.setCustomTopics(stored);
    if (restoreMarks) {
      Object.keys(restoreMarks).forEach(function (k) {
        var s = restoreMarks[k];
        if (s === 'new' || s === 'known') Store.setMark(k, s);
      });
    }

    state.topics = buildTopics();
    var hit = state.topics.filter(function (t) { return t.name === lastTopicName; }).pop();
    if (hit) { state.topicId = hit.id; Store.setPref('topicId', hit.id); }
    renderAll();
    toast('导入成功：新增 ' + addedWords + ' 个词汇' + (newTopics ? '，新建 ' + newTopics + ' 个主题' : '') + (skipped ? '（跳过重复 ' + skipped + '）' : ''));
  }

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        applyImport(String(reader.result), file.name);
      } catch (e) {
        console.warn(e);
        toast('导入失败：' + e.message);
      }
    };
    reader.onerror = function () { toast('读取文件失败'); };
    reader.readAsText(file, 'utf-8');
  }

  function exportLibrary() {
    var payload = {
      exportedAt: new Date().toISOString(),
      app: 'toeic-vocab',
      customTopics: Store.getCustomTopics(),
      marks: Store.getAllMarks()
    };
    downloadJson('toeic-progress-' + new Date().toISOString().slice(0, 10) + '.json', payload);
    toast('已导出自定义词库与标记记录（备份用）');
  }

  function downloadTemplate() {
    downloadJson('toeic-vocab-template.json', {
      topic: '自定义词库名',
      words: [
        {
          word: 'example',
          phonetic: '/ɪɡˈzæmpl/',
          pos: 'n.',
          englishDef: 'an instance or specimen of something',
          meaning: '例子，范例',
          example: 'This is a good example.',
          exampleCn: '这是一个好例子。',
          part: 'A'
        }
      ]
    });
  }

  /* ================= 发音设置 ================= */

  var ttsPrefs = {
    get: function (k, d) { return Store.getPref(k, d); },
    set: function (k, v) { return Store.setPref(k, v); }
  };

  function renderTtsPanel() {
    var acc = Tts.accent();
    var sel = $('#ttsVoiceSel');
    if (!sel) return;
    var list = Tts.voices(acc);
    var cur = Tts.currentVoiceURI(acc);
    sel.innerHTML = list.length
      ? list.map(function (v) {
          return '<option value="' + escapeHtml(v.uri) + '"' + (v.uri === cur ? ' selected' : '') + '>' +
            escapeHtml(v.name) + '（' + escapeHtml(v.lang) + (v.natural ? ' · 神经' : ' · 普通') + '）</option>';
        }).join('')
      : '<option value="">本机没有' + Tts.accentLabel(acc) + '语音</option>';

    $$('input[name="ttsAccent"]').forEach(function (r) { r.checked = r.value === acc; });
    $('#ttsAccentNote').textContent = accentNote(acc);

    var cov = Tts.audioCoverage();
    $('#ttsCoverage').textContent = cov.all
      ? '预生成音频：' + Tts.accentLabel('us') + ' ' + cov.us + ' 词条 · ' + Tts.accentLabel('gb') + ' ' + cov.gb + ' 词条（单词与例句各一条）'
      : '未预生成音频，当前用浏览器合成语音';
    $$('input[name="ttsSource"]').forEach(function (r) { r.checked = r.value === Tts.source(); });
    $('#ttsSpeed').value = Tts.speed();
    $('#ttsSpeedOut').textContent = Number(Tts.speed()).toFixed(2) + '×';

    var label = Tts.accentLabel(acc);
    var tip;
    if (!list.length && !cov[acc]) {
      tip = acc === 'gb'
        ? '英音两条路都没通：跑 tools/gen-audio.mjs --accent gb 预生成英音音频，或在 Windows「设置 → 时间和语言 → 语音 → 添加语音」选 English (United Kingdom)。'
        : '系统里没有英文语音：Windows「设置 → 时间和语言 → 语音 → 添加语音」勾选 English；或直接改用 Edge，它自带神经语音。';
    } else if (!list.length) {
      tip = '本机没有' + label + '合成语音，目前靠' + label + '预生成音频；换成没生成的口音就会不出声。';
    } else if (!Tts.hasNaturalVoice(acc) && !cov[acc]) {
      tip = '当前只有逐词停顿的桌面语音：装一套 Natural/Neural 英文语音，或跑 tools/gen-audio.mjs 预生成神经音频，连贯度差别很大。';
    } else if (cov[acc]) {
      tip = '已启用' + label + '预生成神经音频；慢速用变调不变音高的 playbackRate，听感接近真人跟读。';
    } else {
      tip = '已启用' + label + '神经语音。默认原速最接近真人，跟读时再点例句右侧的「慢」。';
    }
    $('#ttsTip').textContent = tip;
  }

  /* 口音行下的一行小字：当前口音的音频覆盖与可用合成语音说清楚 */
  function accentNote(acc) {
    var cov = Tts.audioCoverage();
    var label = Tts.accentLabel(acc);
    var bits = [cov[acc] ? '预生成音频覆盖 ' + cov[acc] + ' 个词条' : '该口音还没有预生成音频，走浏览器合成'];
    var list = Tts.voices(acc);
    if (list.length) {
      var cur = list.filter(function (v) { return v.uri === Tts.currentVoiceURI(acc); })[0] || list[0];
      bits.push('本机' + label + '语音 ' + list.length + ' 个，当前用「' + cur.name + '」');
    } else {
      bits.push('本机没有' + label + '语音，只能先预生成音频');
    }
    return bits.join('；') + '。';
  }

  function openTtsPanel() {
    $('#ttsPanel').classList.remove('hidden');
    renderTtsPanel();
  }

  function closeTtsPanel() {
    $('#ttsPanel').classList.add('hidden');
  }

  function bindTtsPanel() {
    $('#ttsBtn').addEventListener('click', openTtsPanel);
    $('#ttsClose').addEventListener('click', closeTtsPanel);
    $('#ttsPanel').addEventListener('click', function (e) { if (e.target === this) closeTtsPanel(); });
    $('#ttsVoiceSel').addEventListener('change', function () {
      Tts.setVoiceURI(this.value);
      Tts.preview();                                        // 换语音后立刻试听，方便对比
    });
    $$('input[name="ttsAccent"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!this.checked) return;
        Tts.setAccent(this.value);
        syncAccentUI();
        renderTtsPanel();
        Tts.preview();                                      // 换口音也立刻试听一句，美英对比很直观
      });
    });
    $$('input[name="ttsSource"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!this.checked) return;
        Tts.setSource(this.value);
        renderTtsPanel();
      });
    });
    var sp = $('#ttsSpeed');
    sp.addEventListener('input', function () {
      $('#ttsSpeedOut').textContent = Number(this.value).toFixed(2) + '×';
    });
    sp.addEventListener('change', function () {
      Tts.setSpeed(this.value);
      Tts.replay();
    });
    $('#ttsPreview').addEventListener('click', function () {
      if (!Tts.preview()) speakFailTip(null, 'example');
    });
    $('#ttsReplay').addEventListener('click', function () {
      if (!Tts.replay()) speakFailTip(null, 'example');
    });
    document.addEventListener('keydown', function (e) {
      var panel = $('#ttsPanel');
      if (!panel || panel.classList.contains('hidden')) return;
      if (e.key === 'Escape') closeTtsPanel();
    });
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    var cardsEl = $('#cards');

    $('#filters').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (!btn) return;
      if (state.unitPlay.active) stopUnitPlay();        // 要听的词集变了，下一轮从头开始
      state.filter = btn.dataset.filter;
      $$('#filters .chip').forEach(function (x) { x.classList.toggle('is-active', x === btn); });
      Store.setPref('filter', state.filter);
      renderCards();
    });

    $('#searchInput').addEventListener('input', function (e) {
      if (state.unitPlay.active) stopUnitPlay();
      state.search = e.target.value || '';
      renderCards();
    });

    var upb = unitPlayBtn();
    if (upb) upb.addEventListener('click', startUnitPlay);

    $('#topicList').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { removeCustomTopic(del.getAttribute('data-del')); return; }
      var item = e.target.closest('[data-topic]');
      if (item) selectTopic(item.dataset.topic);
    });

    cardsEl.addEventListener('click', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      var word = findWord(card.dataset.key);
      if (!word) return;
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;

      if (act === 'speak') { speakWord(word); return; }
      if (act === 'speak-acc') { speakWord(word, btn.dataset.accent); return; }
      if (act === 'speak-example') { speakExampleAll(word, false); return; }
      if (act === 'speak-example-acc') { speakExample(word, false, btn.dataset.accent); return; }
      if (act === 'speak-example-slow') { speakExample(word, true); return; }
      if (act === 'open') { openViewer(visibleWords(), Number(card.dataset.i) || 0, 'browse'); return; }
      if (act === 'new' || act === 'known') { markWord(word, act); return; }
    });

    $('#vClose').addEventListener('click', closeViewer);
    $('#vPrev').addEventListener('click', function () { stepViewer(-1); });
    $('#vNext').addEventListener('click', function () { stepViewer(1); });
    $('#vFlip').addEventListener('click', flipViewer);
    /* 浏览卡片内的朗读/口音按钮不触发翻面 */
    $('#viewerFlip').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (btn && btn.dataset.act === 'speak-example') { speakExampleAll(viewerWord(), false); return; }
      if (btn && btn.dataset.act === 'speak-example-slow') { speakExample(viewerWord(), true); return; }
      if (btn && btn.dataset.act === 'speak-example-acc') { speakExample(viewerWord(), false, btn.dataset.accent); return; }
      if (btn && btn.dataset.act === 'speak-acc') { speakWord(viewerWord(), btn.dataset.accent); return; }
      flipViewer();
    });
    $('#vSpeak').addEventListener('click', function () { speakWord(viewerWord()); });
    $('#vSpeakUs').addEventListener('click', function () { speakWord(viewerWord(), 'us'); });
    $('#vSpeakGb').addEventListener('click', function () { speakWord(viewerWord(), 'gb'); });
    $('#vSpeakEx').addEventListener('click', function () { speakExampleAll(viewerWord(), false); });
    $('#vSpeakExSlow').addEventListener('click', function () { speakExample(viewerWord(), true); });
    $('#vSpeakBoth').addEventListener('click', function () { speakBoth(viewerWord(), false); });
    $('#vNew').addEventListener('click', function () { var w = viewerWord(); if (w) markWord(w, 'new'); });
    $('#vKnown').addEventListener('click', function () { var w = viewerWord(); if (w) markWord(w, 'known'); });
    $('#viewer').addEventListener('click', function (e) { if (e.target === this) closeViewer(); });

    $('#reviewBtn').addEventListener('click', startReview);
    $('#importBtn').addEventListener('click', function () {
      var input = $('#fileInput');
      input.value = '';
      input.click();
    });
    $('#fileInput').addEventListener('change', function (e) {
      Array.prototype.slice.call(e.target.files || []).forEach(readFile);
    });
    $('#exportBtn').addEventListener('click', exportLibrary);
    $('#templateBtn').addEventListener('click', downloadTemplate);
    $('#resetBtn').addEventListener('click', function () {
      if (!window.confirm('确定清空所有生词/熟词标记？导入的自定义主题不会被删除。')) return;
      Store.resetAllMarks();
      state.flipped = {};
      renderAll();
      toast('已清空所有标记');
    });

    document.addEventListener('keydown', function (e) {
      if (!state.viewer.open) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      var word = viewerWord();
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepViewer(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepViewer(1); }
      else if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); flipViewer(); }
      else if (e.key === 'Escape') { closeViewer(); }
      else if (e.key === 'p' || e.key === 'P') { speakWord(word, e.shiftKey ? otherAcc() : null); }
      else if ((e.key === 's' || e.key === 'S') && !e.shiftKey) { speakExampleAll(word, false); }
      else if ((e.key === 's' || e.key === 'S') && e.shiftKey) { speakExample(word, true); }
      else if (e.key === 'd' || e.key === 'D') { speakBoth(word, false); }
      else if (e.key === '1') { if (word) markWord(word, 'new'); }
      else if (e.key === '2') { if (word) markWord(word, 'known'); }
    });

    document.addEventListener('keydown', function (e) {
      /* 没开单卡浏览时，Esc 用来停掉单元连读 */
      if (state.viewer.open || !state.unitPlay.active) return;
      if (e.key === 'Escape') { e.preventDefault(); stopUnitPlay(); }
    });

    bindTtsPanel();
  }

  /* ================= 初始化 ================= */

  function init() {
    Store.load();
    if (Store.isMemoryOnly()) {
      toast('浏览器未启用本地存储，本次标记不会被保存');
    }
    Tts.configure(ttsPrefs);
    Tts.setAudioManifest(window.AUDIO_MANIFEST || {});
    Tts.onVoicesChanged(renderTtsPanel);
    Tts.onState(function (on) {
      /* 朗读中给顶部按钮一个状态：音频起播无提示时，用户会以为没声音 */
      document.body.classList.toggle('is-speaking', !!on);
    });
    state.topics = buildTopics();
    var savedTopic = Store.getPref('topicId', null);
    state.topicId = hasTopic(savedTopic) ? savedTopic : ((state.topics[0] && state.topics[0].id) || null);
    state.filter = Store.getPref('filter', 'all');
    $$('#filters .chip').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.filter === state.filter);
    });
    bindEvents();
    renderAll();
    syncAccentUI();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
