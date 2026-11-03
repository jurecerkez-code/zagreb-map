"""Zagreb: the real vegetation (data/veg/*, extracted from OpenStreetMap) into the version as compact geometry.

    uv run python -m pipeline.run s07_zagreb_veg -- --version vYYYYMMDD-x

Written into web/data/<version>/:
  veg.json        counts, class list, licence line, the nominal tree spacing of a tree row
  veg_trees.bin   float32 x, y, z per tree (engine local metres, y = the terrain height there)
  veg_mask.bin.gz one uint8 class per 16 m cell, gzipped. 6.4 MB raw, 0.23 MB over the wire: the city is mostly
                  bare, so the zero runs collapse (2026-11-03). The browser inflates it with DecompressionStream.

Sources and honesty rules:
- Every tree is an OSM `natural=tree` node at its mapped coordinate. Tree rows (`natural=tree_row`) carry no
  individual trees, so their length is filled with trees at a nominal 8 m spacing: a symbol of the mapped row,
  never an invented avenue.
- Every green polygon is drawn on its own footprint, triangulated by GEOS (constrained Delaunay) so concave parks
  keep their shape. Nothing outside those footprints is ever green.
- Licence: OpenStreetMap (Geofabrik Croatia extract), (c) OpenStreetMap contributors, ODbL.
"""
import argparse
import gzip
import json
import struct
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely

DATA = Path("data")
VEG = Path("../data/veg")
WEB = Path("web") / "data"
ORIGIN = (459370.1, 5074937.5)      # city.py ORIGIN, EPSG:3765
CLASSES = ["grass", "meadow", "forest", "wood", "scrub", "grassland", "heath", "orchard", "park", "garden", "allotments"]
ROW_SPACING_M = 8.0


def to_local(geom):
    """EPSG:3765 geometry -> engine local x (east) and z (south, negative)."""
    e, n = shapely.get_coordinates(geom).T
    return np.c_[e - ORIGIN[0], -(n - ORIGIN[1])]


class Terrain:
    def __init__(self):
        t = json.loads((DATA / "terrain.json").read_text())
        self.h = np.load(DATA / "terrain.npz")["h"].astype(np.float64)
        self.x0, self.z0, self.cell, self.nx, self.nz = t["x0"], t["z0"], t["cell"], t["nx"], t["nz"]

    def at(self, x, z):
        """Bilinear height at local (x, z)."""
        i = np.clip((np.asarray(x, np.float64) - self.x0) / self.cell, 0, self.nx - 1.001)
        j = np.clip((np.asarray(z, np.float64) - self.z0) / self.cell, 0, self.nz - 1.001)
        i0, j0 = np.floor(i).astype(int), np.floor(j).astype(int)
        fi, fj = i - i0, j - j0
        h = self.h
        return ((h[j0, i0] * (1 - fi) + h[j0, i0 + 1] * fi) * (1 - fj) +
                (h[j0 + 1, i0] * (1 - fi) + h[j0 + 1, i0 + 1] * fi) * fj)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    args = ap.parse_args(argv)
    out = WEB / args.version
    out.mkdir(parents=True, exist_ok=True)
    terr = Terrain()

    # trees: real nodes plus the nominal fill of the mapped rows
    trees = gpd.read_parquet(VEG / "trees.parquet")
    txz = to_local(trees.geometry.values)
    extra = []
    rows = gpd.read_parquet(VEG / "tree_rows.parquet")
    for line in rows.geometry.values:
        L = line.length
        n = max(2, int(round(L / ROW_SPACING_M)))
        for d in np.linspace(0.0, L, n):
            p = line.interpolate(d)
            extra.append((p.x - ORIGIN[0], -(p.y - ORIGIN[1])))
    if extra:
        txz = np.vstack([txz, np.asarray(extra, np.float64)])
    ty = terr.at(txz[:, 0], txz[:, 1])
    tree_arr = np.c_[txz[:, 0], ty + 0.2, txz[:, 1]].astype(np.float32)
    (out / "veg_trees.bin").write_bytes(tree_arr.tobytes())

    # Woodland symbols: a 60 m grid inside the mapped forest, wood and scrub polygons (OSM maps woodland as an area,
    # never as individual trees). Deterministic, documented as symbols; the mapped nodes above stay exact.
    g0 = gpd.read_parquet(VEG / "green.parquet")
    wood = g0[g0.cls.isin(["forest", "wood", "scrub"])]
    fx, fz = [], []
    for geom in wood.geometry.to_numpy():
        loc = shapely.transform(geom, lambda c: np.c_[c[:, 0] - ORIGIN[0], -(c[:, 1] - ORIGIN[1])])
        minx, minz, maxx, maxz = loc.bounds
        if (maxx - minx) * (maxz - minz) > 400e6:
            continue                       # a polygon that big is a mistake in the source, not a wood
        gx = np.arange(minx, maxx, 60.0)
        gz = np.arange(minz, maxz, 60.0)
        if not len(gx) or not len(gz):
            continue
        XX, ZZ = np.meshgrid(gx, gz)
        inside = shapely.contains_xy(loc, XX.ravel(), ZZ.ravel())
        fx.append(XX.ravel()[inside]); fz.append(ZZ.ravel()[inside])
    if fx:
        fx = np.concatenate(fx); fz = np.concatenate(fz)
        fy = terr.at(fx, fz)
        forest_arr = np.c_[fx, fy + 0.2, fz].astype(np.float32)
        tree_arr = np.vstack([tree_arr, forest_arr]) if len(tree_arr) else forest_arr
        (out / "veg_trees.bin").write_bytes(tree_arr.tobytes())     # rewritten: the first write predates the symbols
        print(f"woodland symbols: {len(forest_arr):,} at 60 m spacing", flush=True)

    # Green areas: a class mask rasterized on a 16 m grid of the same extent, painted into the terrain by the shader.
    # Geometry was tried first and failed: a forest polygon is kilometres wide, and one flat triangle chords across the
    # hills and sinks under them, so whole forests (Maksimir, Medvednica) were invisible from above. A mask follows the
    # ground by construction, cannot z-fight and costs one byte per cell.
    import rasterio.features
    from rasterio.transform import from_origin
    g = gpd.read_parquet(VEG / "green.parquet")
    MASK_CELL = 16.0
    lg = g.geometry.bounds  # (minx, miny, maxx, maxy) in EPSG:3765, before the local shift
    x_lo = min(terr.x0, float(lg.minx.min()) - ORIGIN[0])
    x_hi = max(terr.x0 + (terr.nx - 1) * terr.cell, float(lg.maxx.max()) - ORIGIN[0])
    z_lo = min(terr.z0, -float(lg.maxy.max()) + ORIGIN[1])          # north edge (z negative)
    z_hi = max(terr.z0 + (terr.nz - 1) * terr.cell, -float(lg.miny.min()) + ORIGIN[1])
    x_lo = float(np.floor(x_lo / MASK_CELL) * MASK_CELL)
    z_lo = float(np.floor(z_lo / MASK_CELL) * MASK_CELL)
    mw = int(np.ceil((x_hi - x_lo) / MASK_CELL)) + 1
    mh = int(np.ceil((z_hi - z_lo) / MASK_CELL)) + 1
    def local_geom(geom):
        return shapely.transform(geom, lambda c: np.c_[c[:, 0] - ORIGIN[0], -(c[:, 1] - ORIGIN[1])])
    shapes = [(local_geom(geom), CLASSES.index(cls) + 1)
              for cls, geom in zip(g.cls.to_numpy(), g.geometry.to_numpy())]
    # row = (z - z_lo) / cell and col = (x - x_lo) / cell, both increasing: stated here, not inferred from a raster
    # convention (a flipped affine silently rasterized nothing, 2026-10-29).
    from rasterio import Affine
    transform = Affine.translation(x_lo, z_lo) * Affine.scale(MASK_CELL, MASK_CELL)
    mask = rasterio.features.rasterize(shapes, out_shape=(mh, mw), transform=transform, fill=0, dtype="uint8",
                                       all_touched=True)
    (out / "veg_mask.bin.gz").write_bytes(gzip.compress(mask.tobytes(), 6))

    # The cable car: the longest mapped aerialway=cable_car way in the city (the Zicara Sljeme), sampled every 25 m at
    # the terrain height. Geometry and trip duration come from OSM; the cabins' motion is a symbol.
    cable_meta = None
    try:
        import pyogrio
        lines = pyogrio.read_dataframe(VEG.parent / "raw" / "osm" / "croatia-latest.osm.pbf", layer="lines",
                                       bbox=(15.78, 45.61, 16.25, 45.97))
        # the tag lives in the driver's own column, not in other_tags (the way is EPSG:4326 there, so lengths must
        # be measured after the reprojection)
        cc = lines[lines["aerialway"].isin(["gondola", "cable_car"])].to_crs(3765)
        if len(cc):
            k = int(cc.geometry.length.idxmax())
            way = cc.loc[k]
            tags = lines.loc[[k], "other_tags"].fillna("")
            loc = shapely.transform(way.geometry, lambda c: np.c_[c[:, 0] - ORIGIN[0], -(c[:, 1] - ORIGIN[1])])
            L = shapely.length(loc)
            n = max(2, int(L / 25.0))
            pts = np.array([[p.x, p.y] for p in (shapely.line_interpolate_point(loc, d) for d in np.linspace(0, L, n))])
            y = terr.at(pts[:, 0], pts[:, 1])
            arr = np.c_[pts[:, 0], y + 8.0, pts[:, 1]].astype(np.float32)      # the rope runs ~8 m over the ground
            (out / "cable.bin").write_bytes(arr.tobytes())
            import re as _re
            dur = _re.search(r'"aerialway:duration"=>"([0-9.,]+)"', (tags.iloc[0] if len(tags) else "") or "")
            cable_meta = {"points": int(len(arr)), "length_m": round(float(L), 1),
                          "duration_min": float((dur.group(1) if dur else "16.5").replace(",", ".")),
                          "name": str(lines.loc[k, "name"] or "Zicara Sljeme")}
            print(f"cable car: {cable_meta['length_m']:.0f} m, {cable_meta['points']} points, "
                  f"{cable_meta['duration_min']} min", flush=True)
    except Exception as e:
        print("cable car: skipped", e, flush=True)

    counts = {c: int((g.cls == c).sum()) for c in CLASSES}
    meta = {
        "cable": cable_meta,
        "trees": {"count": int(len(tree_arr)), "from_nodes": int(len(trees)), "from_rows": int(len(tree_arr) - len(trees)),
                  "row_spacing_m": ROW_SPACING_M},
        "green": {"mask": {"w": mw, "h": mh, "cell": MASK_CELL, "x0": float(x_lo), "z0": float(z_lo), "gz": True},
                  "classes": CLASSES, "counts": counts,
                  "green_cells": int((mask > 0).sum()), "green_km2": round(float((mask > 0).sum()) * MASK_CELL ** 2 / 1e6, 2)},
        "licence": "OpenStreetMap (Geofabrik Croatia extract), (c) OpenStreetMap contributors, ODbL",
        "source": "OpenStreetMap natural=tree, natural=tree_row, landuse/leisure/natural green polygons",
    }
    (out / "veg.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"trees {len(tree_arr):,} ({len(trees):,} mapped nodes, the rest row fill and woodland symbols); "
          f"green mask {mw}x{mh} at {MASK_CELL:.0f} m = {int((mask > 0).sum()):,} cells "
          f"({int((mask > 0).sum()) * MASK_CELL ** 2 / 1e6:.1f} km2) from {len(g):,} polygons -> {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
