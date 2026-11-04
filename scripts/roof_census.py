"""What colours Zagreb's roofs actually are: a census of data/ortho/roof_rgb.parquet.

s06_zagreb_ortho sampled the City's Ortofoto2022 WMS per footprint, so every gid carries a measured sRGB mean.
This script answers the two questions someone dressing the map asks:

  1. what the dominant real roof colours are (k-means over 297k buildings), and
  2. how they differ by era (gid -> years.parquet join): Donji grad's tile vs Novi Zagreb's slabs.

    uv run python scripts/roof_census.py
"""
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles on redirected pipes

DATA = Path(__file__).resolve().parents[1] / "data"
K = 8
ITERS = 16
SURVEY = {  # names for the era bins: Zagreb PERIODS yearMax edges
    "pre-1880": (-10_000, 1879),
    "1880-1918": (1880, 1918),
    "1919-1945": (1919, 1945),
    "1946-1990": (1946, 1990),
    "1991+": (1991, 10_000),
    "unknown": None,
}


def kmeans(rgb: np.ndarray, k: int, iters: int, seed: int = 7):
    rng = np.random.default_rng(seed)
    sub = rgb[rng.choice(len(rgb), min(60_000, len(rgb)), replace=False)].astype(np.float64)
    # k-means++ init
    cent = [sub[rng.integers(len(sub))]]
    for _ in range(k - 1):
        d = np.min(((sub[:, None, :] - np.array(cent)[None, :, :]) ** 2).sum(-1), axis=1)
        cent.append(sub[rng.choice(len(sub), p=d / d.sum())])
    C = np.array(cent)
    for _ in range(iters):
        lab = ((sub[:, None, :] - C[None, :, :]) ** 2).sum(-1).argmin(1)
        C = np.array([sub[lab == i].mean(0) if np.any(lab == i) else C[i] for i in range(k)])
    # full-set assignment
    lab_all = ((rgb.astype(np.float64)[:, None, :] - C[None, :, :]) ** 2).sum(-1).argmin(1)
    return C, lab_all


def hx(c) -> str:
    r, g, b = [int(round(v)) for v in c]
    return f"#{r:02x}{g:02x}{b:02x}"


def family(c) -> str:
    r, g, b = c
    hi, lo = max(c), min(c)
    if hi < 96:
        return "dark roof (asphalt/shade)"
    if g > r and g - b > 8:
        return "patina green"
    if r > b and r - b > 20:
        return "terracotta / red tile"
    if hi - lo < 14:
        return "concrete/flat pale" if hi > 150 else "grey slab"
    return "mixed"


def main() -> None:
    roof = pq.read_table(DATA / "ortho/roof_rgb.parquet").to_pandas()
    rgb = roof[["r", "g", "b"]].to_numpy()
    C, lab = kmeans(rgb, K, ITERS)
    order = np.argsort([-(lab == i).sum() for i in range(K)])
    print(f"buildings: {len(roof):,} (all roofs sampled from the City's Ortofoto2022 WMS, credit 'Grad Zagreb')\n")
    print("dominant measured colours (whole city):")
    clusters = []
    for n, i in enumerate(order, 1):
        c = C[i]
        share = (lab == i).mean() * 100
        clusters.append((hx(c), share, family(c)))
        print(f"  {n}. {hx(c)}  {share:5.1f}%   {family(c)}")

    # per era: same k-means assignment, best-effort year join (unmatched gids ignored)
    yrs = pq.read_table(DATA / "years.parquet").to_pandas()
    if "gid" not in yrs.columns and "gid" in roof.columns:
        print("\n(years.parquet has no gid column; era split skipped)")
        return
    m = roof[["gid"]].reset_index(drop=True)
    m["cluster"] = [hx(C[i]) for i in lab]
    m = m.merge(yrs[["gid", "year"]], on="gid", how="left")
    yrs_col = m["year"].fillna(-1).to_numpy()
    print("\nby era (share of that era's buildings):")
    for name, span in SURVEY.items():
        if name == "unknown":
            # years.parquet encodes unknown as 0 — 0 would also pass every open-ended span and quietly suck the
            # whole city into "pre-1880", so it must be excluded before any era is bucketed
            mask = (yrs_col <= 0) | (yrs_col > 5000)
        else:
            lo, hi = span
            mask = (yrs_col > 0) & (yrs_col >= lo) & (yrs_col <= hi)
        tot = int(mask.sum())
        if tot < 50:
            continue
        counts = m.loc[mask, "cluster"].value_counts()
        top = ", ".join(f"{cl} {cnt/tot*100:.0f}%" for cl, cnt in counts.head(4).items())
        print(f"  {name:11s} n={tot:6,}  {top}")
    # named census file for future work (the foto look, when the City answers)
    import json
    out = DATA / "ortho/roof_census.json"
    out.write_text(json.dumps({"buildings": len(roof), "clusters": [
        {"hex": h, "share": round(s, 2), "family": f} for h, s, f in clusters]}, indent=2))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
