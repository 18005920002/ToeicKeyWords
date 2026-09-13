#!/usr/bin/env node
/* 预生成发音音频（Layer 3）：把词条与例句交给神经 TTS 合成 mp3，运行时直接播放
 *
 * 为什么需要：浏览器 speechSynthesis 的自然度完全取决于系统装了哪种语音，桌面语音逐词停顿、
 * 没有连读弱读；神经语音（Microsoft Online/Natural 系列）才有接近真人的语流。预生成后：
 *   · 发音不再依赖用户系统里有什么语音；
 *   · 慢速走 playbackRate + preservesPitch，保留原语者的语调轮廓（比重新合成慢速自然得多）。
 *
 * 用法：
 *   py -m pip install edge-tts          # 一次性安装（合成引擎，免费、无需 API Key，需要联网）
 *   node tools/gen-audio.mjs            # 全量生成 30 个单元，美音 + 英音都出（1200 词条 × 2 句种 × 2 口音）
 *   node tools/gen-audio.mjs --unit 1 --unit 5      # 只生成指定单元
 *   node tools/gen-audio.mjs --accent gb            # 只补英音（--accent us / both 同理，默认 both）
 *   node tools/gen-audio.mjs --words-only           # 只生成单词音频
 *   node tools/gen-audio.mjs --no-run               # 只产出 audio/jobs.json，交给别的引擎合成
 *   node tools/gen-audio.mjs --voice-us en-US-AvaMultilingualNeural --voice-gb en-GB-SoniaNeural --concurrency 4
 *   node tools/gen-audio.mjs --proxy http://127.0.0.1:7897   # 需要走本地代理（Clash 等）时
 *
 * 关于口音：美音默认 en-US-AriaNeural，英音默认 en-GB-RyanNeural，两者分文件存放，互不覆盖；
 * 已存在的文件一律跳过，所以「先 --accent gb 补 unit-1 验证、再跑全量」是安全的增量操作。
 *
 * 关于 --proxy：合成要访问 Microsoft 语音端点，国内通常需代理。系统代理若登记为
 * https://127.0.0.1:port，旧版 pip / urllib3 会对代理本身再做一次 TLS 而抛
 * 「check_hostname requires server_hostname」（新版 urllib3 则直接忽略该代理）；
 * 这里统一改写成 http://（CONNECT 隧道），只影响本脚本派生的 Python 子进程，不改动任何全局配置。
 *
 * 产物：
 *   audio/<单元>__<词条>__<hash>__w-us.mp3   美音单词音频（历史文件 __w.mp3 会被自动改名成这个）
 *   audio/<单元>__<词条>__<hash>__e-us.mp3   美音例句音频
 *   audio/<单元>__<词条>__<hash>__w-gb.mp3   英音单词音频
 *   audio/<单元>__<词条>__<hash>__e-gb.mp3   英音例句音频
 *   js/audio-manifest.js                  清单：window.AUDIO_MANIFEST[key] = { us: { w, e }, gb: { w, e } }
 *
 * 说明：只覆盖内置词库 js/data.js；导入的自定义词库在浏览器 localStorage 里，由合成语音兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TtsText = createRequire(import.meta.url)('../js/tts-text.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes('--' + name); }
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === '--' + name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

/* Windows 下环境变量不区分大小写，但 JS 对象键区分：先把同名变体全清再写回，
 * 否则 urllib3 / aiohttp 会读到残留的 https:// 代理而报「HTTPS proxies ... are not supported」 */
const PROXY_VARS = ['http_proxy', 'https_proxy', 'all_proxy'];
function setProxyVar(env, name, value) {
  Object.keys(env).forEach(k => { if (k.toLowerCase() === name) delete env[k]; });
  env[name] = value;
  env[name.toUpperCase()] = value;
}

function proxyEnv() {
  const raw = arg('proxy', process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || '');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };   // 否则中文进度在 PowerShell 下会乱码
  if (!raw) return env;
  const url = /^https:\/\//i.test(raw) ? raw.replace(/^https:\/\//i, 'http://') : raw;
  PROXY_VARS.forEach(name => setProxyVar(env, name, url));
  return env;
}

const VOICE = { us: arg('voice-us', arg('voice', 'en-US-AriaNeural')), gb: arg('voice-gb', 'en-GB-RyanNeural') };
const OUT_DIR = path.resolve(arg('out', path.join(ROOT, 'audio')));
const MANIFEST = path.resolve(arg('manifest', path.join(ROOT, 'js', 'audio-manifest.js')));
const CONCURRENCY = Number(arg('concurrency', 6));
const PYTHON = arg('python', process.platform === 'win32' ? 'py' : 'python3');
const WORDS_ONLY = hasFlag('words-only');
const SENTENCES_ONLY = hasFlag('sentences-only');
const NO_RUN = hasFlag('no-run');
const FORCE = hasFlag('force');
const UNITS = argAll('unit').map(u => String(u).toLowerCase());

/* 本次要生成哪几种口音：--accent us|gb|both（默认 both），uk / british 等写法归到 gb */
const ACC_ALIAS = { us: 'us', american: 'us', en: 'us', gb: 'gb', uk: 'gb', british: 'gb', england: 'gb' };
const ACCENTS = (() => {
  const want = String(arg('accent', 'both')).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!want.length || want.indexOf('both') > -1) return ['us', 'gb'];
  const list = ['us', 'gb'].filter(acc => want.indexOf(acc) > -1 || want.some(w => ACC_ALIAS[w] === acc));
  if (!list.length) {
    console.error(`× --accent ${arg('accent', '')} 无法识别，可选：us / gb / both`);
    process.exit(1);
  }
  return list;
})();

/* ---------- 读取词库 ---------- */
function loadTopics() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8'), sandbox);
  return sandbox.window.BUILTIN_TOPICS || [];
}

/* 文件名安全化：与 Store.wordKey 一致地按「单元id::小写词条」定位，重复时靠 hash 后缀区分 */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
function safe(s) {
  return String(s).trim().toLowerCase()
    .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'word';
}

const topics = loadTopics();

/* --unit 支持三种写法：1 / unit-1 / 单英文标题片段（如 --unit office） */
function unitHit(t, u) {
  if (t.id === u || t.id === 'unit-' + u) return true;
  const m = String(t.name).match(/^Unit\s*(\d+)/i);
  if (m && /^\d+$/.test(u) && Number(m[1]) === Number(u)) return true;
  return !/^\d+$/.test(u) && String(t.name).toLowerCase().includes(u);
}
const selected = UNITS.length ? topics.filter(t => UNITS.some(u => unitHit(t, u))) : topics;
UNITS.forEach(u => {
  if (!topics.some(t => unitHit(t, u))) console.error(`× --unit ${u} 没有匹配到任何单元（现有：${topics.map(t => t.id).join(', ')}）`);
});
if (UNITS.length && !selected.length) process.exit(1);

/* 文件名为「词库 + 命名规则」的确定函数，所以清单可以按磁盘上已有文件全量重建 */
function entryOf(t, w) {
  const key = t.id + '::' + w.word.trim().toLowerCase();
  const stem = `${safe(t.id)}__${safe(w.word)}__${hash(key).slice(0, 4)}`;
  const files = {};
  ['us', 'gb'].forEach(acc => {
    files[acc] = { wFile: `${stem}__w-${acc}.mp3`, eFile: `${stem}__e-${acc}.mp3` };
  });
  return { key, stem, unit: t.id, word: w.word, example: w.example, files };
}
const allEntries = [];
topics.forEach(t => t.words.forEach(w => { if (w.word) allEntries.push(entryOf(t, w)); }));

/* 一次性迁移：早期只有一种口音、文件名没有后缀，把 __w.mp3 / __e.mp3 认作美音改名，
 * 这样加英音不必重新合成已有的美音（只改文件名，内容不变） */
let renamed = 0;
if (fs.existsSync(OUT_DIR)) {
  allEntries.forEach(e => {
    [['w', e.files.us.wFile], ['e', e.files.us.eFile]].forEach(([kind, now]) => {
      if (kind === 'e' && !e.example) return;
      const legacy = path.join(OUT_DIR, `${e.stem}__${kind}.mp3`);
      const dest = path.join(OUT_DIR, now);
      if (fs.existsSync(legacy) && !fs.existsSync(dest)) { fs.renameSync(legacy, dest); renamed++; }
    });
  });
  if (renamed) console.log(`✓ 历史音频改名 ${renamed} 个：__w.mp3/__e.mp3 → __w-us.mp3/__e-us.mp3（未重新合成）`);
}

/* 与运行时 js/tts.js 完全一致的文本管线：先词库级修正再口语化改写，保证预生成音频
 * 和回退到合成音时的读法不会分叉 */
function speechText(s, asExample) {
  return TtsText.forSpeech(TtsText.correct(s, { example: !!asExample }));
}

const jobs = [];
selected.forEach(t => t.words.forEach(w => {
  if (!w.word) return;
  const e = entryOf(t, w);
  ACCENTS.forEach(acc => {
    if (!SENTENCES_ONLY) {
      jobs.push({ file: e.files[acc].wFile, key: e.key, kind: 'word', accent: acc, text: speechText(w.word, false), voice: VOICE[acc] });
    }
    if (!WORDS_ONLY && w.example) {
      jobs.push({ file: e.files[acc].eFile, key: e.key, kind: 'example', accent: acc, text: speechText(w.example, true), voice: VOICE[acc] });
    }
  });
}));

if (!jobs.length) {
  console.error('× 没有待合成的音频（现有单元：' + topics.map(t => t.id).join(', ') + '）');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const jobsFile = path.join(OUT_DIR, 'jobs.json');
fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 0), 'utf8');
console.log(`✓ 任务清单 ${path.relative(ROOT, jobsFile)}：${jobs.length} 个音频（单元 ${selected.map(t => t.id).join('/') || '全部'}，口音 ${ACCENTS.join('+')}，语音 ${ACCENTS.map(a => `${a}:${VOICE[a]}`).join(' / ')}）`);

/* ---------- 交给合成引擎 ---------- */
if (!NO_RUN) {
  const py = path.join(ROOT, 'tools', 'gen-audio.py');
  const r = spawnSync(PYTHON, [
    py,
    '--jobs', jobsFile,
    '--dir', OUT_DIR,
    '--concurrency', String(CONCURRENCY),
    ...(FORCE ? ['--force'] : []),
  ], { stdio: 'inherit', cwd: ROOT, env: proxyEnv() });
  if (r.error) {
    console.error(`× 调用 ${PYTHON} 失败：${r.error.message}`);
    console.error('  需要 Python 3 + edge-tts：py -m pip install edge-tts');
    console.error('  只想先看任务清单可加 --no-run；非 Windows 请用 --python python3 指定解释器。');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('× 合成进程非 0 退出；若上面有「Unable to create process」，说明 py 解析到了一个起不来的解释器，');
    console.error('  用 --python 指定可用的解释器，例如：node tools/gen-audio.mjs --python "C:\\path\\to\\python.exe" --accent gb');
    process.exit(r.status);
  }
}

/* ---------- 清单按磁盘实况全量重建（分批、分口音生成不会丢掉已完成的部分） ---------- */
const written = {};
const perAccent = { us: 0, gb: 0 };
allEntries.forEach(e => {
  const o = {};
  ['us', 'gb'].forEach(acc => {
    const f = {};
    if (fs.existsSync(path.join(OUT_DIR, e.files[acc].wFile))) f.w = e.files[acc].wFile;
    if (e.example && fs.existsSync(path.join(OUT_DIR, e.files[acc].eFile))) f.e = e.files[acc].eFile;
    if (!f.w && !f.e) return;
    o[acc] = f;
    perAccent[acc]++;
  });
  if (o.us || o.gb) written[e.key] = o;
});

/* 本轮任务里仍未落到磁盘上的：多为 --no-run、网络失败或只跑了部分单元 */
const stillMissing = jobs.filter(j => !fs.existsSync(path.join(OUT_DIR, j.file))).length;

const totalBytes = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.mp3'))
  .reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);

const head = '/* 预生成发音音频清单：由 tools/gen-audio.mjs 生成，请勿手工编辑\n' +
  ' * 结构：{ "<单元id>::<小写词条>": { us: { w: 美音单词, e: 美音例句 }, gb: { w: 英音单词, e: 英音例句 } } }，文件位于 audio/ 下。\n' +
  ' * 某口音缺失时，js/tts.js 会退回浏览器 speechSynthesis，并按口音挑 en-GB / en-US 语音。\n' +
  ` * 本次生成语音：美音 ${VOICE.us} / 英音 ${VOICE.gb}\n */\n`;
fs.writeFileSync(MANIFEST, head + 'window.AUDIO_MANIFEST = ' + JSON.stringify(written, null, 0) + ';\n', 'utf8');

const covered = Object.keys(written).length;
console.log(`✓ 清单 ${path.relative(ROOT, MANIFEST)}：覆盖 ${covered} / ${allEntries.length} 个词条（美音 ${perAccent.us} 条 / 英音 ${perAccent.gb} 条）`);
console.log(`  audio/ 目录共 ${(totalBytes / 1048576).toFixed(1)} MB${stillMissing ? `，另有 ${stillMissing} 个任务尚未合成（重跑本脚本可补齐）` : ''}`);
if (NO_RUN) console.log('  （--no-run：未合成，把 jobs.json 交给其它 TTS 引擎后再跑一次不带 --no-run 的本脚本即可回填清单）');
