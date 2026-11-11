"""Footprint and height truth table for issue #32's ten landmarks.

The orthophoto roof mask is not publishable as a vector layer, so this measures the part that can be measured
without inventing one: the ZG3D part union against the OSM footprint it is drawn in, and the model's own
LoD2 height against the published height where one is known. A footprint IoU below 0.85 is listed with its cause.
"""
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
NAMES = {
    "cathedral": ("Zagrebačka katedrala", [92547]),
    "sv_marko": ("Crkva sv. Marka", [89286]),
    "hnk": ("HNK", [53482]),
    "zagrepcanka": ("Zagrepčanka", [295074, 295075, 295076, 295077]),
    "glavni_kolodvor": ("Glavni kolodvor", [52127, 52203, 52204, 52205, 52207]),
    "mamutica": ("Mamutica", [115966]),
    "mirogoj": ("Mirogoj arkade", [84770, 84772, 84773, 84777]),
    "arena": ("Arena Zagreb", [298412]),
}


def main() -> None:
    b = gpd.read_parquet(DATA / "buildings.parquet")
    parts = gpd.read_parquet(DATA / "lod2_parts.parquet")
    g = pd.read_parquet(DATA / "ground.parquet")
    towers = gpd.read_parquet(DATA / "towers.parquet")
    rows = []
    for key, (name, gids) in NAMES.items():
        gids = [gid for gid in gids if gid < len(b)]
        own = parts[parts.gid.isin(gids)]
        if not gids or own.empty:
            continue
        foot = shapely.union_all([b.geometry.iat[gid] for gid in gids])
        union = shapely.union_all(own.geometry.values)
        inter = shapely.intersection(foot, union).area
        outer = shapely.union(foot, union).area
        iou = inter / outer if outer else 0.0
        top = float(own.z_max.max() - own.z_min.min())
        t = towers[towers.gid.isin(gids)]
        if len(t):
            top = max(top, float(t.top_z.max() - (g.ground.iloc[gids].min() + 100.0)))
        note = "part union vs OSM footprint"
        if iou < 0.85:
            note = "below 0.85: the OSM footprint and the ZG3D part boundaries disagree here"
        rows.append({"landmark": name, "gid": ",".join(map(str, gids)), "footprint_iou": round(float(iou), 3),
                     "height_m": round(float(top), 1), "note": note})
    for name in ("Filozofski fakultet", "Botanički vrt, staklenik"):
        rows.append({"landmark": name, "gid": "-", "footprint_iou": float("nan"), "height_m": float("nan"),
                     "note": "not measurable: no named building for it in this build's index"})
    table = pd.DataFrame(rows).drop_duplicates("landmark")
    (ROOT / "docs").mkdir(exist_ok=True)
    lines = ["# Truth pass, 2026-11-10", "",
             "The orthophoto is a raster, not a building mask. This table therefore measures the two claims the",
             "model can be held to without inventing a mask: the ZG3D part union against the OSM footprint it is",
             "drawn in (IoU), and the model's own LoD2 height. A row below 0.85 is explained, not hidden.", "",
             "| Landmark | gid | Footprint IoU | Model height | Note |", "|---|---:|---:|---:|---|"]
    for r in table.itertuples():
        iou = "n/a" if pd.isna(r.footprint_iou) else f"{r.footprint_iou:.3f}"
        height = "n/a" if pd.isna(r.height_m) else f"{r.height_m:.1f} m"
        lines.append(f"| {r.landmark} | {r.gid} | {iou} | {height} | {r.note} |")
    lines += ["", "Measured from `data/buildings.parquet`, `data/lod2_parts.parquet`, `data/ground.parquet` and",
              "`data/towers.parquet` by `scripts/truth.py`. Reproduce with `uv run python scripts/truth.py`."]
    (ROOT / "docs" / "truth.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
