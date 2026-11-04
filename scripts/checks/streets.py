"""Does the street layer stand up? Run by features/streets.feature's @check tags.

Three facts, each one read from the source that decides it:

  1. The ribbon's triangles are counter clockwise, which is the winding three.js keeps. Clockwise ones were culled,
     and the layer drew nothing for weeks while looking correct in every other way.
  2. No street material reaches for DoubleSide to be seen. Winding is the fix; DoubleSide would hide a regression.
  3. The measured colours are still the ones written down, so a later edit cannot quietly drop them back to guesswork.
"""
import re
import sys
from pathlib import Path

LAYER = Path(__file__).resolve().parents[2] / "web" / "roads-layer.js"


def main() -> int:
    src = LAYER.read_text(encoding="utf-8")
    fails = []

    idx = re.search(r"tile\.idx\.push\(([^)]*)\)", src)
    if not idx:
        fails.append("the ribbon pushes no indices at all")
    else:
        order = [p.strip() for p in idx.group(1).split(",")]
        if order[:3] != ["a", "a + 2", "a + 1"]:
            fails.append(f"the first triangle is wound {order[:3]}, not [a, a + 2, a + 1]")

    if re.search(r"side:\s*(THREE\.)?DoubleSide", src):
        fails.append("a street material asks for DoubleSide: the winding has gone wrong again")

    for name, value in (("asphalt", "#4f5450"), ("kerb side pavement", "#8d908e")):
        if value not in src:
            fails.append(f"the measured {name} {value} is not in the layer any more")

    for f in fails:
        print("FAIL", f)
    if not fails:
        print("ok  the streets are wound up and in the measured colour")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
