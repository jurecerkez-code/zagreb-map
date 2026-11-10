"""Zagreb: the real photo colours (scripts/sample_ortho.py) into the version as two small binaries.

    uv run python -m pipeline.run s06_zagreb_ortho -- --version vYYYYMMDD-x

  data/ortho/roof_rgb.parquet  (gid, r, g, b)  -> web/data/<version>/roof_rgb.bin   header (uint32 W, uint32 rows),
                                                  then RGBA8 rows, 512 px wide, row = gid / 512,
                                                  alpha 255 where sampled, 0 where not
  data/ortho/ground_rgb.npz    (arr nz, nx, 3) -> web/data/<version>/ground_rgb.bin header (uint32 nx, uint32 nz),
                                                  then RGBA8, width nx, height nz, row 0 = the grid's z0,
                                                  alpha 255

Colours are the mean of each footprint's own pixels in the City of Zagreb orthophoto (Ortofoto2022 WMS). Licence
credit 'Grad Zagreb'; the permission email is out (27.10.2026), so the 'foto' look that reads these files stays a
local evaluation until the City answers. Nothing is invented: a building with no samples keeps alpha 0 and the
renderer falls back to the look's period colour.
"""
import argparse
import gzip
import json
import struct
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from . import compact, io

DATA = Path("data")
WEB = Path("web") / "data"
W = 512


def write_ortho_payloads(out, roof, ground):
    """Keep exact legacy RGBA8 buffers and add deterministic gzip under the issue's exact filenames."""
    out = Path(out)
    for name, rgba in (("roof_rgb", roof), ("ground_rgb", ground)):
        rgba = np.asarray(rgba)
        if rgba.dtype != np.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4 or 0 in rgba.shape:
            raise ValueError(f"{name}: expected a non-empty RGBA8 array")
        raw = struct.pack("<II", rgba.shape[1], rgba.shape[0]) + rgba.tobytes()
        io._write(out / f"{name}.bin.gz", gzip.compress(raw, 6, mtime=0))


def write_ground_compact(out, rgb, grid, slopes):
    """Ground samples in one global grid: xyz decimetres, measured sRGB, source index 1, milli-degree slope.

    The caller derives slope from the actual terrain cells (including both edges); zero is level, not a made-up roof
    pitch or a placeholder observation. No RGBA/RGB12 precision loss is introduced on this colour copy.
    """
    out = Path(out)
    rgb, h, slopes = np.asarray(rgb), np.asarray(grid["h"]), np.asarray(slopes)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.shape[:2] != h.shape or slopes.shape != h.shape:
        raise ValueError("ground HDR18: RGB, heights and slopes have different grids")
    nz, nx = h.shape
    cell = float(grid["cell"])
    if not nx or not nz or not np.isfinite(cell) or cell <= 0:
        raise ValueError("ground HDR18: empty grid or invalid cell")
    rows = []
    for j in range(nz):
        for i in range(nx):
            rows.append({"x": float(grid["x0"]) + i * cell, "z": float(grid["z0"]) + j * cell, "y": h[j, i],
                         "rgb": rgb[j, i].tolist(), "ortho": 1, "slope": slopes[j, i]})
    io._write(out / "ground0.bin", compact.pack_hdr18(rows))
    doc = {"version": 2, "format": "zagreb-ground2", "file": "ground0.bin", "w": nx, "h": nz,
           "x0": grid["x0"], "z0": grid["z0"], "cell": cell, "count": nx * nz,
           "palette": [{"index": 1, "name": "City of Zagreb Ortofoto2022 WMS", "colour": "per-record sRGB"}]}
    io.write_json(out / "ground2.json", doc)
    return doc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    args = ap.parse_args(argv)
    out = WEB / args.version
    out.mkdir(parents=True, exist_ok=True)

    n_b = len(pq.read_table(DATA / "buildings.parquet", columns=["gid"]))
    roof = np.zeros((int(np.ceil(n_b / W)) * W, 4), dtype=np.uint8)
    t = pq.read_table(DATA / "ortho" / "roof_rgb.parquet").to_pydict()
    gids = np.asarray(t["gid"], dtype=np.int64)
    cols = np.stack([np.asarray(t[c], dtype=np.uint8) for c in ("r", "g", "b")], 1)
    ok = (gids >= 0) & (gids < n_b)
    roof[gids[ok], :3] = cols[ok]
    roof[gids[ok], 3] = 255
    roof_rgba = roof.reshape(-1, W, 4)

    z = np.load(DATA / "ortho" / "ground_rgb.npz")
    arr = z["arr"]
    rgba = np.concatenate([arr, np.full(arr.shape[:2] + (1,), 255, np.uint8)], 2)
    tj = json.loads((DATA / "terrain.json").read_text())
    assert (tj["nx"], tj["nz"]) == (rgba.shape[1], rgba.shape[0]), "ground colours do not match the terrain grid"
    write_ortho_payloads(out, roof_rgba, rgba)
    compact.write_compact_config(out, "orthoGz", True)

    print(f"roof_rgb.bin {roof.shape[0] // W} rows x {W} px ({int(ok.sum()):,} of {n_b:,} buildings sampled); "
          f"ground_rgb.bin {rgba.shape[1]} x {rgba.shape[0]}; into {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
