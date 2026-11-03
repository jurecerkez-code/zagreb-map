"""Zagreb monuments: copy the hand-checked monuments list (data/monuments in the project folder, made by its work/
scripts from OpenStreetMap, Wikidata, Commons and Wikipedia) into the version folder as monuments.json, in the
viewer's compact form (local x/z metres, web/monuments.js), and its photos into web/data/photos/.

    uv run python -m pipeline.s05_zagreb_monuments [--version vYYYYMMDD-tag]

Standalone: reads nothing the other steps write, so a rebuild of the tiles keeps the monuments. Fails when a photo
the list names is missing or over city.WIKI['photo_bytes'].
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

from . import city, io
from .s03_tiles import out_dir

SRC = Path(__file__).resolve().parents[2] / "data" / "monuments"
PHOTOS = Path("web/data/photos")
BUILDINGS = Path("data/buildings.parquet")
PLINTH_M2, PLINTH_MAX_M = 80.0, 12.0   # a small, low "building" under a monument is its plinth in the city model


def plinths(ms: list[dict]) -> dict[str, float]:
    """id -> height (m) of the city model's plinth under the monument: ZG3D models many pedestals (the ban Jelačić
    statue stands on a 17.6 m², 5.25 m part), so the viewer stands the figure on it instead of burying it inside."""
    if not BUILDINGS.exists():
        return {}
    import geopandas as gpd
    from shapely.geometry import Point
    b = gpd.read_parquet(BUILDINGS, columns=["gid", "height", "geometry"])
    b = b[(b.geometry.area < PLINTH_M2) & (b["height"] < PLINTH_MAX_M)]
    pts = gpd.GeoDataFrame({"id": [m["id"] for m in ms]}, geometry=[Point(m["x_3765"], m["y_3765"]) for m in ms], crs=b.crs)
    hit = gpd.sjoin(pts, b, predicate="within")
    return {r.id: round(float(r.height), 2) for r in hit.itertuples()}


def compact(m: dict, plinth: float | None = None) -> dict:
    x, z = city.to_local(m["x_3765"], m["y_3765"])
    out = {"id": m["id"], "name": m["name"], "kind": m["kind"], "x": round(float(x), 2), "z": round(float(z), 2),
           "h": m["height_m"], "mat": m["material"]}
    for k, v in (("en", m.get("name_en")), ("year", m.get("year")), ("removed", m.get("removed")),
                 ("by", m.get("creators")), ("dir", m.get("direction")), ("qid", m.get("wikidata")),
                 ("wp", m.get("wikipedia")), ("hsrc", None if m.get("height_source") == "type default" else m.get("height_source"))):
        if v:
            out[k] = v
    if plinth:
        out["plinth"] = plinth
    ex = {lang: {"t": e["t"], "r": e["r"], "title": e["title"]} for lang, e in (m.get("extracts") or {}).items()}
    if ex:
        out["ex"] = ex
    p = m.get("photo")
    if p:
        out["photo"] = {"key": p["key"], "w": p["w"], "h": p["h"], "by": p["author"] or "unknown", "lic": p["licence"],
                        "lu": p["licence_url"], "page": p["source_page"], **({"title": p["title"]} if p.get("title") else {})}
    ins = m.get("inscription") or m.get("osm_tags", {}).get("inscription")   # a hand-checked one wins over OSM's
    if ins:
        out["ins"] = ins[:300]
    if m["id"].startswith(("node/", "way/", "relation/")):
        out["osm"] = m["id"]
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="s05_zagreb_monuments", description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="output version (default: the one in web/data/current.json)")
    args, _ = ap.parse_known_args(argv)
    src = SRC / "monuments.json"
    if not src.exists():
        raise SystemExit(f"{src} is missing: run data/monuments/work/s1_osm.py and s2_build.py first")
    ms = json.loads(src.read_text(encoding="utf-8"))
    out = out_dir(args.version)
    PHOTOS.mkdir(parents=True, exist_ok=True)
    copied = 0
    for m in ms:
        p = m.get("photo")
        if not p:
            continue
        f = SRC / p["file"]
        if not f.exists():
            raise SystemExit(f"photo missing: {f} ({m['name']})")
        if f.stat().st_size > city.WIKI["photo_bytes"]:
            raise SystemExit(f"photo over {city.WIKI['photo_bytes']} bytes: {f}")
        dst = PHOTOS / p["key"]
        if not dst.exists() or dst.stat().st_size != f.stat().st_size:
            shutil.copyfile(f, dst)
            copied += 1
    pl = plinths(ms)
    rows = [compact(m, pl.get(m["id"])) for m in ms]
    size = io.write_json(out / "monuments.json", rows)
    print(f"{len(rows)} monuments ({sum('photo' in r for r in rows)} with photo, {len(pl)} on a city-model plinth, {copied} photos copied), "
          f"{size / 1024:.0f} KB → {out / 'monuments.json'}")


if __name__ == "__main__":
    main(sys.argv[1:])
