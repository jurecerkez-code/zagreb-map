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
import json
import struct
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

DATA = Path("data")
WEB = Path("web") / "data"
W = 512


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
    (out / "roof_rgb.bin").write_bytes(struct.pack("<II", W, roof.shape[0] // W) + roof.tobytes())

    z = np.load(DATA / "ortho" / "ground_rgb.npz")
    arr = z["arr"]
    rgba = np.concatenate([arr, np.full(arr.shape[:2] + (1,), 255, np.uint8)], 2)
    (out / "ground_rgb.bin").write_bytes(struct.pack("<II", rgba.shape[1], rgba.shape[0]) + rgba.tobytes())
    tj = json.loads((DATA / "terrain.json").read_text())
    assert (tj["nx"], tj["nz"]) == (rgba.shape[1], rgba.shape[0]), "ground colours do not match the terrain grid"

    print(f"roof_rgb.bin {roof.shape[0] // W} rows x {W} px ({int(ok.sum()):,} of {n_b:,} buildings sampled); "
          f"ground_rgb.bin {rgba.shape[1]} x {rgba.shape[0]}; into {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
