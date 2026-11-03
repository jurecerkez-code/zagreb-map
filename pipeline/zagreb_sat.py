"""Zagreb port: the satellite lower bound "built after 1990 / 2000" for the card (text only, never a year).

The rule is the one validated in docs/ghsl-validation.md (pipeline/ghsl_periods.py at the project root), sampled at
each of TODAY's buildings (its representative point), so it is keyed by today's gid:

  GHSL GHS-BUILT-S R2023A, 100 m, epochs 1975..2020 (CC BY 4.0): the first epoch the 1 ha cell holds >= T_BUILT m2
  of built-up surface; the cell is "greenfield" when it held < G_EMPTY m2 at the epoch before. TRUSTED = greenfield,
  first built 1995..2015, and WSF Evolution (DLR, CC BY 4.0) shows no settlement in the 3x3 (90 m) window up to 1985.
  The card says the land was still empty in 1990 (first built 1995/2000) or 2000 (first built 2005..2015).

s01_zagreb writes data/sat.parquet (gid, sat); s03_tiles puts `sat` on the card only where the building has no
other year (yflag UNKNOWN); it never changes year, period or colour.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import shapely

EPOCHS = list(range(1975, 2021, 5))
T_BUILT = 300
G_EMPTY = 150
TRUSTED_FIRST_EPOCHS = (1995, 2000, 2005, 2010, 2015)
WSF_EMPTY_UNTIL = 1985


def sample(points_3765, ghsl_dir: Path, wsf_dir: Path) -> pd.DataFrame:
    import rasterio
    from pyproj import Transformer
    from rasterio.windows import from_bounds
    from scipy.ndimage import minimum_filter

    x, y = shapely.get_coordinates(points_3765).T
    mx, my = Transformer.from_crs(3765, "ESRI:54009", always_xy=True).transform(x, y)
    B = np.zeros((len(x), len(EPOCHS)), np.float32)
    for i, e in enumerate(EPOCHS):
        with rasterio.open(ghsl_dir / f"GHS_BUILT_S_E{e}_GLOBE_R2023A_54009_100_V1_0_R4_C20.tif") as r:
            w = from_bounds(mx.min() - 500, my.min() - 500, mx.max() + 500, my.max() + 500,
                            r.transform).round_offsets().round_lengths()
            a = r.read(1, window=w).astype(np.float32)
            if r.nodata is not None:
                a[a == r.nodata] = np.nan
            tr = r.window_transform(w)
        col = np.floor((mx - tr.c) / tr.a).astype(int)
        row = np.floor((my - tr.f) / tr.e).astype(int)
        B[:, i] = a[row, col]
    lon, lat = Transformer.from_crs(3765, 4326, always_xy=True).transform(x, y)
    wsf3 = np.zeros(len(x), np.int32)
    for f in sorted(wsf_dir.glob("WSFevolution_v1_*.tif")):
        L0, B0 = (int(v) for v in f.stem.split("_")[-2:])
        m = (lon >= L0) & (lon < L0 + 2) & (lat >= B0) & (lat < B0 + 2)
        if not m.any():
            continue
        with rasterio.open(f) as r:
            w = from_bounds(lon[m].min() - .01, lat[m].min() - .01, lon[m].max() + .01, lat[m].max() + .01,
                            r.transform).round_offsets().round_lengths()
            a = r.read(1, window=w, boundless=True, fill_value=0)
            t = r.window_transform(w)
        c = np.floor((lon[m] - t.c) / t.a).astype(int)
        rr = np.floor((lat[m] - t.f) / t.e).astype(int)
        mn = minimum_filter(np.where(a > 0, a, 9999), size=3, mode="nearest")[rr, c]
        wsf3[m] = np.where(mn == 9999, 0, mn)
    return bounds(B, wsf3)


def bounds(B: np.ndarray, wsf3: np.ndarray) -> pd.DataFrame:
    n = len(B)
    built = B >= T_BUILT
    fe = np.where(built.any(1), np.array(EPOCHS)[built.argmax(1)], 0)
    idx = np.searchsorted(EPOCHS, np.maximum(fe, 1975))
    prev = np.where(fe > 1975, B[np.arange(n), np.maximum(idx - 1, 0)], np.nan)
    green = (fe > 1975) & (np.nan_to_num(prev, nan=1e9) < G_EMPTY)
    # wsf3: earliest settlement year in the 3x3 window (0 = none by 2015: excluded, as in the validated rule)
    wsf_ok = wsf3 > WSF_EMPTY_UNTIL
    trusted = green & np.isin(fe, TRUSTED_FIRST_EPOCHS) & wsf_ok
    lb = np.where(fe > 1975, fe - 5, 0)
    sat = np.where(trusted, np.where(lb >= 2000, 2000, 1990), 0).astype(np.int16)
    return pd.DataFrame({"first_epoch": fe.astype(np.int16), "wsf3": wsf3, "sat": sat})
