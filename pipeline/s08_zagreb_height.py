"""Zagreb: the height of the city, one number per 16 m cell, for the sun's shadows.

    uv run python -m pipeline.s08_zagreb_height --version vYYYYMMDD-x

Written into web/data/<version>/:
  city_height.bin.gz  gzip of a uint16 little endian array, decimetres, row major over the vegetation mask's
                    grid. 12.8 MB raw, 4.9 MB over the wire: the array is mostly flat ground, so gzip pays for
                    itself and the browser inflates it with DecompressionStream (2026-11-03).
  city_height.json  {w, h, x0, z0, cell, units, max_m, min_m, buildings, source}

What a cell holds: the highest thing standing in it, the ground (the terrain model) or the roof of a building on it.
That is the only question a shadow needs answered: standing on a piece of street and looking towards the sun, is
anything along that line taller than the line itself. Nothing is extrapolated: the terrain is the model the map draws
and the buildings are the ones the map draws, with the heights it already shows.

Resolution: the terrain grid is 40 m and the buildings are real footprints, so 16 m cells (the grid the green cover
already uses) let one building throw a shadow its own width instead of smearing it across two streets.
"""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from rasterio.features import rasterize
from rasterio.transform import Affine

DATA = Path("data")
WEB = Path("web") / "data"
ORIGIN = (459370.1, 5074937.5)      # city.py ORIGIN, EPSG:3765
CELL = 16.0
UNITS = 0.1                          # decimetres: the 1033 m of Medvednica still fits in a uint16


def bilinear(t, h, XX, ZZ):
    i = np.clip((XX - t["x0"]) / t["cell"], 0, t["nx"] - 1.001)
    j = np.clip((ZZ - t["z0"]) / t["cell"], 0, t["nz"] - 1.001)
    i0, j0 = np.floor(i).astype(int), np.floor(j).astype(int)
    fi, fj = i - i0, j - j0
    return ((h[j0, i0] * (1 - fi) + h[j0, i0 + 1] * fi) * (1 - fj)
            + (h[j0 + 1, i0] * (1 - fi) + h[j0 + 1, i0 + 1] * fi) * fj)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    args = ap.parse_args(argv)
    out = WEB / args.version
    out.mkdir(parents=True, exist_ok=True)

    t = json.loads((DATA / "terrain.json").read_text())
    h = np.load(DATA / "terrain.npz")["h"].astype(np.float64)
    mask = json.loads((out / "veg.json").read_text())["green"]["mask"]
    w, hh, x0, z0 = mask["w"], mask["h"], mask["x0"], mask["z0"]

    XX, ZZ = np.meshgrid(x0 + (np.arange(w) + 0.5) * CELL, z0 + (np.arange(hh) + 0.5) * CELL)
    ground = bilinear(t, h, XX, ZZ)

    b = pd.read_parquet(DATA / "buildings.parquet", columns=["gid", "geometry"])
    g = pd.read_parquet(DATA / "ground.parquet", columns=["gid", "ground", "height"])
    df = b.merge(g, on="gid", how="left")
    # ground.parquet: `ground` is the terrain at the footprint (metres above datum), `height` the building's own height
    df["top"] = df["ground"].fillna(0.0) + df["height"].fillna(0.0).clip(0, 400)

    # Rasterized straight in EPSG:3765, with a transform that lands the pixels on the same 16 m grid the mask uses:
    # column = easting, row = -northing (so row grows with z, exactly as the green cover's rows do).
    grid = Affine(CELL, 0.0, x0 + ORIGIN[0], 0.0, -CELL, ORIGIN[1] - z0)
    roofs = rasterize(list(zip(df.geometry.to_numpy(), df["top"].to_numpy(dtype="float64"))),
                      out_shape=(hh, w), transform=grid, fill=0.0, all_touched=True, dtype="float32")

    city = np.maximum(ground, roofs)
    data = np.clip(np.round(city / UNITS), 0, 65535).astype("<u2")
    (out / "city_height.bin.gz").write_bytes(gzip.compress(data.tobytes(), 6))
    meta = {"w": int(w), "h": int(hh), "x0": float(x0), "z0": float(z0), "cell": CELL, "units": UNITS, "gz": True,
            "min_m": round(float(city.min()), 1), "max_m": round(float(city.max()), 1), "buildings": int(len(df)),
            "source": "the terrain model (data/terrain.npz) and the rendered buildings (buildings.parquet, ground.parquet)"}
    (out / "city_height.json").write_text(json.dumps(meta, indent=1))
    print(f"city height {w}x{hh} at {CELL:.0f} m: {city.min():.1f} to {city.max():.1f} m, "
          f"{len(df):,} footprints painted, {data.nbytes / 1e6:.1f} MB -> web/data/{args.version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
