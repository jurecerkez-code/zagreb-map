"""Count screenshot pixels by nearest theme colour (Ärg look): sky, land, water, unknown and the six periods.
Shaded variants (x0.55..1.15) of each reference count as that class; a pixel farther than MAX_D from all is 'other'.
Usage: uv run python scripts/zagreb_pixels.py shot.png"""
import json
import sys

import numpy as np
from PIL import Image

REF = {"sky": "#d9dfe3", "land": "#e9e8e5", "water": "#0e2433", "unknown": "#c9c6c0", "unknown_hatch": "#aca8a1",
       "p1 <1800": "#8ed3d0", "p2 1800-1879": "#47a0a5", "p3 1880-1918": "#387b88", "p4 1919-1945": "#465262",
       "p5 1946-1990": "#aa6446", "p6 1991+": "#e49f75"}
MAX_D = 28.0


def rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)


def main(path):
    img = np.asarray(Image.open(path).convert("RGB"), float).reshape(-1, 3)
    names, refs = [], []
    for k, h in REF.items():
        for s in (0.55, 0.7, 0.85, 1.0, 1.15):
            names.append(k)
            refs.append(np.clip(rgb(h) * s, 0, 255))
    refs = np.array(refs)
    best = np.full(len(img), np.inf)
    cls = np.full(len(img), -1)
    for i, r in enumerate(refs):
        d = np.sqrt(((img - r) ** 2).sum(1))
        m = d < best
        best[m], cls[m] = d[m], i
    out = {k: 0 for k in REF}
    out["other"] = int((best >= MAX_D).sum())
    for i, k in enumerate(names):
        out[k] += int(((cls == i) & (best < MAX_D)).sum())
    out["total"] = len(img)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
