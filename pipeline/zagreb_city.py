"""Zagreb port, whole city: s01_zagreb's loader for city.SOURCE kind "city" (all 17 gradske četvrti).

Inputs (paths in city.SOURCE, relative to the engine folder; the OSM and Wikidata files come from
pipeline/zagreb_osm.py and pipeline/zagreb_wikidata.py, run once by hand):
  parts     ZG3D 2022 building PARTS for all of Zagreb (GeoParquet, EPSG:3765: zg3d_id, height, z_min, z_max)
  osm       zg_osm_buildings / zg_osm_admin / zg_osm_water / zg_osm_streets / zg_osm_addr_points .parquet
  wikidata  zg_wikidata.parquet (one row per item and date property, with its precision)
  zbsm      the Zagreb Building Stock Model GeoJSON (Zenodo 10.5281/zenodo.13602015, CC BY-SA 4.0)
  dem       Copernicus GLO-30 DSM tiles (only where no building tells the ground)

1. Parts inside the Grad Zagreb boundary (OSM, admin_level 4), by representative point.
2. Merge: parts whose representative point falls in the same OSM building polygon become ONE building (one gid,
   card, year). Its footprint is the union of its parts, drawn at the lowest part's top; every taller part is a
   further part of that building (data/towers.parquet, drawn from the building's ground to the part's own top; see
   s03_tiles.tower_parts). Parts in no OSM building stay single buildings.
3. Years, best source first: ZBSM heritage rows > other ZBSM rows > Wikidata > OSM start_date. Spans follow the
   engine (one year EXACT; span <= 15 RANGE showing the last year; longer LONG showing the first). Cadastre cut-offs
   ('prije 15.2.1968.', 'prije 1.10.2007.'), centuries and 'before X' are not years. Disagreements of more than
   DISAGREE_YEARS go to data/year_disagreements.csv.
4. The estimate tier (pipeline/estimate.py) as in husforhus: whole 250 m blocks held out, a cell is estimated only
   with >= 70% right period, a band <= 15 years and 30+ test buildings, and only for the groups in
   city.ESTIMATE["estimate_groups"].
5. Private houses (OSM house types, plus small unnamed residential buildings) publish only their decade.
"""
import json
import re
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from scipy.spatial import cKDTree

from . import city, codes, terrain
from . import estimate as est
from .s02_attributes import floors_from_height
from .s02_years import MIN_PRIVATE_OVERLAP, PERIOD_FROM, PERIOD_TO
from .yearrules import FLOOR_YEAR, LATEST_YEAR

DATA = Path("data")
DISAGREE_YEARS = 10
LONG_SPAN = 15
MIN_ASL = 95.0            # m a.s.l.; a part below this is a survey error (the Sava leaves Zagreb at ~100 m)
WD_NEAR_M = 10.0          # a Wikidata point outside every footprint takes the nearest within this
HOUSE_TYPES = {"house", "detached", "semidetached_house", "terrace", "bungalow", "cabin", "farm", "villa"}
HOUSE_INFER = dict(types={"yes", "residential"}, max_area=250.0, max_height=12.0)
YEAR = r"(1[0-9]{3}|20[0-2][0-9])"


# ---------------------------------------------------------------- year parsing
def span_flag(y0: int, y1: int) -> tuple[int, int, int, int]:
    """(year, from, to, yflag) for a span, by the engine's rule."""
    y0, y1 = min(y0, y1), max(y0, y1)
    if y0 == y1:
        return y0, y0, y0, codes.EXACT
    if y1 - y0 <= LONG_SPAN:
        return y1, y0, y1, codes.RANGE
    return y0, y0, y1, codes.LONG


def parse_osm_date(s) -> tuple | None:
    """OSM start_date → (year, from, to, yflag, precision) or None (centuries, 'before', anything vague)."""
    if not isinstance(s, str):
        return None
    t = s.strip().lower()
    if m := re.fullmatch(rf"{YEAR}(-\d\d){{0,2}}", t):
        y = int(m.group(1))
        return (*span_flag(y, y), "year")
    if m := re.fullmatch(rf"~\s*{YEAR}", t) or re.fullmatch(rf"(?:ca\.?|c\.|circa|approx\.?)\s*{YEAR}", t):
        y = int(m.group(1))
        return (*span_flag(y - 5, y + 5)[:3], codes.RANGE, "circa")
    if m := re.fullmatch(rf"{YEAR}(?:-\d\d){{0,2}}\s*(?:\.\.|–|-|/)\s*{YEAR}(?:-\d\d){{0,2}}", t):
        return (*span_flag(int(m.group(1)), int(m.group(2))), "span")
    if m := re.fullmatch(r"(1[0-9]{2}0|20[0-2]0)s", t):
        y = int(m.group(1))
        return (*span_flag(y, y + 9), "decade")
    return None


def parse_zbsm(text, y2) -> tuple | None:
    """ZBSM `datacija` (text) and `datacija2` (int) → (year, from, to, yflag) or None for the cadastre cut-offs."""
    if not isinstance(text, str) or not text.strip() or text.strip().startswith("prije"):
        return None
    t = text.strip()
    # '1934.-35.' (short second year) and '1955.-64.'
    years = []
    for m in re.finditer(r"(\d{4})\.?\s*[-–]\s*(\d{2,4})\.", t):
        a, b = m.group(1), m.group(2)
        years += [int(a), int(a[:4 - len(b)] + b)]
    years += [int(y) for y in re.findall(r"(?<!\d)(\d{4})(?!\d)", t)]
    years = sorted({y for y in years if 1000 <= y <= LATEST_YEAR})
    if not years:
        y = int(y2) if pd.notna(y2) and 1000 <= int(y2) <= LATEST_YEAR else 0
        return (*span_flag(y, y),) if y else None
    if len(years) == 1:
        return span_flag(years[0], years[0])
    return span_flag(years[0], years[-1])


def parse_wd(rows: pd.DataFrame) -> tuple | None:
    """One item's dates → (year, from, to, yflag, precision): P571 first, else P1619, else P729; precision 9+ is a
    year, 8 a decade; coarser values are dropped. Several values of the same property make a span."""
    for prop in ("P571", "P1619", "P729"):
        r = rows[(rows.prop == prop) & (rows.prec >= 8)]
        if not len(r):
            continue
        lo, hi = [], []
        for y, prec in zip(r.year, r.prec):
            lo.append(y // 10 * 10 if prec == 8 else y)
            hi.append(y // 10 * 10 + 9 if prec == 8 else y)
        res = span_flag(min(lo), max(hi))
        return (*res, "decade" if (r.prec == 8).all() else "year")
    return None


# ---------------------------------------------------------------- inputs
def boundary(osm: Path):
    adm = gpd.read_parquet(osm / "zg_osm_admin.parquet")
    city_poly = adm[(adm["name"] == "Grad Zagreb") & (adm.admin_level == "4")]
    if not len(city_poly):
        raise SystemExit("no 'Grad Zagreb' admin_level 4 polygon in zg_osm_admin.parquet")
    dom = shapely.make_valid(shapely.force_2d(city_poly.geometry.union_all()))
    cet = adm[(adm.admin_level == "9") & adm["name"].str.startswith("Gradska četvrt")].copy()
    cet["key"] = cet["name"].str.removeprefix("Gradska četvrt ").str.upper()
    cet = cet[cet.key.isin(list(city.DISTRICT_NAMES))].dissolve("key", as_index=False)   # Zagreb's 17 only
    return dom, cet


def load_parts(path: Path, dom, clean) -> gpd.GeoDataFrame:
    g = gpd.read_parquet(path, columns=["zg3d_id", "height", "z_min", "z_max", "geometry"])
    g = g.to_crs(city.CRS) if g.crs is not None else g.set_crs(city.CRS)
    g = g[g.geometry.notna().to_numpy() & ~g.geometry.is_empty.to_numpy()].reset_index(drop=True)
    rep = shapely.point_on_surface(np.asarray(g.geometry.values, dtype=object))
    shapely.prepare(dom)
    keep = shapely.contains(dom, rep)
    g = g[keep].reset_index(drop=True)
    out = gpd.GeoDataFrame({"oid": pd.to_numeric(g.zg3d_id, errors="coerce").fillna(-1).astype("int64").to_numpy(),
                            "z_min": g.z_min.to_numpy(float), "z_max": g.z_max.to_numpy(float),
                            "height": g.height.to_numpy(float)},
                           geometry=clean(g.geometry.values), crs=city.CRS)
    # ZG3D has 133 broken parts with Z_Min/Z_Max of 0..72 m a.s.l. (Zagreb lies at 100 m and up): left out
    ok = ~out.geometry.is_empty.to_numpy() & np.isfinite(out.z_min.to_numpy()) & np.isfinite(out.z_max.to_numpy()) \
        & (out.z_min.to_numpy() >= MIN_ASL) & (out.z_max.to_numpy() >= MIN_ASL)
    print(f"left out {int((~ok).sum())} parts with no outline or a height under {MIN_ASL:g} m a.s.l.")
    return out[ok].reset_index(drop=True)


def within(points, polys, choose_small=True) -> np.ndarray:
    """Index into polys of the polygon containing each point (the smallest when several), -1 for none."""
    tree = shapely.STRtree(polys)
    pi, gi = tree.query(points, predicate="within")
    out = np.full(len(points), -1, dtype=np.int64)
    if len(pi):
        area = shapely.area(np.asarray(polys)[gi])
        order = np.lexsort((area if choose_small else -area, pi))
        pi, gi = pi[order], gi[order]
        first = np.r_[True, pi[1:] != pi[:-1]]
        out[pi[first]] = gi[first]
    return out


# ---------------------------------------------------------------- split oversized ZG3D features
# ZG3D sometimes models a whole city block as ONE feature (several stacked slabs, each the size of the block): drawn
# as is, that is a 37,000 m2 plate lying across Trg bana Jelacica. Cut such features by the OSM building footprints
# that stand inside them, so every building in the block gets its own prism at the feature's own height.
MAX_FEATURE_M2 = 3000.0
MIN_OSM_IN_PART_M2 = 20.0


def split_oversized(parts: gpd.GeoDataFrame, osm_b: gpd.GeoDataFrame):
    """Parts bigger than MAX_FEATURE_M2 are cut by the OSM footprints inside them (each cut keeps the part's z)."""
    if not len(osm_b):
        return parts
    area = shapely.area(parts.geometry.values)
    big = np.flatnonzero(area > MAX_FEATURE_M2)
    if not len(big):
        return parts
    tree = shapely.STRtree(osm_b.geometry.values)
    geoms = list(parts.geometry.values)
    out_geoms, out_rows = [], []
    rest_idx = []
    for i in range(len(parts)):
        if area[i] <= MAX_FEATURE_M2:
            rest_idx.append(i)
    pieces = {i: [] for i in big}
    for i in big:
        cand = tree.query(geoms[i], predicate="intersects")
        keep = []
        for j in cand:
            poly = osm_b.geometry.iat[j]
            if poly.area < MIN_OSM_IN_PART_M2:
                continue
            cut = shapely.intersection(geoms[i], poly)
            if cut.is_empty or shapely.area(cut) < MIN_OSM_IN_PART_M2:
                continue
            keep.append(cut)
        pieces[i] = keep
    keep_rows = [i for i in big if pieces[i]]
    skip = set(big) - set(keep_rows)
    base = parts.loc[parts.index[rest_idx + sorted(skip)]].copy()
    add = parts.loc[parts.index[keep_rows]].copy()
    rows, geos = [], []
    for i in keep_rows:
        for cut in pieces[i]:
            rows.append(i)
            geos.append(cut)
    add2 = parts.loc[parts.index[rows]].copy()
    add2["geometry"] = geos
    # a small cut of a big block (a kiosk, a shelter, the plinth under a statue) must not inherit the block's
    # height: that is the 35 m cube that stood on Trg bana Jelacica. Cap small cuts at 8 m above their own ground.
    small = shapely.area(add2.geometry.values) < 120.0
    if small.any():
        cap = add2.z_min.to_numpy()[small] + 8.0
        add2.loc[small, "z_max"] = np.minimum(add2.z_max.to_numpy()[small], cap)
    out = pd.concat([base, add2], ignore_index=True)
    return gpd.GeoDataFrame(out, geometry="geometry", crs=parts.crs)


# ---------------------------------------------------------------- merge
# A merged building is only trusted up to this footprint area: bigger OSM polygons are city blocks, squares or
# courtyards that swallow several ZG3D features, and drawing them as one slab put blocks across Trg bana Jelacica and
# the Upper Town. Parts inside a bigger polygon stay single buildings.
MAX_MERGE_M2 = 6000.0


def merge(parts: gpd.GeoDataFrame, osm_b: gpd.GeoDataFrame):
    """(buildings frame with one row per gid, part→gid array, towers frame). See the module docstring."""
    rep = shapely.point_on_surface(parts.geometry.values)
    hit = within(rep, osm_b.geometry.values)
    if len(osm_b):
        big = shapely.area(osm_b.geometry.values) > MAX_MERGE_M2
        hit = np.where((hit >= 0) & big[np.maximum(hit, 0)], -1, hit)
    key = np.where(hit >= 0, hit, -1 - np.arange(len(parts)))
    _, gid_of_part = np.unique(key, return_inverse=True)
    # gids in a stable order: by the first part's position in the file
    first = pd.Series(np.arange(len(parts))).groupby(gid_of_part).min().to_numpy()
    remap = np.empty(len(first), np.int64)
    remap[np.argsort(first, kind="stable")] = np.arange(len(first))
    gid_of_part = remap[gid_of_part]
    n = len(first)
    zmin, zmax = parts.z_min.to_numpy(), parts.z_max.to_numpy()
    df = pd.DataFrame({"gid": gid_of_part, "zmin": zmin, "top": np.maximum(zmax, zmin + 0.5),
                       "area": shapely.area(parts.geometry.values), "osm": hit})
    agg = df.groupby("gid").agg(ground=("zmin", "min"), top_min=("top", "min"), top_max=("top", "max"),
                                n=("zmin", "size"), osm=("osm", "max"))
    groups = pd.Series(np.arange(len(parts))).groupby(gid_of_part).apply(list)
    geoms = parts.geometry.values
    union = np.empty(n, dtype=object)
    for g, idx in groups.items():
        union[g] = geoms[idx[0]] if len(idx) == 1 else shapely.make_valid(shapely.union_all(geoms[idx]))
    union = np.array([_polys(u) for u in union], dtype=object)
    first_part = pd.Series(np.arange(len(parts))).groupby(gid_of_part).min().sort_index().to_numpy()
    b = gpd.GeoDataFrame({"gid": np.arange(n), "oid": parts.oid.to_numpy()[first_part],
                          "zmin": agg.ground.to_numpy(), "top_min": agg.top_min.to_numpy(),
                          "top_max": agg.top_max.to_numpy(), "nparts": agg.n.to_numpy(), "osm": agg.osm.to_numpy()},
                         geometry=union, crs=city.CRS)
    # further parts: every part of a multi-part building that rises above its lowest top
    multi = agg.n.to_numpy()[gid_of_part] > 1
    taller = df.top.to_numpy() > agg.top_min.to_numpy()[gid_of_part] + 0.3
    sel = np.flatnonzero(multi & taller)
    towers = gpd.GeoDataFrame({"gid": gid_of_part[sel].astype(np.int64), "part": np.arange(len(sel)),
                               "top_z": (df.top.to_numpy()[sel] - city.DATUM_M).astype(np.float64)},
                              geometry=geoms[sel], crs=city.CRS)
    return b, gid_of_part, towers


def _polys(g):
    g = shapely.make_valid(g)
    ps = [p for p in getattr(g, "geoms", [g]) if isinstance(p, (shapely.Polygon, shapely.MultiPolygon))]
    return shapely.union_all(ps) if len(ps) > 1 else (ps[0] if ps else shapely.Polygon())


# ---------------------------------------------------------------- years
# Best source first (Jure, 2026-10-21): heritage records (KD_pojedinacna/RKD, KULTURA_ZASTITA buildings, OBNOVA_PROCELJA
# design dating) > ZBSM > Wikidata > OSM > a dated heritage ensemble (area) > the City's typology period (area,
# working data); the estimate tier only fills what is left, and s02_zagreb_curated overrides all of them afterwards.
PRIORITY = ("kd", "zg_her", "zg_facade", "zbsm_her", "zbsm", "wikidata", "osm", "zg_area", "zg_tipo")


def assign_years(b, parts, gid_of_part, osm_b, zbsm, wd, her=None):
    n = len(b)
    cand = {k: {} for k in PRIORITY}   # gid -> (year, from, to, flag, extra, ref)
    for k, v in (her or {}).items():
        cand[k] = v
    info = {"zbsm_rows": len(zbsm), "zbsm_exact_rows": 0}
    # ZBSM: part representative points in ZBSM polygons; the ZBSM row covering most of the building's part area wins
    rep = shapely.point_on_surface(parts.geometry.values)
    hit = within(rep, zbsm.geometry.values)
    parsed = [parse_zbsm(t, y2) for t, y2 in zip(zbsm.datacija, zbsm.datacija2)]
    pa = pd.DataFrame({"gid": gid_of_part, "z": hit, "a": shapely.area(parts.geometry.values)})
    pa = pa[pa.z >= 0].groupby(["gid", "z"]).a.sum().reset_index().sort_values(["gid", "a"], ascending=[True, False])
    zbsm_of_gid = {}
    for g, z in zip(pa.gid, pa.z):
        zbsm_of_gid.setdefault(int(g), int(z))
        p = parsed[z]
        if p is None:
            continue
        key = "zbsm_her" if isinstance(zbsm.status.iat[z], str) and zbsm.status.iat[z] else "zbsm"
        if g not in cand["zbsm_her"] and g not in cand["zbsm"]:
            cand[key][int(g)] = (*p, "", int(z))
    # OSM start_date: per OSM polygon, onto the building made from it
    osm_dates = [parse_osm_date(s) for s in osm_b.start_date]
    info["osm_tagged"] = int(osm_b.start_date.notna().sum())
    info["osm_parsed"] = sum(d is not None for d in osm_dates)
    for g, o in zip(b.gid, b.osm):
        if o >= 0 and osm_dates[o] is not None:
            cand["osm"][int(g)] = (*osm_dates[o][:4], osm_dates[o][4], int(o))
    # Wikidata: structures only; point in a building footprint, else the nearest within WD_NEAR_M
    s = wd[wd.structure]
    items = []
    for qid, rows in s.groupby("qid"):
        d = parse_wd(rows)
        if d is not None:
            items.append((qid, rows.iloc[0], d))
    info["wd_structures"] = int(s.qid.nunique())
    info["wd_dated"] = len(items)
    if items:
        pts = gpd.GeoSeries(gpd.points_from_xy([r.lon for _, r, _ in items], [r.lat for _, r, _ in items]),
                            crs=4326).to_crs(city.CRS).values
        g_in = within(pts, b.geometry.values)
        miss = g_in < 0
        if miss.any():
            tree = shapely.STRtree(b.geometry.values)
            qi, gi = tree.query_nearest(pts[miss], max_distance=WD_NEAR_M, return_distance=False)
            got = np.full(int(miss.sum()), -1)
            got[qi] = gi
            g_in[np.flatnonzero(miss)] = got
        info["wd_matched"] = int((g_in >= 0).sum())
        for (qid, r, d), g in zip(items, g_in):
            if g < 0:
                continue
            old = cand["wikidata"].get(int(g))
            if old is None or (old[3] != codes.EXACT and d[3] == codes.EXACT):
                cand["wikidata"][int(g)] = (*d[:4], d[4], qid)
    # pick, log disagreements
    year = np.zeros(n, np.int64)
    y_from, y_to = np.zeros(n, np.int64), np.zeros(n, np.int64)
    yflag = np.full(n, codes.UNKNOWN, np.int64)
    ysrc = np.full(n, codes.SRC_NONE, np.int64)
    winner = np.full(n, "", dtype=object)
    src_code = {"zbsm_her": codes.SRC_ZBSM, "zbsm": codes.SRC_ZBSM, "wikidata": codes.SRC_WIKIDATA,
                "osm": codes.SRC_OSM, "kd": codes.SRC_KD, "zg_her": codes.SRC_ZG_HER,
                "zg_facade": codes.SRC_ZG_FACADE, "zg_area": codes.SRC_ZG_AREA, "zg_tipo": codes.SRC_ZG_TIPO}
    review = []
    for key in PRIORITY[::-1]:       # lowest first, higher overwrites
        for g, v in cand[key].items():
            # A span does not replace an exact year inside it: the exact year is the same claim said precisely
            # (the Wikidata pick above prefers the exact year the same way, one source over).
            if yflag[g] == codes.EXACT and v[3] != codes.EXACT and v[1] <= year[g] <= v[2]:
                continue
            year[g], y_from[g], y_to[g], yflag[g] = v[:4]
            ysrc[g] = src_code[key]
            winner[g] = key
    for g in range(n):
        have = [(k, cand[k][g]) for k in PRIORITY if g in cand[k]]
        if len(have) < 2:
            continue
        k0, v0 = winner[g], cand[winner[g]][g]   # the year that ships, not the highest source
        for k, v in have[1:]:
            if v[2] < v0[1] - DISAGREE_YEARS or v[1] > v0[2] + DISAGREE_YEARS:
                review.append({"gid": g, "winner": k0, "winner_years": f"{v0[1]}-{v0[2]}",
                               "winner_ref": v0[5], "other": k,
                               "other_years": f"{v[1]}-{v[2]}", "other_ref": v[5]})
    # what lands on the map as an exact ZBSM year; the number of ZBSM rows whose text parsed is 4x that
    info["zbsm_exact_rows"] = int(((ysrc == codes.SRC_ZBSM) & (yflag == codes.EXACT)).sum())
    info["candidates"] = {k: len(v) for k, v in cand.items()}
    return dict(year=year, y_from=y_from, y_to=y_to, yflag=yflag, ysrc=ysrc, winner=winner, cand=cand,
                review=pd.DataFrame(review), zbsm_of_gid=zbsm_of_gid, items=items, info=info)


def run_estimate(b, kategori, height, district, y):
    """The husforhus estimate tier on the merged buildings. Returns the accuracy table; fills y in place."""
    frame = gpd.GeoDataFrame({"kategori": kategori, "height": height, "area": shapely.area(b.geometry.values),
                              "fastighet": np.full(len(b), "")}, geometry=b.geometry.values, crs=city.CRS)
    f = est.features(frame, stadsdel=district)
    dated = np.isin(y["yflag"], (codes.EXACT, codes.RANGE, codes.LONG))
    query = y["yflag"] == codes.UNKNOWN
    got, table = est.run(f, y["year"], dated, query, city.ESTIMATE, district)
    rows = np.flatnonzero(query & (got.yflag.to_numpy() == codes.ESTIMATE))
    if not len(rows):
        # Nothing passed the gates, so the tier ships no year: the table has to say so, or `tested` and the all-zero
        # estimate columns read as a measurement of a tier the map uses.
        table["method"] = (f"knn; the tier added nothing in this build: 0 of {int(query.sum()):,} undated buildings "
                           "passed the gates, so every estimate column is 0")
    yh = np.clip(np.round(got.yhat.to_numpy()[rows]), FLOOR_YEAR, LATEST_YEAR).astype(np.int64)
    bd = got.band.to_numpy()[rows]
    y["year"][rows], y["ysrc"][rows], y["yflag"][rows] = yh, codes.SRC_ESTIMATE, codes.ESTIMATE
    y["y_from"][rows] = np.maximum(FLOOR_YEAR, yh - bd)
    y["y_to"][rows] = np.minimum(LATEST_YEAR, yh + bd)
    ext = np.isin(y["ysrc"], (codes.SRC_WIKIDATA, codes.SRC_OSM))
    core = y["ysrc"] == codes.SRC_ZBSM
    table["external"] = est.check_external(f, np.where(dated, y["year"], 0), core, ext, table, city.ESTIMATE, district)
    table["area"] = {"n": 0, "status": "not measurable"}
    table["calibration"] = calibration(y, kategori)
    return table


def calibration(y, kategori):
    """The map's residential mix over the City model's five construction periods (city.CALIBRATION_TARGET,
    docs/faculty-paper.md), as shares of the dated residential buildings. The target is what the estimate
    tier's output must reproduce when it ships; `dated` measures the map's coverage against it today (the
    dated buildings are biased old and central) and `estimated` the estimates alone."""
    groups = np.array([city.KATEGORI_GROUPS.get(k, "unspecified") for k in kategori], dtype=object)
    res = np.isin(groups, ("house", "apartments"))
    year, flag = y["year"], y["yflag"]

    def mix(mask):
        m = res & mask & (year > 0)
        n = int(m.sum())
        share = {key: (float(np.sum(m & (year >= lo) & (year <= hi))) / n if n else 0.0)
                 for key, lo, hi in city.CALIBRATION_SPANS}
        return {"n": n, "share": share}

    return {"target": city.CALIBRATION_TARGET, "source": city.CALIBRATION_SOURCE,
            "dated": mix(np.ones(len(year), dtype=bool)),
            "estimated": mix(flag == codes.ESTIMATE)}


def privacy(y, private_rows):
    """A private house keeps the year and the bounds its source states. The owner's call, 2026-11-03: coarsening
    them to a decade hid real years from 1,800 buildings, and a window the source never stated is invented data.
    The `private` flag still travels, so the card can say the building is private."""
    year = y["year"]
    period = np.where(year > 0, city.period_indices(np.where(year > 0, year, 2000)), 0)
    private = private_rows & (y["yflag"] != codes.UNKNOWN)
    return period, private


# ---------------------------------------------------------------- water, terrain, labels
def dem_sampler(paths):
    import rasterio
    srcs = [rasterio.open(p) for p in paths]
    from pyproj import Transformer
    tr = Transformer.from_crs(city.CRS, 4326, always_xy=True)

    def sample(e, n):
        lon, lat = tr.transform(np.asarray(e), np.asarray(n))
        out = np.full(len(lon), np.nan)
        for s in srcs:
            l, b_, r, t = s.bounds
            m = (lon >= l) & (lon < r) & (lat > b_) & (lat <= t)
            if m.any():
                out[m] = [v[0] for v in s.sample(zip(lon[m], lat[m]))]
        return out
    return sample


def build_terrain(grid, b_rep_local, zmin_local, dem, cfg, radius=60.0, pct=10.0):
    """Nodes near buildings: the 10th percentile of the parts' Z_Min within `radius` (as in the pilot). Elsewhere the
    Copernicus DSM, opened by a 5x5 minimum (trees and roofs off), shifted onto the buildings' ground by the median
    difference where both exist. Then a 3x3 smoothing pass."""
    nx_, nz_ = grid.node_xz()
    nodes = np.c_[nx_.ravel(), nz_.ravel()]
    tree = cKDTree(b_rep_local)
    h = np.full(len(nodes), np.nan)
    for k, idx in enumerate(tree.query_ball_point(nodes, radius)):
        if len(idx) >= 3:
            h[k] = np.percentile(zmin_local[idx], pct)
    have = np.isfinite(h)
    e = nodes[:, 0] + city.ORIGIN[0]
    n = city.ORIGIN[1] - nodes[:, 1]
    d = dem(e, n) - city.DATUM_M
    d = d.reshape(grid.nz, grid.nx)
    from scipy.ndimage import minimum_filter, uniform_filter
    d = np.where(np.isfinite(d), d, np.nanmedian(d))
    d = uniform_filter(minimum_filter(d, size=5), size=3).ravel()
    shift = float(np.median(h[have] - d[have])) if have.any() else 0.0
    h = np.where(have, h, d + shift)
    h = h.reshape(grid.nz, grid.nx)
    pad = np.pad(h, 1, mode="edge")
    h = sum(pad[i:i + grid.nz, j:j + grid.nx] for i in range(3) for j in range(3)) / 9.0
    h = np.maximum(h, cfg["water_z"] + cfg["ground_min"])
    return h.astype(np.float32), shift, float(have.mean())


def split_water(water: list, size: float = 1000.0) -> list:
    """Cut each water polygon by a size-metre grid, so a sloping river gets a level per piece."""
    out = []
    for p in water:
        x0, y0, x1, y1 = p.bounds
        if max(x1 - x0, y1 - y0) <= size:
            out.append(p)
            continue
        for gx in np.arange(np.floor(x0 / size) * size, x1, size):
            for gy in np.arange(np.floor(y0 / size) * size, y1, size):
                cut = p.intersection(shapely.box(gx, gy, gx + size, gy + size))
                out += [q for q in getattr(cut, "geoms", [cut]) if q.geom_type == "Polygon" and q.area >= 30.0]
    return out


def street_candidates(streets: gpd.GeoDataFrame, dom, min_len=80.0) -> list[dict]:
    """s07_labels candidates on the real OSM centrelines: per street name, its lines merged; one candidate per
    merged line at least min_len long, at the line's middle, along its tangent there, as long as the line (capped)."""
    width = {"primary": 24.0, "trunk": 24.0, "secondary": 18.0, "tertiary": 14.0}
    out = []
    streets = streets[streets.highway.isin(["motorway", "trunk", "primary", "secondary", "tertiary", "residential",
                                            "unclassified", "living_street", "pedestrian", "service"])]
    streets = streets[~((streets.highway == "service"))]
    for name, rows in streets.groupby("name"):
        merged = shapely.line_merge(shapely.union_all(shapely.force_2d(rows.geometry.values)))
        hw = rows.highway.mode().iat[0]
        for line in getattr(merged, "geoms", [merged]):
            if line.geom_type != "LineString" or line.length < min_len:
                continue
            m = line.interpolate(0.5, normalized=True)
            if not dom.contains(m):
                continue
            a = line.interpolate(max(line.length / 2 - 10, 0))
            c = line.interpolate(min(line.length / 2 + 10, line.length))
            de, dn = c.x - a.x, c.y - a.y
            out.append({"name": name, "water": False, "e": m.x, "n": m.y,
                        "ang": float(np.degrees(np.arctan2(-dn, de))), "len": round(min(line.length, 400.0)),
                        "width": width.get(hw, 12.0)})
    return out


def water_candidates(water_named: gpd.GeoDataFrame) -> list[dict]:
    out = []
    for name, rows in water_named.groupby("name"):
        g = shapely.union_all(rows.geometry.values)
        for p in sorted(getattr(g, "geoms", [g]), key=lambda q: -q.area)[:6]:
            if p.area < 20_000:
                continue
            r = shapely.minimum_rotated_rectangle(p)
            c = np.asarray(r.exterior.coords)[:4]
            sides = [c[1] - c[0], c[2] - c[1]]
            long_side = max(sides, key=lambda v: np.hypot(*v))
            m = p.point_on_surface()
            out.append({"name": name, "water": True, "e": m.x, "n": m.y,
                        "ang": float(np.degrees(np.arctan2(-long_side[1], long_side[0]))),
                        "len": round(float(min(np.hypot(*long_side), 1500.0))), "width": 80.0})
    return out


def river_candidates(lines: gpd.GeoDataFrame, water: list, dom, every_m: float = 2500.0) -> list[dict]:
    """Water-name candidates along named river lines (OSM riverbank polygons rarely carry the name): every every_m
    along each merged line, where the line runs over a water polygon; s07 keeps them MIN_SEP apart."""
    out = []
    wet = shapely.union_all(water) if water else shapely.Polygon()
    shapely.prepare(wet)
    for name, rows in lines[lines.waterway == "river"].groupby("name"):
        merged = shapely.line_merge(shapely.union_all(shapely.force_2d(rows.geometry.values)))
        for line in getattr(merged, "geoms", [merged]):
            if line.geom_type != "LineString":
                continue
            for d in np.arange(every_m / 2, line.length, every_m):
                m = line.interpolate(d)
                if not (dom.contains(m) and wet.contains(m)):
                    continue
                a, c = line.interpolate(max(d - 50, 0)), line.interpolate(min(d + 50, line.length))
                out.append({"name": name, "water": True, "e": m.x, "n": m.y,
                            "ang": float(np.degrees(np.arctan2(-(c.y - a.y), c.x - a.x))), "len": 600, "width": 80.0})
    return out


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
