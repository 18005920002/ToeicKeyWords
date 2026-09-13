#!/usr/bin/env node
/* 从 HuggingFace 词库生成 js/data.js
 *
 * 数据来源：
 *   1) kknono668/toeic-vocab-tw  data/toeic_vocabulary.json（CC BY-SA 4.0，繁中双语句库）
 *   2) nltk-data-hub/words       config=toeic → TOEIC Service List 1.2（1250 高频词，按 rank 排序）
 *      iamzhangship/fluency-ecdict-offline 提供该词表的纯文本快照 focus_word_sources/toeic.txt
 *   3) ECDICT（ecdict.sqlite）   提供 phonetic 音标字段（原词库无音标）
 *
 * 用法：
 *   node tools/build-data.mjs --src <原始文件目录> --db <ecdict.sqlite 路径> [--base js/data.js] [--out js/data.js]
 *   --src 目录需包含：toeic_vocabulary.json、tsl.txt、bsl.txt
 *   --base 人工原始词库（保留其中全部词条与音标），重复构建时请指向未改写的备份
 *   依赖 opencc-js（繁→简）：装到 tools/node_modules，或用环境变量 OPENCC_JS 指向 esm 入口
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- 参数 ---------- */
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SRC = path.resolve(arg('src', '.'));
const DB = arg('db', '');
const OUT = path.resolve(arg('out', path.join(ROOT, 'js', 'data.js')));
/* 基线词库：人工编写的原始 data.js，其中词条（含医疗主题、音标）一律保留 */
const BASE = path.resolve(arg('base', OUT));

/* ---------- opencc-js 解析（支持外部安装路径） ---------- */
async function loadConverter() {
  const candidates = [process.env.OPENCC_JS, 'opencc-js'].filter(Boolean);
  for (const spec of candidates) {
    try {
      const url = spec.startsWith('.') || path.isAbsolute(spec)
        ? pathToFileURL(path.resolve(spec)).href : spec;
      const mod = await import(url);
      const Converter = mod.Converter || mod.default?.Converter;
      if (Converter) return Converter({ from: 'twp', to: 'cn' }); // 繁→简，并做台式用语转换（軟體→软件）
    } catch (e) { /* 尝试下一个 */ }
  }
  throw new Error('未找到 opencc-js，请执行 npm i --prefix tools opencc-js 或设置 OPENCC_JS');
}

/* ---------- 数据集 → 主题的映射（id 沿用现有值，保证 localStorage 标记不丢） ---------- */
const TOPICS = [
  { cat: '辦公日常', id: 'business', name: '商务办公', icon: '💼', quota: 55 },
  { cat: '旅遊與交通', id: 'travel', name: '旅行交通', icon: '✈️', quota: 55 },
  { cat: '住宿與餐飲', id: 'shopping', name: '餐饮与住宿', icon: '🍽️', quota: 55 },
  { cat: 'medical' }, // 医疗类词库无对应主题，原样保留手工数据
  { cat: '金融與會計', id: 'finance', name: '金融与会计', icon: '💰', quota: 55 },
  { cat: '科技與技術支援', id: 'tech', name: '通信科技', icon: '💻', quota: 55 },
  { cat: '溝通互動', id: 'communication', name: '沟通互动', icon: '🗣️', quota: 45 },
  { cat: '行銷與銷售', id: 'sales', name: '行销与销售', icon: '📈', quota: 45 },
  { cat: '人力資源', id: 'hr', name: '人力资源', icon: '👥', quota: 45 },
  { cat: '採購與物流', id: 'logistics', name: '采购与物流', icon: '📦', quota: 45 },
  { cat: '營運管理', id: 'operations', name: '运营管理', icon: '🏢', quota: 45 },
  { cat: '一般專業', id: 'general', name: '通用专业', icon: '🎯', quota: 45 },
  { cat: '會議與簡報', id: 'meetings', name: '会议与演示', icon: '📊', quota: 40 },
  { cat: '客戶服務', id: 'service', name: '客户服务', icon: '🎧', quota: 40 },
  { cat: '法務合規與安全', id: 'legal', name: '法务合规与安全', icon: '⚖️', quota: 40 },
  { cat: '物業與不動產', id: 'realestate', name: '物业与不动产', icon: '🏠', quota: 40 },
];

const POS_CN = {
  noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.',
  preposition: 'prep.', conjunction: 'conj.', pronoun: 'pron.',
  interjection: 'int.', number: 'num.', auxiliary: 'v.', article: 'art.',
};

/* ---------- 工具函数 ---------- */
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function rankMap(p) {
  const m = new Map();
  if (!fs.existsSync(p)) return m;
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const w = line.trim().toLowerCase();
    if (w && !m.has(w)) m.set(w, i + 1); // 文件按 source rank 顺序存放
  });
  return m;
}

/** 只收录真正的单词/短语：排除 A be followed by B 这类占位写法与人名词条 */
function validEntry(e) {
  const w = (e.english_word || '').trim();
  if (!/^[A-Za-z][A-Za-z'’\-\. ]{1,29}$/.test(w)) return false;
  if (w.split(/\s+/).length > 3) return false;
  if (/(^|\s)[ABC](\s|$)/.test(w)) return false;
  const def = e.chinese_definition || '';
  if (/人名|公司名|地名|^指|姓氏/.test(def)) return false;
  const ex = (e.examples || []).find(x => x && x.english && x.chinese);
  return !!ex;
}

function pickExample(list) {
  const ok = (list || []).filter(x => x && x.english && x.chinese);
  if (!ok.length) return null;
  const fit = ok.find(x => x.english.length >= 25 && x.english.length <= 110);
  return fit || ok.sort((a, b) => a.english.length - b.english.length)[0];
}

function trimMeaning(def, conv) {
  let s = conv(def).replace(/\s+/g, ' ').trim();
  if (s.length <= 52) return s;
  const keep = [];
  let len = 0;
  for (const seg of s.split('；')) {
    if (keep.length && len + seg.length > 52) break;
    keep.push(seg); len += seg.length + 1;
  }
  return keep.join('；');
}

function posOf(e) {
  let list = (e.parts_of_speech || []).filter(Boolean);
  if (!list.length) list = (e.word_forms || []).map(f => f.part_of_speech).filter(Boolean);
  const seen = [];
  for (const p of list) { const c = POS_CN[p]; if (c && !seen.includes(c)) seen.push(c); }
  return seen.join('/');
}

/** 复数/过去式等屈折形式，若词库中已有同词性的原形，则不单独成卡（如 meetings / attended）
 *  -ing 不动：meeting、rating、booking 这类常作动词或名词独立成词 */
function lemmaForms(w) {
  const out = [];
  if (/ies$/.test(w)) out.push(w.slice(0, -3) + 'y');
  if (/(ses|xes|zes|ches|shes)$/.test(w)) out.push(w.slice(0, -2));
  if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) out.push(w.slice(0, -1));
  if (/ied$/.test(w)) out.push(w.slice(0, -3) + 'y');
  else if (/ed$/.test(w)) out.push(w.slice(0, -1), w.slice(0, -2));
  return [...new Set(out)].filter(x => x && x !== w);
}

function redundantInflection(e, poolByKey) {
  if (/\s/.test(e.english_word)) return false;
  const w = e.english_word.toLowerCase();
  const myPos = new Set((e.parts_of_speech || []).filter(Boolean));
  return lemmaForms(w).some(lem => {
    const hit = poolByKey.get(lem);
    if (!hit) return false;
    const itsPos = new Set((hit.parts_of_speech || []).filter(Boolean));
    // 词性信息缺失时一律当作同一词的变形剔除；否则要求与原形词性有交集
    return !myPos.size || !itsPos.size || [...myPos].some(p => itsPos.has(p));
  });
}

/* ECDICT 缺失音标的补充表（多为复合词与短语，音标按英式，与原有人工数据一致） */
const PHONETIC_FIX = {
  'coworker': '/ˈkəʊwɜːkə(r)/', 'laptop': '/ˈlæptɒp/', 'workplace': '/ˈwɜːkpleɪs/',
  'e-book': '/ˈiːbʊk/', 'login': '/ˈləʊɡɪn/', 'webpage': '/ˈwebpeɪdʒ/', 'spam': '/spæm/',
  'workforce': '/ˈwɜːkfɔːs/', 'affordable': '/əˈfɔːdəbl/', 'takeover': '/ˈteɪkəʊvə(r)/',
  'follow-up': '/ˈfɒləʊʌp/', 'front door': '/ˌfrʌnt ˈdɔː(r)/', 'be held': '/biː ˈheld/',
  'as requested': '/əz rɪˈkwestɪd/', 'meeting time': '/ˈmiːtɪŋ taɪm/',
  'attend a conference': '/əˈtend ə ˈkɒnfərəns/', 'arrange a conference': '/əˈreɪndʒ ə ˈkɒnfərəns/',
  'make a presentation': '/meɪk ə ˌprɪzenˈteɪʃn/', 'customer survey': '/ˈkʌstəmə ˈsɜːveɪ/',
  'serve a customer': '/sɜːv ə ˈkʌstəmə/', 'free of charge': '/friː əv ˈtʃɑːdʒ/',
  'dissatisfied': '/dɪˈsætɪsfaɪd/', 'vip': "/ˌviː aɪ ˈpiː/",
};
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'be', 'and', 'or', 'as']);

/* ---------- 词典：查 ECDICT 的音标与词频，并把它的私有字符规范成标准 IPA ---------- */
function normalizePhonetic(raw) {
  if (!raw) return '';
  let s = String(raw).split('\n')[0].trim();
  s = s.replace(/^[\/\[]|[\/\]]$/g, '');
  s = s.replace(/ә/g, 'ə')      // ECDICT 用西里尔字母当 schwa
       .replace(/є/g, 'ɛ')
       .replace(/і/g, 'i').replace(/յ/g, 'j')
       .replace(/ˑ|∶/g, 'ː').replace(/:/g, 'ː')
       .replace(/'/g, 'ˈ')
       .replace(/\bg\b/g, 'ɡ')
       .replace(/[;，,]+$/g, '').trim();
  if (!s || !/[a-zæɐɑɒbdfghi-jkmnoprst-vxyzɛəɪʊʌʃʒθðŋɡ]/i.test(s)) return '';
  return '/' + s + '/';
}

/** 返回 { phone, frq }：phone 为规范后 IPA，frq 为 ECDICT 词频排名（越小越常用）
 *  lookup 可多次调用，结果累加到同一组 map 上 */
function lookupDict(words, dbPath, acc) {
  const res = acc || { phone: new Map(), frq: new Map() };
  Object.entries(PHONETIC_FIX).forEach(([w, p]) => { if (!res.phone.has(w)) res.phone.set(w, p); });
  const todo = [...new Set(words.map(w => w.toLowerCase()))].filter(w => !res.phone.has(w) && !res.frq.has(w));
  if (!dbPath || !fs.existsSync(dbPath)) {
    console.warn('⚠ 未提供 ECDICT 数据库，音标与词频仅来自内置补充表与原有数据');
    return res;
  }
  const CHUNK = 300;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const inList = chunk.map(w => "'" + w.replace(/'/g, "''") + "'").join(',');
    const sql = `select word, phonetic, frq from entries where word in (${inList});`;
    const out = execFileSync('sqlite3', ['-noheader', '-separator', '\t', dbPath, sql], { encoding: 'utf8', maxBuffer: 1 << 26 });
    out.split(/\r?\n/).forEach(line => {
      const cols = line.split('\t');
      if (cols.length < 2) return;
      const w = (cols[0] || '').trim().toLowerCase();
      if (!w) return;
      const p = normalizePhonetic(cols[1]);
      if (p && !res.phone.has(w)) res.phone.set(w, p);
      const f = parseInt(cols[2], 10);
      if (!res.frq.has(w)) res.frq.set(w, Number.isFinite(f) && f > 0 ? f : Infinity);
    });
  }
  return res;
}

/* ---------- 主流程 ---------- */
const conv = await loadConverter();
const entries = readJson(path.join(SRC, 'toeic_vocabulary.json'));
const tsl = rankMap(path.join(SRC, 'tsl.txt'));
const bsl = rankMap(path.join(SRC, 'bsl.txt'));

/* 基线 data.js：保留其中的人工词条，用 --base 指向未经脚本改写的版本 */
let existing = [];
if (fs.existsSync(BASE)) {
  const code = fs.readFileSync(BASE, 'utf8');
  if (/由 tools\/build-data\.mjs 生成/.test(code)) {
    console.warn('⚠ 基线文件本身是生成结果，重复运行只会累加，请用 --base 指向人工原始 data.js');
  }
  existing = new Function('window', code + '\nreturn window.BUILTIN_TOPICS;')({}) || [];
}
const byExistingId = new Map(existing.map(t => [t.id, t]));

/** 词频优先：TOEIC Service List / Business Service List 在表内权重最高，其次星级 */
function scoreOf(e) {
  const w = e.english_word.toLowerCase();
  let s = (e.star_rating || 0) * 10;
  if (tsl.has(w)) s += 1000 - tsl.get(w) / 10;
  else if (bsl.has(w)) s += 300 - bsl.get(w) / 10;
  return s;
}

const pool = new Map(); // 全局按词去重，保留得分最高的词条
for (const e of entries) {
  if ((e.star_rating || 0) < 3 || !validEntry(e)) continue;
  const key = e.english_word.trim().toLowerCase();
  const cur = pool.get(key);
  if (!cur || scoreOf(e) > scoreOf(cur)) pool.set(key, e);
}
const poolByKey = new Map(pool); // 先判定再删除，避免边遍历边修改造成级联误删
for (const [key, e] of poolByKey) {
  if (redundantInflection(e, poolByKey)) pool.delete(key);
}

/* 候选词一次性拉取音标与词频：词频用于同级星级下的排序 */
const dict = lookupDict([...pool.keys()], DB);
const frqOf = e => {
  const w = e.english_word.trim().toLowerCase();
  return /\s/.test(w) ? Infinity : (dict.frq.get(w) ?? Infinity);
};

const taken = new Set();
existing.forEach(t => (t.words || []).forEach(w => taken.add(String(w.word).trim().toLowerCase())));

const result = [];
for (const cfg of TOPICS) {
  if (!cfg.id) { // 原样保留的主题
    const keep = byExistingId.get('medical');
    if (keep) result.push({ id: keep.id, name: keep.name, icon: keep.icon, words: keep.words });
    continue;
  }
  const seed = (byExistingId.get(cfg.id) || {}).words || [];
  const words = seed.slice();
  const cand = [...pool.values()]
    .filter(e => conv(e.category) === conv(cfg.cat) && !taken.has(e.english_word.toLowerCase()))
    .sort((a, b) => scoreOf(b) - scoreOf(a) || frqOf(a) - frqOf(b) || a.english_word.localeCompare(b.english_word));
  for (const e of cand) {
    if (words.length >= cfg.quota) break;
    const ex = pickExample(e.examples);
    const key = e.english_word.trim().toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    words.push({
      word: e.english_word.trim(),
      phonetic: '', // 稍后统一回填
      pos: posOf(e) || (/\s/.test(e.english_word) ? 'phr.' : ''),
      meaning: trimMeaning(e.chinese_definition, conv),
      example: ex.english.trim(),
      exampleCn: conv(ex.chinese).trim(),
    });
  }
  result.push({ id: cfg.id, name: cfg.name, icon: cfg.icon, words });
}

/* 音标回填：原有人工音标保留，新词查 ECDICT；短语查不到则按实词拼接 */
const needWords = new Set();
for (const t of result) {
  for (const w of t.words) {
    if (w.phonetic) continue;
    const lw = w.word.toLowerCase();
    needWords.add(lw);
    if (/\s/.test(lw)) {
      lw.split(/\s+/).filter(x => x && !FUNCTION_WORDS.has(x)).forEach(x => needWords.add(x));
    }
  }
}
lookupDict([...needWords], DB, dict); // 补充候选词之外的短语成分
let filled = 0, missing = [];
for (const t of result) {
  for (const w of t.words) {
    if (w.phonetic) continue;
    let p = dict.phone.get(w.word.toLowerCase()) || '';
    if (!p && /\s/.test(w.word)) {
      // 短语：查不到整条时按实词拼接，跳过 a/the/of 等虚词
      const parts = w.word.split(/\s+/).filter(x => !FUNCTION_WORDS.has(x.toLowerCase()));
      const ipa = parts.map(x => (dict.phone.get(x.toLowerCase()) || '').replace(/^\/|\/$/g, ''));
      if (parts.length && ipa.every(Boolean)) p = '/' + ipa.join(' ') + '/';
    }
    w.phonetic = p;
    if (p) filled++; else missing.push(w.word);
  }
}

/* ---------- 输出 ---------- */
function esc(s) { return JSON.stringify(String(s == null ? '' : s)); }
const lines = [];
lines.push('/* 内置托业词汇数据：按主题分类');
lines.push(' * 字段：word 单词 | phonetic 音标 | pos 词性 | meaning 中文释义 | example 英文例句 | exampleCn 例句翻译');
lines.push(' * 由 tools/build-data.mjs 生成：kknono668/toeic-vocab-tw（CC BY-SA 4.0）+ TOEIC Service List 1.2 排序 + ECDICT 音标');
lines.push(' */');
lines.push('window.BUILTIN_TOPICS = [');
for (const t of result) {
  lines.push('  {');
  lines.push(`    id: ${esc(t.id)}, name: ${esc(t.name)}, icon: ${esc(t.icon)},`);
  lines.push('    words: [');
  for (const w of t.words) {
    lines.push('      { ' + [
      `word: ${esc(w.word)}`, `phonetic: ${esc(w.phonetic)}`, `pos: ${esc(w.pos)}`,
      `meaning: ${esc(w.meaning)}`, `example: ${esc(w.example)}`, `exampleCn: ${esc(w.exampleCn)}`,
    ].join(', ') + ' },');
  }
  lines.push('    ]');
  lines.push('  },');
}
lines[lines.length - 1] = lines[lines.length - 1].replace(/},$/, '}');
lines.push('];');
fs.writeFileSync(OUT, lines.join('\n') + '\n', { encoding: 'utf8' });

const total = result.reduce((n, t) => n + t.words.length, 0);
console.log(`✓ 生成 ${OUT}`);
console.log(`  主题 ${result.length} 个 / 词条 ${total} 个 / 新补音标 ${filled} 个`);
result.forEach(t => console.log(`  - ${t.name.padEnd(10, ' ')} ${String(t.words.length).padStart(3)} 词`));
if (missing.length) console.log(`  ⚠ 仍无音标 ${missing.length} 个：${missing.slice(0, 15).join(', ')}${missing.length > 15 ? ' …' : ''}`);
