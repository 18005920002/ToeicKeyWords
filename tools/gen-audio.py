#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""按 audio/jobs.json 批量合成发音音频（由 tools/gen-audio.mjs 调用，也可单独运行）

依赖：py -m pip install -U edge-tts      # 免费的 Microsoft 神经语音，无需 API Key，需要联网
用法：py tools/gen-audio.py --jobs audio/jobs.json --dir audio --concurrency 6 [--force]

每个任务自带 voice 字段，所以美音（en-US-*）与英音（en-GB-*）可以混在同一份 jobs.json 里一次跑完。

若本机代理在系统设置里登记为 https://127.0.0.1:port，安装/访问会报
「check_hostname requires server_hostname」，显式指定 http scheme 即可绕过：
  $env:HTTPS_PROXY='http://127.0.0.1:7897'; py -m pip install -U edge-tts
用 tools/gen-audio.mjs --proxy http://127.0.0.1:7897 调用本脚本时已自动处理。

设计要点：
  · 只合成原速。慢速在浏览器里用 playbackRate + preservesPitch 实现，语调轮廓保持不变，
    比再合成一份慢速音频自然；
  · 已存在的 mp3 默认跳过，所以中断后重跑只补差集；
  · 单条失败重试 3 次（edge-tts 偶发 503 / 连接重置），最终失败的任务汇总打印。
"""

import argparse
import asyncio
import json
import os
import sys

try:
    import edge_tts
except ImportError:
    sys.exit("缺少 edge-tts，请先执行：py -m pip install -U edge-tts")

MIN_BYTES = 800          # 小于这个体积视为残缺文件
RETRIES = 3


def parse_args():
    p = argparse.ArgumentParser(description="edge-tts 批量合成")
    p.add_argument("--jobs", required=True, help="任务清单 json（tools/gen-audio.mjs 产出）")
    p.add_argument("--dir", required=True, help="音频输出目录")
    p.add_argument("--concurrency", type=int, default=6, help="并发数，默认 6")
    p.add_argument("--force", action="store_true", help="已存在的文件也重新合成")
    return p.parse_args()


def existing(path, force):
    if force or not os.path.exists(path):
        return False
    try:
        return os.path.getsize(path) >= MIN_BYTES
    except OSError:
        return False


async def synth_one(job, out_dir, force, sem, stats):
    path = os.path.join(out_dir, job["file"])
    if existing(path, force):
        stats["skip"] += 1
        return True
    text = job["text"]
    voice = job.get("voice") or "en-US-AriaNeural"
    async with sem:
        for attempt in range(1, RETRIES + 1):
            tmp = path + ".part"
            try:
                await edge_tts.Communicate(text, voice).save(tmp)
                if os.path.getsize(tmp) < MIN_BYTES:
                    raise RuntimeError("输出体积过小")
                os.replace(tmp, path)
                stats["ok"] += 1
                done = stats["ok"] + stats["skip"] + stats["fail"]
                if done % 50 == 0 or done == stats["total"]:
                    print("  … %d/%d（成功 %d / 跳过 %d / 失败 %d）"
                          % (done, stats["total"], stats["ok"], stats["skip"], stats["fail"]))
                return True
            except Exception as exc:              # 网络抖动、限流等，重试后再放弃
                if os.path.exists(tmp):
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
                if attempt == RETRIES:
                    stats["fail"] += 1
                    stats["errors"].append((job["file"], "%s: %s" % (type(exc).__name__, exc)))
                    print("  × %s — %s" % (job["file"], exc), file=sys.stderr)
                    return False
                await asyncio.sleep(1.5 * attempt)


async def run(jobs, out_dir, concurrency, force):
    sem = asyncio.Semaphore(max(1, concurrency))
    stats = {"total": len(jobs), "ok": 0, "skip": 0, "fail": 0, "errors": []}
    await asyncio.gather(*[synth_one(j, out_dir, force, sem, stats) for j in jobs])
    return stats


def main():
    args = parse_args()
    with open(args.jobs, encoding="utf-8") as f:
        jobs = json.load(f)
    os.makedirs(args.dir, exist_ok=True)

    pending = [j for j in jobs if not existing(os.path.join(args.dir, j["file"]), args.force)]
    voices = sorted({j.get("voice") or "en-US-AriaNeural" for j in jobs})
    print("· 任务 %d 条，其中待合成 %d 条（并发 %d，语音 %s）"
          % (len(jobs), len(pending), args.concurrency, " / ".join(voices)))
    if not pending:
        print("· 全部已存在，无需合成")
        return 0

    stats = asyncio.run(run(pending, args.dir, args.concurrency, args.force))
    print("· 完成：新合成 %d / 已存在跳过 %d / 失败 %d"
          % (stats["ok"], len(jobs) - len(pending), stats["fail"]))
    if stats["errors"]:
        print("失败清单（多为网络抖动，重跑本脚本即可续补）：", file=sys.stderr)
        for name, err in stats["errors"][:20]:
            print("  · %s — %s" % (name, err), file=sys.stderr)
    return 0 if stats["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
