"""Sample the City of Zagreb's public orthophoto into real colours: one mean colour per building roof and one per
terrain node, measured from the photograph of that exact footprint. No invented materials: a roof is the colour of
its own pixels in the aerial image.

    uv run python scripts/sample_ortho.py [--tile 2400] [--px 2048] [--limit N]

Source: https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer, layer ZG_CDOF2022, EPSG:3765,
JPEG. Tiles are cached under data/raw/ortho/ so a rerun costs nothing. Licence: City of Zagreb orthophoto WMS, credit
'Grad Zagreb' (use pending the permission email of 27.10.2026; local evaluation only until then).

Outputs (under the engine's data/):
  data/ortho/roof_rgb.parquet   gid int32, r g b uint8 (mean over the rasterized footprint pixels)
  data/ortho/ground_rgb.npz     arr uint8 (nz, nx, 3) on the terrain grid of data/terrain.json, plus x0, z0, cell
Buildings that rasterize to no pixel stay out; the renderer falls back to the look's period colour.
"""
import argparse
import json
import time
import urllib.request
from pathlib import Path

import geopandas as gpd
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import rasterio.features
from PIL import Image
from rasterio.transform import from_bounds
from shapely import box

WMS = ("https://geoportal.zagreb.hr/Public/Ortofoto2022_Public/MapServer/WMSServer"
       "?service=WMS&version=1.1.1&request=GetMap&layers=ZG_CDOF2022&srs=EPSG:3765"
       "&width={w}&height={h}&format=image/jpeg&styles=&bbox={e0},{n0},{e1},{n1}")
DATA = Path("data")
CACHE = DATA / "raw" / "ortho"
ORIGIN = (459370.1, 5074937.5)      # city.py ORIGIN, EPSG:3765
SLEEP = 0.4                          # be polite to the City's server


def fetch_tile(e0, n0, e1, n1, w, h) -> np.ndarray:
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / f"t_{int(e0)}_{int(n0)}_{int(e1)}_{int(n1)}_{w}.jpg"
    if not p.exists():
        url = WMS.format(e0=f"{e0:.1f}", n0=f"{n0:.1f}", e1=f"{e1:.1f}", n1=f"{n1:.1f}", w=w, h=h)
        req = urllib.request.Request(url, headers={"User-Agent": "ZagrebByBuilding/0.1 (local evaluation)"})
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
        if len(body) < 5000:
            raise RuntimeError(f"not an image: {url} -> {body[:120]!r}")
        p.write_bytes(body)
        time.sleep(SLEEP)
    return np.asarray(Image.open(p).convert("RGB"))


def integral(img: np.ndarray) -> np.ndarray:
    ii = np.zeros((img.shape[0] + 1, img.shape[1] + 1, 3), dtype=np.float64)
    ii[1:, 1:] = img.astype(np.float64).cumsum(0).cumsum(1)
    return ii


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tile", type=float, default=2400.0)
    ap.add_argument("--px", type=int, default=2048)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--bbox", type=str, default="", help="e0,n0,e1,n1 in EPSG:3765 (a quick test area)")
    args = ap.parse_args()

    b = gpd.read_parquet(DATA / "buildings.parquet")[["gid", "geometry"]]
    minx, miny, maxx, maxy = b.total_bounds
    xs = np.arange(np.floor(minx / args.tile) * args.tile, maxx + args.tile, args.tile)
    ys = np.arange(np.floor(miny / args.tile) * args.tile, maxy + args.tile, args.tile)
    tiles = [(x, y) for y in ys for x in xs]
    if args.bbox:
        e0, n0, e1, n1 = (float(v) for v in args.bbox.split(","))
        tiles = [(x, y) for x, y in tiles if x < e1 and x + args.tile > e0 and y < n1 and y + args.tile > n0]
    if args.limit:
        tiles = tiles[: args.limit]

    t = json.loads((DATA / "terrain.json").read_text())
    cell, nx, nz, gx0, gz0 = t["cell"], t["nx"], t["nz"], t["x0"], t["z0"]
    ex = ORIGIN[0] + (gx0 + np.arange(nx + 1) * cell)      # node edges, E (increasing)
    en = ORIGIN[1] - (gz0 + np.arange(nz + 1) * cell)      # node edges, N (decreasing with j)
    ground = np.zeros((nz, nx, 3), dtype=np.float64)
    gcount = np.zeros((nz, nx), dtype=np.int32)
    roofs = {}
    total_px = 0
    t0 = time.time()

    for k, (x0, y0) in enumerate(tiles, 1):
        x1, y1 = x0 + args.tile, y0 + args.tile
        img = fetch_tile(x0, y0, x1, y1, args.px, args.px)
        tr = from_bounds(x0, y0, x1, y1, args.px, args.px)

        sub = b.iloc[np.flatnonzero(b.geometry.intersects(box(x0, y0, x1, y1)).to_numpy())]
        if len(sub):
            ids = sub.gid.to_numpy()
            lab = rasterio.features.rasterize(((g, i + 1) for i, g in enumerate(sub.geometry.to_numpy())),
                                              out_shape=(args.px, args.px), transform=tr,
                                              fill=0, dtype="int32", all_touched=False)
            flat = lab.ravel()
            m = flat > 0
            if m.any():
                idx = flat[m] - 1
                cnt = np.bincount(idx, minlength=len(ids))
                rgb = np.stack([np.bincount(idx, weights=img[..., c].ravel()[m], minlength=len(ids))
                                for c in range(3)], 1)
                ok = cnt > 0
                mean = (rgb[ok] / cnt[ok, None]).round().astype(np.uint8)
                for g, col in zip(ids[ok], mean):
                    roofs[int(g)] = (int(col[0]), int(col[1]), int(col[2]))
                total_px += int(m.sum())

        # ground: one mean per terrain node cell inside this tile, all at once through an integral image
        ei = np.flatnonzero((ex[:-1] < x1) & (ex[1:] > x0))
        ji = np.flatnonzero((en[:-1] > y0) & (en[1:] < y1))
        if len(ei) and len(ji):
            ii = integral(img)
            px = lambda E: np.clip(np.round((E - x0) / args.tile * args.px), 0, args.px).astype(int)
            py = lambda N: np.clip(np.round((y1 - N) / args.tile * args.px), 0, args.px).astype(int)
            xa, xb = px(ex[ei]), px(ex[ei + 1])
            ya, yb = py(en[ji]), py(en[ji + 1])
            S = ii[np.ix_(yb, xb)] - ii[np.ix_(ya, xb)] - ii[np.ix_(yb, xa)] + ii[np.ix_(ya, xa)]
            n = ((yb - ya)[:, None] * (xb - xa)[None, :]).clip(1)
            ground[np.ix_(ji, ei)] += S / n[..., None]
            gcount[np.ix_(ji, ei)] += 1

        if k % 20 == 0 or k == len(tiles):
            print(f"[{time.time() - t0:6.0f}s] {k}/{len(tiles)} tiles, {len(roofs)} roofs, "
                  f"{int((gcount > 0).sum())} ground nodes", flush=True)

    ok = gcount > 0
    ground_rgb = np.zeros((nz, nx, 3), dtype=np.uint8)
    ground_rgb[ok] = (ground[ok] / gcount[ok, None]).round().astype(np.uint8)

    out = DATA / "ortho"
    out.mkdir(parents=True, exist_ok=True)
    gids = np.fromiter(roofs.keys(), dtype=np.int32)
    cols = np.array(list(roofs.values()), dtype=np.uint8)
    pq.write_table(pa.table({"gid": gids, "r": cols[:, 0], "g": cols[:, 1], "b": cols[:, 2]}),
                   out / "roof_rgb.parquet")
    np.savez_compressed(out / "ground_rgb.npz", arr=ground_rgb, x0=gx0, z0=gz0, cell=cell)

    print(f"done: {len(roofs)}/{len(b)} buildings ({100 * len(roofs) / len(b):.1f}%), "
          f"{int(ok.sum())}/{nz * nx} ground nodes, {total_px:,} roof px, {time.time() - t0:.0f}s")
    if len(cols):
        print("mean sampled roof rgb:", cols.reshape(-1, 3).mean(0).round().astype(int).tolist())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
