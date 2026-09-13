/* 朗读文本处理（被 js/app.js、js/tts.js、tools/build-from-md.mjs、tools/gen-audio.mjs 共用，改规则只改这一处）
 *
 *   TtsText.correct(s, { example })  词库级文本修正：清理 PDF 抽取留下的数字断裂、假句号、引号错位等缺陷。
 *                                    结果同时用于界面显示与朗读（构建期写入 data.js，导入期在内存中套用）。
 *   TtsText.forSpeech(s)             朗读专用改写：把缩写、符号换成引擎能正确拼读的形式，不影响界面文字。
 *
 * 为什么需要 correct()：抽取稿里存在 "$100, 000"、"3. 6%"、"Mr. Higgins. you must"、"U. S." 这类缺陷，
 * 语音引擎会据此断句、逐位念数字或逐字母拼读，整句语调被反复重置——这是「发音不连贯」的数据侧根因。
 */
(function (global, factory) {
  var api = factory();
  global.TtsText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 缩写表：句点属于缩写的一部分，其后的「. 小写词」不能当成句子边界 */
  var ABBR_RE = /(?:^|[\s(["'])(?:mr|mrs|ms|dr|prof|rev|hon|st|jr|sr|no|nos|vs|etc|eg|ie|inc|co|ltd|corp|ave|blvd|rd|vol|fig|approx|dept|mt|pp|cf|al|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.\s*$/i;

  /* 只出现字形、读法却固定的品牌词：全大写会被引擎逐字母拼读 */
  var SPELL_AS_WORD = [
    [/\bNIKE\b/g, 'Nike'],
    [/\bIKEA\b/g, 'Ikea'],
    [/\bSEPHORA\b/g, 'Sephora']
  ];

  function isSentenceEnd(str, dotIndex) {
    /* dotIndex 指向句点本身；判断这个句点是不是真正的句号 */
    var pre = str.charAt(dotIndex - 1);
    if (!/[A-Za-z]/.test(pre)) return true;                       // 数字等结尾交给缩写规则处理
    if (/[\s.(["']/.test(str.charAt(dotIndex - 2))) return false;  // 单字母缩略：U.S. / A.M. / O.J.
    return !ABBR_RE.test(str.slice(0, dotIndex + 1));
  }

  /* 引号内侧多余空格、「. "」错位、落单的闭引号（抽取稿里 18 例左右） */
  function fixQuotes(t) {
    if (t.indexOf('"') < 0) return t;
    if (((t.match(/"/g) || []).length) % 2 === 1) {       // 数量为奇数：删掉落单的那枚（通常在文末）
      var lastPos = t.lastIndexOf('"');
      if (/^\s*"[\s.,;:!?]*$/.test(t.slice(lastPos))) t = t.slice(0, lastPos).replace(/\s+$/, '');
      else {
        var first = t.indexOf('"');
        t = t.slice(0, first) + t.slice(first + 1);
      }
    }
    var out = '', open = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (ch === '"') {
        if (open) out = out.replace(/ +$/, '');            // 闭引号：吞掉前面的空格（「old. "」→「old."」）
        out += ch; open = !open; continue;
      }
      if (ch === ' ' && open && out.charAt(out.length - 1) === '"') continue; // 开引号后不留空格
      out += ch;
    }
    return out;
  }

  /* 词库级修正：构建期与导入期使用 */
  function correct(s, opts) {
    var t = String(s == null ? '' : s);
    if (!t) return t;
    var asExample = !!(opts && opts.example);

    /* 1. 全角/异体标点统一为半角（引擎对全角标点的断句与音调处理不可靠） */
    t = t.replace(/\u2236/g, ':')                         // ∶ 比率符号 → 冒号
      .replace(/[\uff0c]/g, ',').replace(/[\uff1b]/g, ';').replace(/[\uff1a]/g, ':')
      .replace(/[\uff1f]/g, '?').replace(/[\uff01]/g, '!')
      .replace(/[\uff08]/g, '(').replace(/[\uff09]/g, ')')
      .replace(/[\uff05]/g, '%').replace(/[\uff02\uff20]/g, '"').replace(/\uff07/g, "'")
      .replace(/[\uff04]/g, '$')
      .replace(/[\uffe5]/g, '\u00a5')                     // ￥ → ¥
      .replace(/[\u300c\u300d\u300e\u300f\u300a\u300b\u3010\u3011]/g, '"')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u2013\u2014]/g, '\u2014');              // 各类破折号统一为 em dash

    /* 2. 空白与标点周边（只合并重复的句末符，不能把「p.m.,」这种缩写后的逗号吃掉） */
    t = t.replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
      .replace(/\s+([,;:.!?\)\]])/g, '$1')
      .replace(/([.!?])\s*\1/g, '$1')
      .replace(/\betc\s*[,.]?\s*;/gi, 'etc.;')           // 「etc;」「etc,;」→「etc.;」
      .trim();

    /* 3. 被空格拆散的数字与时间（PDF 抽取的典型缺陷） */
    t = t.replace(/(\d)[,，]\s+(\d)/g, '$1,$2')           // $100, 000 → $100,000
      .replace(/(\d)\.\s+(\d)/g, '$1.$2')                 // 3. 6% / $29. 95 → 3.6% / $29.95
      .replace(/(\d)[:\u2236]\s+(\d)/g, '$1:$2')          // 8: 30 → 8:30
      .replace(/([$\u00a5\u20ac])\s+(\d)/g, '$1$2')       // $ 500 → $500
      .replace(/(\d)\s+%/g, '$1%');

    /* 4. 缩略词内部多余空格：U. S. → U.S.，A. M. → A.M.，p. m. → p.m. */
    t = t.replace(/\b([A-Z])\.\s+([A-Z])\.(?=$|[\s,.;:!?)"])/g, '$1.$2.')
      .replace(/\b([a-z])\.\s+([a-z])\.(?=$|[\s,.;:!?)"])/g, '$1.$2.');

    /* 5. 引号错位（依赖前面已收敛的空格） */
    t = fixQuotes(t).trim();

    SPELL_AS_WORD.forEach(function (pair) { t = t.replace(pair[0], pair[1]); });

    /* 6. 句中假句号：抽取时把缩写点当句点，导致「Mr. Higgins. you must」在句中硬停并重新起调。
     *    仅处理例句，且跳过缩写与单字母缩略。 */
    if (asExample) {
      t = t.replace(/([A-Za-z])\. +([a-z])/g, function (all, pre, ch, offset, str) {
        if (!isSentenceEnd(str, offset + 1)) return all;
        return pre + ', ' + ch;
      });
    }
    return t.trim();
  }

  /* 朗读改写：喂给语音引擎或 TTS 合成前的最后一道处理 */
  function forSpeech(s) {
    var t = String(s == null ? '' : s);
    if (!t) return t;

    /* 破折号改成逗号，引擎才会做自然连读而不是报出 "dash" */
    t = t.replace(/\s*\u2014\s*/g, ', ')
      .replace(/\s+([,;:])/g, '$1')
      .replace(/"/g, '')                                   // 引号在部分引擎里会被读出来
      .replace(/['’]/g, "'")
      .replace(/&/g, ' and ')
      .replace(/[\u300a\u300b\u3010\u3011]/g, '')
      .replace(/\u00a5\s*([\d.,]+)/g, '$1 yuan ');            // ¥500 → 500 yuan（避免读成 yen）

    /* 引擎容易拼错的缩写，展开为口语形式（要求带缩写点，避免把 DR / MS 这类全大写误展开） */
    t = t.replace(/\bMr\.\s+/g, 'Mister ')
      .replace(/\bMrs\.\s+/g, 'Missus ')
      .replace(/\bMs\.\s+/g, 'Miss ')
      .replace(/\bDr\.\s+/g, 'Doctor ')
      .replace(/\bProf\.\s+/g, 'Professor ')
      .replace(/\be\.g\.\s*/gi, 'for example, ')
      .replace(/\bi\.e\.\s*/gi, 'that is, ')
      .replace(/\bU\.S\.A\.(?![A-Za-z])/g, 'United States of America')
      .replace(/\bU\.S\.(?![A-Za-z])/g, 'United States')
      .replace(/\bU\.K\.(?![A-Za-z])/g, 'United Kingdom')
      .replace(/\bE\.U\.(?![A-Za-z])/g, 'European Union')
      .replace(/(\d)%/g, '$1 percent');

    /* 无句末标点时补句号：否则引擎语调悬空、句尾容易被硬切（短语型例句尤其明显） */
    t = t.replace(/\s+/g, ' ').trim();
    if (t && !/[.!?)\]”"']$/.test(t)) t += '.';
    return t;
  }

  return { correct: correct, forSpeech: forSpeech };
});
