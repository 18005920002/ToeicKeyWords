#!/usr/bin/env node
/* 从 docs/托业词汇词库.md 生成 js/data.js（按 Unit 组织）
 *
 * 词库来源：《新托业词汇本领书（第 3 版）》整理稿 docs/托业词汇词库.md
 * 结构约定：
 *   ## Unit N　英文标题 中文标题        —— 一个单元
 *   ### Unit N · Part A（20 词）        —— 单元内的分区（A / B）
 *   | # | 词条 | 音标 | 词性 | 英文注释 | 中文注释 | 例句 | 例句译文 |   —— 8 列表格
 *
 * 输出：window.BUILTIN_TOPICS，每个元素 = 一个 Unit，words[*] 追加 part 字段（A/B）。
 * 用法：node tools/build-from-md.mjs [--md docs/托业词汇词库.md] [--out js/data.js]
 *
 * 说明：markdown 是词库的唯一真源；改词请编辑 markdown 后重跑本脚本，勿直接改 data.js。
 * 英文文本的抽取缺陷（「$100, 000」「3. 6%」「U. S.」「Mr. Higgins. you」等）在本脚本内由
 * js/tts-text.js 的 correct() 统一修正，界面显示与语音朗读共用同一份清洗结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const TtsText = createRequire(import.meta.url)('../js/tts-text.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const MD = path.resolve(arg('md', path.join(ROOT, 'docs', '托业词汇词库.md')));
const OUT = path.resolve(arg('out', path.join(ROOT, 'js', 'data.js')));

/* ---------- 字段规范化：清理 PDF 抽取留下的全角标点与多余空格 ---------- */

/* 英文/音标/单元名：全角标点、数字断裂、引号错位等缺陷由共享规则修正（js/tts-text.js） */
function normEn(s) {
  return TtsText.correct(s);
}

/* 例句：额外允许把「词. 小写词」这类被误当句点的缩写点改成逗号，避免朗读时句中硬停 */
function normExample(s) {
  return TtsText.correct(s, { example: true });
}

/* 中文：收敛空白，并删除中日韩字符/全角标点之间的空格（如「劳动 人口」「副本 （2） 复制」） */
function normCn(s) {
  return String(s == null ? '' : s)
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, '')
    .trim();
}

function normPos(s) {
  return String(s == null ? '' : s).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------- 解析 markdown ---------- */
const raw = fs.readFileSync(MD, 'utf8');
const lines = raw.split(/\r?\n/);

const units = [];               // [{ num, name, words: [] }]
let cur = null;                 // 当前单元
let curPart = '';               // 当前分区字母（A/B）
const warnings = [];
const fixes = [];               // 例句被规则改动的清单，构建后打印复核

function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
function isSeparator(cells) { return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c)); }

for (const line of lines) {
  // 单元标题
  let m = line.match(/^##\s+Unit\s*(\d+)\s*(.*)$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    const rest = normEn(m[2]);               // 「Office Matters 办公室事宜」
    cur = { num, name: ('Unit ' + num + (rest ? ' ' + rest : '')).trim(), words: [] };
    curPart = '';
    units.push(cur);
    continue;
  }
  // 分区标题
  m = line.match(/^###\s+Unit\s*\d+\s*·\s*Part\s*([A-Za-z])/i);
  if (m) { curPart = m[1].toUpperCase(); continue; }

  if (!isTableRow(line) || !cur) continue;

  const cells = line.split('|').slice(1, -1).map(c => c.trim());
  if (isSeparator(cells)) continue;          // |---|---| 分隔行
  if (!/^\d+$/.test(cells[0] || '')) continue; // 跳过表头（首列为「#」）等非数据行

  if (cells.length !== 8) {
    warnings.push(`Unit ${cur.num} 第 ${cells[0]} 行列数为 ${cells.length}（应为 8），已跳过：${cells.slice(1, 3).join(' / ')}`);
    continue;
  }

  const [, word, phonetic, pos, englishDef, meaning, example, exampleCn] = cells;
  if (!normEn(word)) { warnings.push(`Unit ${cur.num} 第 ${cells[0]} 行词条为空，已跳过`); continue; }

  const ex = normExample(example);
  /* 例句专有规则改动了什么，打出来给人看（全角转换等机械修正不列入） */
  if (ex !== normEn(example)) {
    fixes.push({ unit: cur.num, word: normEn(word), from: normEn(example), to: ex });
  }

  cur.words.push({
    word: normEn(word),
    phonetic: normEn(phonetic),
    pos: normPos(pos),
    englishDef: normEn(englishDef),
    meaning: normCn(meaning),
    example: ex,
    exampleCn: normCn(exampleCn),
    part: curPart || '',
  });
}

/* ---------- 输出 data.js ---------- */
function esc(s) { return JSON.stringify(String(s == null ? '' : s)); }

const out = [];
out.push('/* 内置托业词汇数据：按单元（Unit）组织');
out.push(' * 数据源：docs/托业词汇词库.md（《新托业词汇本领书（第 3 版）》整理稿）');
out.push(' * 字段：word 词条 | phonetic 音标 | pos 词性 | englishDef 英文注释 | meaning 中文注释 | example 例句 | exampleCn 例句译文 | part 分区(A/B)');
out.push(' * 由 tools/build-from-md.mjs 生成，请勿手工修改；改词库请编辑 markdown 后重跑脚本。');
out.push(' */');
out.push('window.BUILTIN_TOPICS = [');
units.forEach((u, ui) => {
  out.push('  {');
  out.push(`    id: ${esc('unit-' + u.num)}, name: ${esc(u.name)}, icon: "📗",`);
  out.push('    words: [');
  u.words.forEach(w => {
    out.push('      { ' + [
      `word: ${esc(w.word)}`, `phonetic: ${esc(w.phonetic)}`, `pos: ${esc(w.pos)}`,
      `englishDef: ${esc(w.englishDef)}`, `meaning: ${esc(w.meaning)}`,
      `example: ${esc(w.example)}`, `exampleCn: ${esc(w.exampleCn)}`, `part: ${esc(w.part)}`,
    ].join(', ') + ' },');
  });
  out.push('    ]');
  out.push(ui === units.length - 1 ? '  }' : '  },');
});
out.push('];');
fs.writeFileSync(OUT, out.join('\n') + '\n', { encoding: 'utf8' });

/* ---------- 汇总 ---------- */
const total = units.reduce((n, u) => n + u.words.length, 0);
const noPhon = units.reduce((n, u) => n + u.words.filter(w => !w.phonetic).length, 0);
const noEx = units.reduce((n, u) => n + u.words.filter(w => !w.example).length, 0);
console.log(`✓ 生成 ${path.relative(ROOT, OUT)}`);
console.log(`  单元 ${units.length} 个 / 词条 ${total} 个 / 缺音标 ${noPhon} / 缺例句 ${noEx}`);
units.forEach(u => console.log(`  - ${u.name.padEnd(46, ' ')} ${String(u.words.length).padStart(3)} 词`));
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 条告警：`);
  warnings.slice(0, 20).forEach(w => console.log('  · ' + w));
}
if (fixes.length) {
  console.log(`\n✎ 例句断句修正 ${fixes.length} 处（仅例句生效的「假句号→逗号」规则，全部见 --show-fixes）：`);
  (process.argv.includes('--show-fixes') ? fixes : fixes.slice(0, 8)).forEach(f => {
    console.log(`  · [U${f.unit}] ${f.word}\n      - ${f.from}\n      + ${f.to}`);
  });
}
