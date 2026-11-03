"""OCR and pixel check of the story screenshots (scripts/scenes_check.mjs writes docs/screens/scene_<id>.png).
Usage: uv run --with rapidocr-onnxruntime python scripts/scenes_ocr.py [screens dir]
Prints per shot: does the hero beat's caption render (share of its words found by OCR), and the share of pixels in the
map above the caption band near each period colour of the default look (pipeline/city.py PERIODS), so a blank or
all-faint frame shows up. The 1919-1945 colour is a dark slate, so a saturation test alone would miss it."""
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

ENGINE = Path(__file__).resolve().parents[1]
SCREENS = Path(sys.argv[1]) if len(sys.argv) > 1 else ENGINE.parent / "docs" / "screens"
HERO = {"two-hills": 6, "earthquake-1880": 5, "green-horseshoe": 4, "interwar-estates": 7, "across-the-sava": 5}
PERIOD_COLOURS = {"<1800": "#8ed3d0", "1800-79": "#47a0a5", "1880-1918": "#387b88", "1919-45": "#465262",
                  "1946-90": "#aa6446", "1991-": "#e49f75"}
ocr = RapidOCR()
words = lambda s: set(re.findall(r"[a-zà-ž]{4,}", s.lower()))
for sid, hero in HERO.items():
    shot = SCREENS / f"scene_{sid}.png"
    if not shot.exists():
        print(sid, "no screenshot")
        continue
    caption = json.loads((ENGINE / "web" / "scenes" / f"{sid}.json").read_text(encoding="utf-8"))["beats"][hero - 1]["caption"]["en"]
    res, _ = ocr(str(shot))
    text = " ".join(r[1] for r in res or [])
    want = words(caption)
    found = len(want & words(text)) / max(1, len(want))
    a = np.asarray(Image.open(shot).convert("RGB")).astype(int)
    top = a[: int(a.shape[0] * 0.62)]
    px = top.reshape(-1, 3)
    share = {p: round(float((np.abs(px - np.array([int(c[i:i + 2], 16) for i in (1, 3, 5)])).sum(1) < 45).mean()), 3)
             for p, c in PERIOD_COLOURS.items()}
    print(json.dumps({"id": sid, "caption_words_found": round(found, 2), "period_px": share,
                      "ocr_sample": text[:160]}, ensure_ascii=False))
