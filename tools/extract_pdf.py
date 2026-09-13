# -*- coding: utf-8 -*-
"""从《新托业词汇本领书(第3版)》PDF 抽取词库, 输出 Markdown。

只整理各 Unit 的词条(Part A / Part B), 字段: 词条 / 音标 / 词性 /
英文注释 / 中文注释 / 英文例句 / 中文例句。Drills / Answers / Cross Word /
Exercise 一律跳过(靠"每 Part 序号 1→20 递增"定位真实词条, 噪声编号自动忽略)。

用法:  py tools/extract_pdf.py [--out docs/托业词汇词库.md] [--pdf docs/新托业词汇本领书3rd.pdf]
依赖:  pypdf (py -m pip install pypdf)
"""
import re
import sys
import argparse
from pypdf import PdfReader

NEUTRAL = set("0123456789 \t，。、；：！？（）()［］[]《》“”‘’\"'·…—-/.&%$#@*+=~^_|犤犡")


def split_by_script(s):
    """按汉字/非汉字拆分为(英文部分, 中文部分), 标点/数字/空格就近归入前一段。
    用于多义词, 保证“英文注释”列只含英文、“中文注释”列只含中文。"""
    s = s.replace("\u3000", " ")
    lat, han, cur, buf = [], [], None, ""

    def emit(c, b):
        b = re.sub(r"\s+", " ", b).strip()
        if b:
            (han if c == "C" else lat).append(b)

    for ch in s:
        if HAN(ch):
            sc = "C"
        elif ch.isspace() or ch in NEUTRAL:
            sc = None
        else:
            sc = "L"
        if sc is None:
            if cur is None:
                cur = "L"
            buf += ch
        else:
            if cur is not None and sc != cur:
                emit(cur, buf)
                buf = ""
            cur = sc
            buf += ch
    if cur is not None:
        emit(cur, buf)
    return " ".join(lat).strip(), " ".join(han).strip()


HAN = lambda ch: "\u4e00" <= ch <= "\u9fff"
POS_TOKEN = r"(?:n|v|vt|vi|adj|adv|prep|pron|conj|num|int|aux|art|a|ad|phr|vr)\."
POS_RE = re.compile(
    r"^(" + POS_TOKEN + r"(?:\s*/\s*" + POS_TOKEN + r")*)\s*(.*)$", re.I)
SENSE_RE = re.compile(r"^(?:[（(]\s*\d\s*[)）]\s*)+")
ENTRY_RE = re.compile(r"^(\d{1,3})\.\s+(.*)$")
UNIT_RE = re.compile(r"^Unit\s*(\d+)\s*[　\s]?(.*)$")
PART_RE = re.compile(r"^Part\s+([AB])\s*$")
STOP_RE = re.compile(r"^(Drills|Answers|Cross\s*Word|Exercise)\b")


def first_han(s):
    for i, ch in enumerate(s):
        if HAN(ch):
            return i
    return -1


def clean(s):
    s = s.replace("\u3000", " ").replace("\t", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def fix_wrap(s):
    # 修复跨行的断词 experi-\nences -> experiences（仅在字母-空格-字母且原处有连字符换行时）
    return re.sub(r"(?<=[A-Za-z])-\s+(?=[A-Za-z])", "", s)


def is_noise(s):
    t = s.strip()
    return (t == "" or t == "新托业词汇本领书"
            or re.fullmatch(r"\d+[\s　]*", t) is not None
            or re.fullmatch(r"[IVX]{1,5}[\s　]*", t) is not None
            or t in ("Across", "Down"))


def split_def(head):
    """head: 已去序号的释义行 -> (word, ipa, pos, en_def, cn_def, multi)"""
    multi = False
    m = SENSE_RE.match(head)
    if m:
        multi = True
        head = head[m.end():]
    m = re.match(r"^(.+?)\s*/\s*(.+?)\s*/\s*(.*)$", head)
    if m:
        word, ipa, rest = m.group(1).strip(), m.group(2).strip(), m.group(3)
    else:
        # 无音标（缩写类）: 先按 '=' 拆缩写与展开，再按首汉字拆中文
        ipa = ""
        if "=" in head:
            word, head = (x.strip() for x in head.split("=", 1))
        else:
            word = head.strip()
        idx0 = first_han(head)
        rest = head[idx0:] if idx0 > 0 else ""
        if idx0 > 0:
            word = clean(head[:idx0])
        m2 = re.match(r"^(.+?)\s+((?:" + POS_TOKEN + r").*)$", rest)
        if m2:
            rest = m2.group(2)
    if re.search(r"[（(]\s*\d\s*[)）]", rest):
        multi = True
    pm = POS_RE.match(rest)
    if pm:
        pos = pm.group(1).replace(" ", "")
        body = pm.group(2)
    else:
        pos, body = "", rest
        mp = re.search(r"\b(?:n|v|vt|vi|adj|adv|prep|pron|conj|num|int|aux|art|phr|vr)\.", body)
        if mp:
            pos = body[mp.start():mp.end()].replace(" ", "")
    if multi:
        en_def, cn_def = split_by_script(body)
    else:
        idx = first_han(body)
        if idx < 0:
            en_def, cn_def = clean(body), ""
        else:
            en_def, cn_def = clean(body[:idx]), clean(body[idx:])
    return word, ipa, pos, fix_wrap(en_def), cn_def, multi


def split_example(ex):
    idx = first_han(ex)
    if idx < 0:
        return clean(ex), ""
    return fix_wrap(clean(ex[:idx])), clean(ex[idx:])


def _has_marker(ln):
    # 只剥 ASCII 空白, 保留 U+3000 以判定例句行首锚点
    return ln.lstrip(" \t\r\x0b\x0c").startswith("\u3000")


def _strip_marker(ln):
    return re.sub(r"^[ \t\r\u3000]+", "", ln)


def parse_entry(entry_lines):
    # 用行首全角空格(U+3000)定位例句起点
    k = next((i for i, ln in enumerate(entry_lines) if _has_marker(ln)), None)
    if k is None:
        def_lines, ex_lines = entry_lines, []
    else:
        def_lines = entry_lines[:k]
        ex_lines = [_strip_marker(entry_lines[k])] + entry_lines[k + 1:]
    head = " ".join(clean(l) for l in def_lines if not is_noise(l))
    head = re.sub(r"^\d{1,3}\.\s*", "", head).strip()
    word, ipa, pos, en_def, cn_def, multi = split_def(head) if head else \
        ("", "", "", "", "", False)
    ex_text = " ".join(clean(l) for l in ex_lines if not is_noise(l))
    ex_en, ex_cn = split_example(ex_text) if ex_text else ("", "")
    ipa = "/" + ipa + "/" if ipa else ""
    need = []
    if multi: need.append("多义")
    if not ipa: need.append("缺音标")
    if not pos: need.append("缺词性")
    if not cn_def: need.append("缺中文注释")
    if not ex_en: need.append("缺例句")
    return dict(word=word, ipa=ipa, pos=pos, en=en_def, cn=cn_def,
                ex_en=ex_en, ex_cn=ex_cn, need=need)


def extract(pdf):
    rd = PdfReader(pdf)
    lines = []
    for pg in rd.pages:
        lines.extend((pg.extract_text() or "").split("\n"))

    units = {}      # n -> {"title": str, "parts": {"A":[..], "B":[..]}}
    cur_unit = None
    cur_part = None
    expected = None
    started = False
    buf = []
    order = []

    def flush():
        nonlocal buf
        if buf and cur_unit is not None and cur_part is not None:
            units[cur_unit]["parts"][cur_part].append(parse_entry(buf))
        buf = []

    for raw in lines:
        um = UNIT_RE.match(raw)
        if um:
            n = int(um.group(1))
            if n not in units:
                units[n] = {"title": clean(um.group(2)), "parts": {"A": [], "B": []}}
                order.append(n)
            cur_unit = n
            continue
        pm = PART_RE.match(raw)
        if pm:
            started = True
            flush()
            cur_part = pm.group(1)
            expected = 1
            continue
        if STOP_RE.match(raw.strip()):
            flush()
            cur_part = None
            continue
        if not started or cur_unit is None:
            continue
        em = ENTRY_RE.match(raw)
        if em and cur_part is not None and expected is not None:
            if int(em.group(1)) == expected:
                flush()
                buf = [em.group(2)]
                expected += 1
                continue
        if cur_part is not None:
            if not is_noise(raw):
                buf.append(raw)
    flush()
    return units, order


def md_cell(s):
    return s.replace("|", "\\|").replace("\n", " ")


def to_markdown(units, order):
    out = ["# 新托业词汇本领书（第 3 版）· 词库", ""]
    out += ["> 按 Unit 整理词条（Part A / Part B），字段：词条 / 音标 / 词性 / "
            "英文注释 / 中文注释 / 例句 / 例句译文；不含 Drills、Answers、"
            "Cross Word、Exercise 等练习部分。", ""]
    total = 0
    for n in sorted(order):
        u = units[n]
        out.append(f"## Unit {n}　{u['title']}")
        out.append("")
        for part in ("A", "B"):
            rows = u["parts"][part]
            if not rows:
                continue
            out.append(f"### Unit {n} · Part {part}（{len(rows)} 词）")
            out.append("")
            out.append("| # | 词条 | 音标 | 词性 | 英文注释 | 中文注释 | 例句 | 例句译文 |")
            out.append("|---|---|---|---|---|---|---|---|")
            for i, r in enumerate(rows, 1):
                out.append("| {} | {} | {} | {} | {} | {} | {} | {} |".format(
                    i, md_cell(r["word"]), md_cell(r["ipa"]), md_cell(r["pos"]),
                    md_cell(r["en"]), md_cell(r["cn"]),
                    md_cell(r["ex_en"]), md_cell(r["ex_cn"])))
                total += 1
            out.append("")
    return "\n".join(out) + "\n", total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default="docs/新托业词汇本领书3rd.pdf")
    ap.add_argument("--out", default="docs/托业词汇词库.md")
    ap.add_argument("--review", default="docs/_extract_review.md")
    a = ap.parse_args()

    units, order = extract(a.pdf)
    md, total = to_markdown(units, order)
    open(a.out, "w", encoding="utf-8").write(md)

    rev = ["# 抽取复核清单", "",
           f"- Unit 数: {len(order)} / 词条数: {total}", ""]
    flagged = 0
    for n in sorted(order):
        for part in ("A", "B"):
            rows = units[n]["parts"][part]
            bad = [(i + 1, r) for i, r in enumerate(rows) if r["need"]]
            if bad:
                rev.append(f"## Unit {n} Part {part}")
                for idx, r in bad:
                    flagged += 1
                    rev.append(f"- [{idx}] {r['word'] or '(空)'} — "
                               f"{','.join(r['need'])}"
                               + (f" | cn={r['cn'][:30]}" if r["cn"] else ""))
                rev.append("")
    rev.append(f"\n合计需复核: {flagged} 条 / {total} 条")
    open(a.review, "w", encoding="utf-8").write("\n".join(rev) + "\n")

    per = " ".join(f"U{n}:{len(units[n]['parts']['A'])+len(units[n]['parts']['B'])}"
                   for n in sorted(order))
    print(f"OK 词条共 {total} 条, Unit {len(order)} 个")
    print("  每单元条数:", per)
    print(f"  需复核 {flagged} 条 -> {a.review}")
    print(f"  已写出 -> {a.out}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
