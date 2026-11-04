"""Every file the site fetches must be committed; un-fetchable booleans do not exist.

web/data/ sits in .gitignore because it is pipeline output, and the deploy (GitHub Pages) only serves tracked
files — the contradiction nobody watched until the roads, lamps and districts spent days missing from the live
site while looking fine locally. This check dies on the class:

  1. data/current.json names the version; every string it or zagreb.json holds that ends in a data extension
     (.bin, .bin.gz, .json with a slash-free name) must be tracked by git,
  2. every literal path in a fetch(...) call in web/*.js (the roads' `roads.bin.gz`, the lamps, cards…) must
     resolve to a tracked file under web/ or under the data version,
  3. a template fetch (`${base}roads.json`) is checked on its trailing filename when that part is literal too.

Run by CI. Exit 1 and print what is missing.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"

EXT = re.compile(r"^[\w./-]+\.(?:json|bin|bin\.gz|webp|png|txt)$")
LITERAL = re.compile(r"""fetch\(\s*[`'"]([^`'"$]+)[`'"]""")
TRAIL = re.compile(r"fetch\(\s*`\$\{[^}]+\}([^`${}]+)`")


# zagreb.json.tiles[] names per-tile files (9_-8.bin), but the app slices them out of the packs with
# offset+length; the tile file itself is never a URL. Terrain and packs, on the other hand, name real files.
TILE_DESCRIPTOR = re.compile(r"^-?\d+_-?\d+\.bin$")


def strings(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)
    elif isinstance(o, str):
        yield o


def main() -> int:
    version = json.loads((WEB / "data/current.json").read_text(encoding="utf-8"))["version"]
    data = f"data/{version}"
    config = json.loads((WEB / f"{data}/zagreb.json").read_text(encoding="utf-8"))

    # Candidate URLs, as written in the code (their base variable can take the search/ and i18n/ prefixes with it).
    candidates: set[str] = {"data/current.json"}
    refs = {s for s in strings(config) if isinstance(s, str) and EXT.match(s) and not TILE_DESCRIPTOR.match(s)}
    candidates |= refs

    for js in WEB.glob("*.js"):
        text = js.read_text(encoding="utf-8")
        for m in LITERAL.finditer(text):  # fetch('roads.bin.gz'), fetch('data/…')
            candidates.add(m.group(1))
        for m in TRAIL.finditer(text):  # fetch(`${base}roads.json`)
            tail = m.group(1).lstrip("/")
            if EXT.match(tail):
                candidates.add(tail)

    out = subprocess.run(["git", "ls-files", "web"], cwd=ROOT, capture_output=True, text=True)
    have = {p[4:] for p in out.stdout.splitlines() if p.startswith("web/")}       # without the web/ prefix
    leaves = {p.rsplit("/", 1)[-1] for p in have}                                   # search/index.json's base hides in a
                                                                                    # variable: match by leaf too

    def present(c: str) -> bool:
        c = c.lstrip("/")
        if c.startswith(("http://", "https://")) or "${" in c:
            return True
        return c in have or f"{data}/{c}" in have or c.rsplit("/", 1)[-1] in leaves

    missing = sorted(c for c in candidates if not present(c))
    print(f"fetched reference candidates: {len(candidates)}")
    for c in sorted(candidates):
        print(f"  {'ok  ' if c not in missing else 'MISS'} {c}")
    if missing:
        print(f"\nMISSING {len(missing)} file(s) the site fetches but git does not track anywhere under web/:")
        for c in missing:
            print(f"  {c}")
        print("\nThey were probably written by the pipeline and swallowed by .gitignore — git add -f them.")
        return 1
    print("every fetched file is tracked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
