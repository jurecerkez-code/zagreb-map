"""Zagreb port: the hand-checked landmarks (data/landmarks/, outside the engine) onto the CURRENT build.

Every s01_zagreb run renumbers the buildings, and it writes empty wiki/photo/extract files. This step runs right after
s02_lod2 and puts the curated tier back on today's gids, found by each landmark's own coordinate (never by an old gid):
  - data/wiki.parquet       gid, qid, name, name_en, langs, photo   (what s03_tiles puts on the cards)
  - data/photos.json        photo key -> credit (with "key")
  - data/extracts.json      gid -> {lang: excerpt}, re-keyed from the landmark kit's old gids
  - data/years.parquet      the curated year (SRC_CURATED) on each landmark's building
  - data/landmarks.json     the entries, for s03_tiles' timeline labels
  - web/data/photos/        the photo files
It refuses to finish when fewer than MIN_PLACED of the entries land on a building, or when the cards would lose
their photos, so a silent mismatch cannot ship again.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
from pyproj import Transformer

from . import city, codes
from .zagreb_city import span_flag

DATA = Path("data")
KIT = Path(__file__).resolve().parent.parent.parent / "data" / "landmarks"
PHOTOS_OUT = Path("web/data/photos")
NEAR_M = 40.0
MIN_PLACED = 0.95


def place(entries: list[dict], b: gpd.GeoDataFrame) -> dict[int, int]:
    """entry index -> today's gid: the building whose footprint holds the point, else the nearest within NEAR_M."""
    tr = Transformer.from_crs(4326, city.CRS, always_xy=True)
    xs, ys = tr.transform([e["lon"] for e in entries], [e["lat"] for e in entries])
    pts = shapely.points(xs, ys)
    tree = shapely.STRtree(b.geometry.values)
    pi, gi = tree.query(pts, predicate="intersects")
    out = {}
    for p, g in zip(pi, gi):
        # a point on several footprints: the smallest, the building rather than its block
        if p not in out or b.geometry.values[g].area < b.geometry.values[out[p]].area:
            out[int(p)] = int(g)
    for p in range(len(entries)):
        if p in out:
            continue
        g, d = tree.query_nearest(pts[p], return_distance=True, max_distance=NEAR_M)
        if len(g):
            out[p] = int(g[0])
    return {p: int(b.gid.values[g]) for p, g in out.items()}


def period_of(year: int) -> int:
    for i, per in enumerate(city.PERIODS):
        if per[3] <= year <= per[4]:
            return i
    return 0


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="s02_zagreb_curated", description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="ignored (run.py passes it to every step)")
    ap.parse_args(argv)
    if not (KIT / "landmarks.json").exists():
        print(f"no landmark kit at {KIT}: skipped", file=sys.stderr)
        return
    entries = json.loads((KIT / "landmarks.json").read_text(encoding="utf-8"))
    kit_rows = {r["qid"]: r for r in json.loads((KIT / "engine" / "wiki_rows.json").read_text(encoding="utf-8"))}
    kit_extracts = json.loads((KIT / "engine" / "extracts.json").read_text(encoding="utf-8"))
    photos = json.loads((KIT / "engine" / "photos.json").read_text(encoding="utf-8"))
    for k, v in photos.items():
        v.setdefault("key", k)

    b = gpd.read_parquet(DATA / "buildings.parquet", columns=["gid", "geometry"])
    at = place(entries, b)
    placed = len(at) / len(entries)
    if placed < MIN_PLACED:
        raise SystemExit(f"only {len(at)} of {len(entries)} landmarks placed on a building")

    rows, extracts, curated = {}, {}, {}
    for i, e in enumerate(entries):
        if i not in at:
            continue
        gid = at[i]
        k = kit_rows.get(e.get("qid"), {})
        if gid not in rows:   # two entries on one footprint: the first (the list is ordered by importance) wins
            rows[gid] = {"gid": gid, "qid": e.get("qid") or "", "name": e.get("name") or "",
                         "name_en": k.get("name_en") or e.get("name") or "",
                         "langs": k.get("langs") or ("hr,en" if e.get("enwiki") else "hr"),
                         "photo": k.get("photo") or ""}
            old = str(e.get("gid")) if e.get("gid") is not None else None
            if old and old in kit_extracts:
                extracts[str(gid)] = kit_extracts[old]
        y0 = int(e.get("year_shown") or e.get("year") or 0)
        if y0 and gid not in curated:
            span = e.get("year_span") or [e.get("year_from") or y0, e.get("year_to") or y0]
            curated[gid] = (y0, int(span[0] or y0), int(span[-1] or y0), e.get("name") or "")

    wiki = pd.DataFrame(list(rows.values()))
    wiki["gid"] = wiki["gid"].astype("int64")
    wiki.to_parquet(DATA / "wiki.parquet", index=False)
    (DATA / "photos.json").write_text(json.dumps(photos, ensure_ascii=False), encoding="utf-8")
    (DATA / "extracts.json").write_text(json.dumps(extracts, ensure_ascii=False), encoding="utf-8")
    shutil.copy(KIT / "landmarks.json", DATA / "landmarks.json")

    y = pd.read_parquet(DATA / "years.parquet")
    pos = pd.Series(y.index, index=y.gid)
    for gid, (y0, a, z, name) in curated.items():
        i = pos[gid]
        # the flag follows the kit's own span: a tower dated 1266-1857 is a LONG span, not an exact 1266
        y.loc[i, ["year", "year_from", "year_to", "ysrc", "yflag", "period"]] = \
            [y0, a, z, codes.SRC_CURATED, span_flag(a, z)[3], period_of(y0)]
        y.loc[i, "landmark"] = name
        # a hand-checked landmark (a church, a chapel, a tower with its own Wikipedia article) is a public building,
        # even where OSM tags its footprint 'house'; the decade-only rule is for private homes
        y.loc[i, "private"] = False
    y.to_parquet(DATA / "years.parquet", index=False)

    PHOTOS_OUT.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in (KIT / "photos").iterdir():
        shutil.copy(f, PHOTOS_OUT / f.name)
        n += 1
    with_photo = int((wiki.photo != "").sum())
    if with_photo < 0.8 * sum(1 for r in kit_rows.values() if r.get("photo")):
        raise SystemExit(f"only {with_photo} landmark cards would have a photo")
    print(f"{len(at)} of {len(entries)} landmarks placed ({len(rows)} buildings); {with_photo} with a photo, "
          f"{len(extracts)} with a Wikipedia excerpt, {len(curated)} curated years; {n} photo files")


if __name__ == "__main__":
    main(sys.argv[1:])
