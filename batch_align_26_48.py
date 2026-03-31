#!/usr/bin/env python3
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from typing import Dict, List, Tuple
from xml.etree import ElementTree as ET

from faster_whisper import WhisperModel

BASE_DIR = "/Users/dengxiansen/Desktop/日语教资面试系统"
DOCX_DIR = os.path.join(BASE_DIR, "教资逐字稿/标日教资逐字稿word/标日逐字稿word版本")
AUDIO_DIR = os.path.join(BASE_DIR, "标日教资逐字稿录音25-48课【手可摘星辰】")
HTML_PATH = os.path.join(BASE_DIR, "首页.html")

MARKERS = ["導入", "プレゼンテーション", "練習", "応用", "まとめと宿題"]
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

LESSON_AUDIO_FILES = {
    25: "标日教资逐字稿--第25课.mp3",
    26: "标日教资逐字稿--第26课.mp3",
    27: "标日教资逐字稿--第27课.mp3",
    28: "标日教资逐字稿--第28课.mp3",
    29: "标日教资逐字稿--第29课.mp3",
    30: "标日教资逐字稿--第30课【女声】.mp3",
    31: "标日教资逐字稿--第31课【女声】.mp3",
    32: "标日教资逐字稿--第32课.mp3",
    33: "标日教资逐字稿--第33课.mp3",
    34: "标日教资逐字稿--第34课.mp3",
    35: "标日教资逐字稿--第35课.mp3",
    36: "标日教资逐字稿--第36课.mp3",
    37: "标日教资逐字稿--第37课.mp3",
    38: "标日教资逐字稿--第38课.mp3",
    39: "标日教资逐字稿--第39课.mp3",
    40: "标日教资逐字稿--第40课.mp3",
    41: "标日教资逐字稿--第41课.mp3",
    42: "标日教资逐字稿--第42课.mp3",
    43: "标日教资逐字稿--第43课.mp3",
    44: "标日教资逐字稿--第44课.mp3",
    45: "标日教资逐字稿--第45课.mp3",
    46: "标日教资逐字稿--第46课.mp3",
    47: "标日教资逐字稿--第47课.mp3",
    48: "标日教资逐字稿--第48课.mp3",
}


@dataclass
class Sentence:
    sid: int
    text: str
    no_audio: bool


def normalize_text(s: str) -> str:
    s = s or ""
    s = re.sub(r"\s+", "", s)
    # keep CJK, kana, latin, numbers
    return "".join(ch for ch in s if re.match(r"[\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9]", ch))


def read_docx_paragraphs(path: str) -> List[str]:
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml")
    root = ET.fromstring(xml)
    out: List[str] = []
    for p in root.findall(".//w:p", NS):
        txt = "".join((t.text or "") for t in p.findall(".//w:t", NS))
        txt = txt.replace("\u3000", " ").replace("\xa0", " ").strip()
        if txt:
            out.append(txt)
    return out


def extract_script_raw(paras: List[str]) -> List[str]:
    start = None
    for i, s in enumerate(paras):
        if "各位考官好" in s:
            start = i
            break
    if start is None:
        raise ValueError("Cannot find script start (各位考官好)")

    lines: List[str] = []
    for s in paras[start:]:
        if "以上是我试讲" in s or "感谢各位考官" in s:
            break
        t = s.strip()
        if t:
            lines.append(t)
    return lines


def parse_sentences(script_raw: List[str]) -> List[Sentence]:
    sentences: List[Sentence] = []
    sid = 1
    for line in script_raw:
        t = line.strip()
        if not t:
            continue
        is_marker = False
        for m in MARKERS:
            if t == m or t.startswith(m):
                is_marker = True
                break
        if is_marker:
            continue
        no_audio = bool(re.match(r"^各位考官好", t))
        sentences.append(Sentence(sid=sid, text=t, no_audio=no_audio))
        sid += 1
    return sentences


def get_audio_duration(path: str) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ]
    ).decode("utf-8", errors="ignore").strip()
    return float(out)


def transcribe_segments(model: WhisperModel, audio_path: str) -> Tuple[float, List[Tuple[float, float, str]]]:
    segments_iter, info = model.transcribe(
        audio_path,
        language="ja",
        beam_size=2,
        vad_filter=True,
        condition_on_previous_text=False,
        temperature=0,
    )
    segs = [(float(s.start), float(s.end), s.text or "") for s in segments_iter]
    return float(info.duration), segs


def map_charpos_to_time(char_pos: float, segs: List[Tuple[float, float, str]], seg_char_lens: List[int], total_chars: int, duration: float) -> float:
    if not segs:
        return max(0.0, min(duration, char_pos))
    if total_chars <= 0:
        return max(0.0, min(duration, char_pos))

    consumed = 0.0
    for (start, end, _txt), clen in zip(segs, seg_char_lens):
        span = max(0.0, end - start)
        if clen <= 0:
            continue
        nxt = consumed + clen
        if char_pos <= nxt:
            ratio = (char_pos - consumed) / max(clen, 1)
            ratio = max(0.0, min(1.0, ratio))
            return start + span * ratio
        consumed = nxt
    return segs[-1][1]


def build_timeline(sentences: List[Sentence], segs: List[Tuple[float, float, str]], duration: float) -> Dict[int, Tuple[float, float]]:
    audible = [s for s in sentences if not s.no_audio]
    if not audible:
        return {}

    seg_char_lens = [len(normalize_text(t)) for _, _, t in segs]
    trans_total_chars = sum(seg_char_lens)

    target_lens = [max(1, len(normalize_text(s.text))) for s in audible]
    target_total = sum(target_lens)

    timeline: Dict[int, Tuple[float, float]] = {}

    if trans_total_chars <= 0 or target_total <= 0:
        # fallback: uniform split
        slot = duration / len(audible)
        cur = 0.0
        for s in audible:
            start = cur
            end = min(duration, cur + slot)
            timeline[s.sid] = (round(start, 3), round(end, 3))
            cur = end
        return timeline

    prev_end = 0.0
    consumed_target = 0
    min_len = 0.35

    for i, s in enumerate(audible):
        consumed_target += target_lens[i]
        end_char = (consumed_target / target_total) * trans_total_chars
        end_t = map_charpos_to_time(end_char, segs, seg_char_lens, trans_total_chars, duration)

        start_t = prev_end
        if i == 0:
            start_t = 0.0

        if end_t <= start_t + min_len:
            end_t = min(duration, start_t + min_len)

        timeline[s.sid] = (round(start_t, 3), round(min(duration, end_t), 3))
        prev_end = end_t

    # Ensure final end reaches near full duration
    last_sid = audible[-1].sid
    st, _ = timeline[last_sid]
    timeline[last_sid] = (st, round(duration, 3))

    # Monotonic cleanup
    last_end = 0.0
    for s in audible:
        st, ed = timeline[s.sid]
        st = max(last_end, st)
        ed = max(st + 0.2, ed)
        ed = min(duration, ed)
        timeline[s.sid] = (round(st, 3), round(ed, 3))
        last_end = ed

    return timeline


def export_clips(audio_path: str, timeline: Dict[int, Tuple[float, float]], out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for sid in sorted(timeline.keys()):
        start, end = timeline[sid]
        if end <= start + 0.05:
            continue
        out_mp3 = os.path.join(out_dir, f"{sid:03d}.mp3")
        cmd = [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{start:.3f}",
            "-to",
            f"{end:.3f}",
            "-i",
            audio_path,
            "-ac",
            "1",
            "-ar",
            "44100",
            "-b:a",
            "128k",
            out_mp3,
        ]
        subprocess.run(cmd, check=True)


def update_html_timelines(all_timelines: Dict[int, Dict[int, Tuple[float, float]]]) -> None:
    with open(HTML_PATH, "r", encoding="utf-8") as f:
        html = f.read()

    m = re.search(r"const LESSON_TIMELINES = \{[\s\S]*?\n\};", html)
    if not m:
        raise RuntimeError("Cannot find LESSON_TIMELINES block in 首页.html")

    ordered_lessons = sorted(set([25] + list(all_timelines.keys())))
    lines = ["const LESSON_TIMELINES = {"]

    # Keep existing 25 if present in current html by parsing quickly
    # If not parseable, leave 25 untouched by not rewriting from data.
    # Here we rebuild from old block + new lessons.
    old_block = m.group(0)
    old_25 = re.search(r"25:\s*\{([\s\S]*?)\n\s*\}\s*(,|\n)", old_block)

    for idx, lesson in enumerate(ordered_lessons):
        comma_lesson = "," if idx < len(ordered_lessons) - 1 else ""
        lines.append(f"  {lesson}: {{")
        if lesson == 25 and old_25:
            inner = old_25.group(1).rstrip()
            for ln in inner.splitlines():
                lines.append(f"{ln}")
        else:
            tl = all_timelines.get(lesson, {})
            sids = sorted(tl.keys())
            for j, sid in enumerate(sids):
                start, end = tl[sid]
                comma = "," if j < len(sids) - 1 else ""
                lines.append(f"    {sid}: [{start:.3f}, {end:.3f}]{comma}")
        lines.append(f"  }}{comma_lesson}")
    lines.append("};")

    new_block = "\n".join(lines)
    html = html[: m.start()] + new_block + html[m.end() :]

    with open(HTML_PATH, "w", encoding="utf-8") as f:
        f.write(html)


def find_docx_for_lesson(lesson: int) -> str:
    cand = os.path.join(DOCX_DIR, f"标日{lesson}课-学習指導案.docx")
    if os.path.exists(cand):
        return cand
    raise FileNotFoundError(cand)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--start", type=int, default=26)
    p.add_argument("--end", type=int, default=48)
    p.add_argument("--model", default="small")
    p.add_argument("--skip-export", action="store_true")
    p.add_argument("--no-html-update", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    lessons = list(range(args.start, args.end + 1))
    print(f"[INFO] lessons: {lessons}")
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    all_timelines: Dict[int, Dict[int, Tuple[float, float]]] = {}

    for lesson in lessons:
        print(f"\n[INFO] lesson {lesson} ...", flush=True)
        docx = find_docx_for_lesson(lesson)
        paras = read_docx_paragraphs(docx)
        raw = extract_script_raw(paras)
        sentences = parse_sentences(raw)

        audio_name = LESSON_AUDIO_FILES.get(lesson)
        if not audio_name:
            print(f"[WARN] lesson {lesson}: missing audio mapping, skip")
            continue
        audio_path = os.path.join(AUDIO_DIR, audio_name)
        if not os.path.exists(audio_path):
            print(f"[WARN] lesson {lesson}: audio not found {audio_path}, skip")
            continue

        duration, segs = transcribe_segments(model, audio_path)
        timeline = build_timeline(sentences, segs, duration)
        all_timelines[lesson] = timeline

        out_dir = os.path.join(AUDIO_DIR, f"第{lesson}课分句mp3")
        os.makedirs(out_dir, exist_ok=True)

        tjson_path = os.path.join(out_dir, f"lesson{lesson}_timeline.json")
        with open(tjson_path, "w", encoding="utf-8") as f:
            json.dump({str(k): [v[0], v[1]] for k, v in sorted(timeline.items())}, f, ensure_ascii=False, indent=2)

        if not args.skip_export:
            export_clips(audio_path, timeline, out_dir)

        print(
            f"[OK] lesson {lesson}: sentences={len(sentences)} timeline={len(timeline)} segs={len(segs)} out={out_dir}",
            flush=True,
        )

    if not args.no_html_update and all_timelines:
        update_html_timelines(all_timelines)
        print(f"\n[OK] updated html timelines: {HTML_PATH}", flush=True)

    print("\n[DONE]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
