/* localStorage 封装：读写生词/熟词标记、导入的自定义词库、界面偏好
 * 浏览器禁用 localStorage 时自动降级为内存模式（刷新后状态不保留，但功能可用）。
 */
window.Store = (function () {
  var KEY = 'toeic-vocab-app-v1';
  var memoryOnly = false;
  var state = { marks: {}, customTopics: [], prefs: {} };

  function storageAvailable() {
    try {
      var probe = '__toeic_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  function load() {
    memoryOnly = !storageAvailable();
    if (memoryOnly) return state;
    try {
      var raw = window.localStorage.getItem(KEY);
      if (raw) {
        var data = JSON.parse(raw) || {};
        state.marks = data.marks && typeof data.marks === 'object' ? data.marks : {};
        state.customTopics = Array.isArray(data.customTopics) ? data.customTopics : [];
        state.prefs = data.prefs && typeof data.prefs === 'object' ? data.prefs : {};
      }
    } catch (e) {
      console.warn('读取本地存储失败，本次以内存模式运行：', e);
      memoryOnly = true;
    }
    return state;
  }

  function save() {
    if (memoryOnly) return false;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('写入本地存储失败：', e);
      memoryOnly = true;
      return false;
    }
  }

  /* 词汇的唯一键：主题 id + 小写单词，保证标记状态跨刷新稳定 */
  function wordKey(topicId, word) {
    return topicId + '::' + String(word).trim().toLowerCase();
  }

  return {
    load: load,
    save: save,
    wordKey: wordKey,
    isMemoryOnly: function () { return memoryOnly; },

    getMark: function (key) { return state.marks[key] || null; },
    /* status: 'new' 生词 | 'known' 熟词 | null 取消标记 */
    setMark: function (key, status) {
      if (status === 'new' || status === 'known') state.marks[key] = status;
      else delete state.marks[key];
      return save();
    },
    markCounts: function (keys) {
      var c = { all: keys.length, new: 0, known: 0, unmarked: 0 };
      keys.forEach(function (k) {
        var s = state.marks[k];
        if (s === 'new') c.new++;
        else if (s === 'known') c.known++;
        else c.unmarked++;
      });
      return c;
    },
    /* 删除主题（如移除导入的自定义词库）时清理其标记 */
    clearTopicMarks: function (topicId) {
      var prefix = topicId + '::';
      Object.keys(state.marks).forEach(function (k) {
        if (k.indexOf(prefix) === 0) delete state.marks[k];
      });
      return save();
    },
    resetAllMarks: function () {
      state.marks = {};
      return save();
    },

    getCustomTopics: function () { return state.customTopics.slice(); },
    getAllMarks: function () { return JSON.parse(JSON.stringify(state.marks)); },
    setCustomTopics: function (list) {
      state.customTopics = Array.isArray(list) ? list : [];
      return save();
    },

    getPref: function (name, fallback) {
      return Object.prototype.hasOwnProperty.call(state.prefs, name) ? state.prefs[name] : fallback;
    },
    setPref: function (name, value) {
      state.prefs[name] = value;
      return save();
    }
  };
})();
