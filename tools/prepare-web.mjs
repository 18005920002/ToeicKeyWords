#!/usr/bin/env node
/* 生成 Capacitor 的 Web 目录 www/：只拷贝运行真正需要的文件，
 * 把 docs/ tools/ samples/ README、截图、.nojekyll 等开发期文件挡在 APK 之外。
 * 音频 audio/ 全量拷进去 —— 这样打出的 APK 装好即完全离线，不依赖任何托管。
 * 用法：node tools/prepare-web.mjs  （由 npm run prepare:web 调用）
 */
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'www');

/* 需要进 APK 的文件 / 目录（相对仓库根） */
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];
const DIRS = ['css', 'js', 'icons', 'audio'];

/* 每次从零开始，避免上一次的残留混进包里 */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* 目录体积粗略求和，只为打印日志 */
function sizeOf(p) {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const name of readdirSync(p)) total += sizeOf(join(p, name));
  return total;
}

function copy(srcRel) {
  const src = join(ROOT, srcRel);
  if (!existsSync(src)) {
    console.warn(`[prepare-web] 跳过缺失项：${srcRel}`);
    return 0;
  }
  const dst = join(OUT, srcRel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  return sizeOf(src);
}

let bytes = 0;
for (const f of FILES) bytes += copy(f);
for (const d of DIRS) bytes += copy(d);

console.log(`[prepare-web] 已生成 www/ —— 约 ${(bytes / 1048576).toFixed(1)} MB`);
