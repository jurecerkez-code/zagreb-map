"""Zagreb port: the one adapter step that replaces s00_fetch_* .. s02_terrain for Gradska četvrt Donji grad.

Inputs (city.SOURCE; paths relative to the engine folder; downloaded once, outside the pipeline; see RUN.md):
  input/zg3d_donji.geojson    City of Zagreb ZG3D 2022 LoD2.2, Donji grad: 7,121 building parts, EPSG:4326 (OBJECTID,
                           Z_Min ground m a.s.l., Z_Max roof, Z_Delta height m). Godina_izv is the SURVEY year (2022),
                           never a construction year.
  input/donji_joined.geojson  the same 7,121 parts in the same order, joined to the Zagreb Building Stock Model (Zenodo
                           10.5281/zenodo.13602015, CC BY-SA 4.0): cls exact | pre1968 | 1968-2007 | unknown, y (exact
                           year), dat, adr, naz, aut, nam.

Writes, with the columns and dtypes the later steps (s03_tiles, s04_base, s07_labels, s14_search, s99) read:
  data/buildings.parquet   gid, uuid, oid, grupp, kategori, fastighet, height, ground, area, prod_year, fnr, geometry
  data/years.parquet       gid, year, year_from, year_to, ysrc, yflag, period, private, raa_id, landmark
  data/attributes.parquet  gid, floors, fsrc, rating, architects, name, floors_h, floors_osm, prot, since, nofloors
  data/addresses.parquet, data/districts.parquet
  data/terrain.npz, data/terrain.json, data/ground.parquet (the ground from the parts' Z_Min, above city.DATUM_M)
  data/accuracy.json (no estimate tier), data/wiki.parquet + photos.json + extracts.json (empty), data/landmarks.json ([])
  data/domain.geojson (s04_base's land: the parts grown by DOMAIN_GROW_M), data/labels_zagreb.json (s07_labels)

Years, honestly: cls exact -> EXACT with ysrc SRC_ZBSM. 'pre1968' and '1968-2007' are real source
classes, so they become BOUND with year_from = 0 and year = year_to = 1968 / 2007; they enter their bound's
own film/chart bucket and legend counts, rather than borrowing 1968 as a fabricated start. Nothing is estimated.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from scipy.spatial import cKDTree

from . import city, codes, terrain
from .addresses import numbers
from .estimate import no_external
from .s02_attributes import floors_from_height

HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parent                   # the engine folder: city.SOURCE paths are relative to it
ZG3D = SRC_DIR / "input" / "zg3d_donji.geojson"
JOINED = SRC_DIR / "input" / "donji_joined.geojson"
DATA = Path("data")
DOMAIN_GROW_M = 80.0      # the land reaches this far past the outermost building
TERRAIN_R_M = 60.0        # a terrain node is a low percentile of the parts' Z_Min within this radius
TERRAIN_PCT = 10.0
DISTRICT = "DONJI GRAD"
MIN_HEIGHT_M = 0.5
SMALL_WORDS = {"i", "u", "na", "od", "do", "kralja", "bana", "grofa", "kneza", "braće", "ulica", "trg", "prilaz",
               "park", "biskupa", "kardinala", "dr.", "sv.", "svetog", "svete", "fra", "pape", "kraljice"}


def street_case(s: str) -> str:
    """'PRILAZ GJURE DEŽELIĆA' -> 'Prilaz Gjure Deželića' (Croatian style: titles and 'ulica', 'trg' lower inside)."""
    words = s.strip().lower().split()
    out = []
    for i, w in enumerate(words):
        out.append(w if (i and w in SMALL_WORDS) else w[:1].upper() + w[1:])
    return " ".join(out)


def parse_addresses(adr) -> list[tuple[str, str]]:
    """'MASARYKOVA 10; VARŠAVSKA 3-5' -> [('Masarykova', '10'), ('Varšavska', '3'), ('Varšavska', '5')]."""
    out = []
    if not isinstance(adr, str):
        return out
    adr = re.sub(r"\s+Zagreb\s+\d{5}\s+Zagreb\s*$|\s+\d{5}\s+Zagreb\s*$", "", adr.strip())
    for part in re.split(r"\s*;\s*|\s*/\s*(?=[^\W\d_])", adr):
        part = re.sub(r"(\d)/\d+", r"\1", part)          # 89/1: a flat or wing number, the house is 89
        m = re.match(r"^(.*?[^\d\s.,][^\d]*?)\s+(\d.*)$", part)
        if not m:
            continue
        street = street_case(re.sub(r"\s+ulica$", "", m.group(1).rstrip(" ,"), flags=re.I))
        for n in numbers(m.group(2)):
            if (street, n) not in out:
                out.append((street, n))
    return out


def parse_architects(aut) -> list[str]:
    """'Fischer, Ignjat; Turina, V.(1956)' -> ['Ignjat Fischer', 'V. Turina (1956)']: 'Surname, First' flipped,
    anything else kept as written."""
    out = []
    if not isinstance(aut, str):
        return out
    for part in re.split(r"\s*;\s*", aut.strip()):
        part = " ".join(part.split()).strip('"\u201c\u201d\u201e ')
        m = re.fullmatch(r"([^,()]+),\s*([^,()]+?)\s*(\(.*\))?", part)
        name = f"{m.group(2)} {m.group(1)}" + (f" {m.group(3)}" if m.group(3) else "") if m else part
        if name and name not in out:
            out.append(name)
    return out


def card_name(naz) -> str:
    if not isinstance(naz, str):
        return ""
    n = " ".join(naz.split())
    return "" if n.casefold() in city.GENERIC_NAMES or re.fullmatch(city.GENERIC_NAME_RE, n) else n


def polygons_only(g):
    g = shapely.make_valid(g)
    polys = [p for p in getattr(g, "geoms", [g]) if isinstance(p, (shapely.Polygon, shapely.MultiPolygon))]
    return shapely.union_all(polys) if polys else shapely.Polygon()


def _clean_geoms(geoms) -> np.ndarray:
    geom = shapely.force_2d(np.asarray(geoms, dtype=object))
    geom = np.array([polygons_only(g) for g in geom], dtype=object)
    return shapely.normalize(shapely.simplify(geom, city.SIMPLIFY, preserve_topology=True))


PROP_COLS = ("cls", "y", "dat", "adr", "naz", "aut", "nam")


def load_geojson_pair(src: dict) -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    """The Donji grad pilot inputs: ZG3D GeoJSON (EPSG:4326) + the ZBSM-joined GeoJSON, same parts in the same order."""
    z = gpd.read_file(src["zg3d"])
    j = gpd.read_file(src["joined"])
    if len(z) != len(j):
        raise SystemExit(f"{src['zg3d']} has {len(z)} features, {src['joined']} {len(j)}: they must be the same parts")
    d = shapely.hausdorff_distance(shapely.force_2d(z.geometry.values), shapely.force_2d(j.geometry.values))
    if np.nanmax(d) > 1e-5:   # degrees, about 1 m
        raise SystemExit("the two GeoJSONs are not the same parts in the same order (their outlines differ)")
    props = pd.DataFrame({c: (j[c] if c in j else pd.Series([None] * len(j))) for c in PROP_COLS})
    z = z.set_crs(4326, allow_override=True).to_crs(city.CRS)
    out = gpd.GeoDataFrame({"oid": z.OBJECTID.astype("int64").to_numpy(), "z_min": z.Z_Min.to_numpy(float),
                            "z_max": z.Z_Max.to_numpy(float), "height": z.Z_Delta.to_numpy(float)},
                           geometry=_clean_geoms(z.geometry.values), crs=city.CRS)
    return out, props


def load_geoparquet(src: dict) -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    """Any GeoParquet of building parts (e.g. the whole city's ZG3D, data/processed/zagreb_buildings.parquet) with
    height, z_min, z_max, optionally the ZBSM columns (cls, y, adr, naz, aut, nam); cut to src['bbox'] (EPSG:3765
    e0, n0, e1, n1: representative point inside) or src['district'] (a polygon file: inside it). Without ZBSM columns
    every year is unknown."""
    g = gpd.read_parquet(src["path"])
    g = g.to_crs(city.CRS) if g.crs is not None else g.set_crs(city.CRS)
    rep = shapely.point_on_surface(g.geometry.values)
    keep = np.ones(len(g), bool)
    if src.get("bbox"):
        e0, n0, e1, n1 = src["bbox"]
        x, y = shapely.get_x(rep), shapely.get_y(rep)
        keep &= (x >= e0) & (x <= e1) & (y >= n0) & (y <= n1)
    if src.get("district"):
        area = shapely.union_all(gpd.read_file(src["district"]).to_crs(city.CRS).geometry.values)
        keep &= shapely.contains(area, rep)
    g = g[keep].reset_index(drop=True)
    oid = g[src.get("id_col", "oid")] if src.get("id_col", "oid") in g else pd.Series(np.arange(len(g)))
    out = gpd.GeoDataFrame({"oid": oid.astype("int64").to_numpy(), "z_min": g.z_min.to_numpy(float),
                            "z_max": g.z_max.to_numpy(float), "height": g.height.to_numpy(float)},
                           geometry=_clean_geoms(g.geometry.values), crs=city.CRS)
    props = pd.DataFrame({c: (g[c] if c in g else pd.Series([None] * len(g))) for c in PROP_COLS})
    if props.cls.isna().all():
        props["cls"] = "unknown"
    return out, props


def load_parts() -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    """city.SOURCE picks the input: {"kind": "geojson_pair", ...} (the pilot) or {"kind": "geoparquet", ...}."""
    src = dict(getattr(city, "SOURCE", {"kind": "geojson_pair"}))
    src.setdefault("zg3d", ZG3D)
    src.setdefault("joined", JOINED)
    for k in ("zg3d", "joined", "path", "district"):
        if src.get(k) and not Path(src[k]).is_absolute():
            src[k] = SRC_DIR / src[k]
    return load_geoparquet(src) if src["kind"] == "geoparquet" else load_geojson_pair(src)


def build_terrain(b: gpd.GeoDataFrame, zmin: np.ndarray, dom) -> tuple[terrain.Grid, np.ndarray]:
    """The grid over the domain; each node the TERRAIN_PCT percentile of the Z_Min (above DATUM_M) of the parts whose
    representative point lies within TERRAIN_R_M (the parts on roofs sit high, so a low percentile is the street);
    nodes with none take the nearest node that has one; then one 3x3 smoothing pass."""
    cfg = city.TERRAIN
    minx, miny, maxx, maxy = dom.bounds
    x0, z0 = city.to_local(minx, maxy)
    x1, z1 = city.to_local(maxx, miny)
    grid = terrain.grid_for((float(x0), float(z0), float(x1), float(z1)), cfg["cell"])
    nx_, nz_ = grid.node_xz()
    rep = shapely.point_on_surface(b.geometry.values)
    px, pz = city.to_local(shapely.get_x(rep), shapely.get_y(rep))
    tree = cKDTree(np.c_[px, pz])
    nodes = np.c_[nx_.ravel(), nz_.ravel()]
    h = np.full(len(nodes), np.nan)
    for k, idx in enumerate(tree.query_ball_point(nodes, TERRAIN_R_M)):
        if len(idx) >= 3:
            h[k] = np.percentile(zmin[idx], TERRAIN_PCT)
    have = np.isfinite(h)
    if not have.any():
        raise SystemExit("no terrain node has buildings near it")
    _, nearest = cKDTree(nodes[have]).query(nodes[~have])
    h[~have] = h[have][nearest]
    h = h.reshape(grid.nz, grid.nx)
    pad = np.pad(h, 1, mode="edge")
    h = sum(pad[i:i + grid.nz, j:j + grid.nx] for i in range(3) for j in range(3)) / 9.0
    h = np.maximum(h, cfg["water_z"] + cfg["ground_min"])
    return grid, h.astype(np.float32)


def street_labels(addr: pd.DataFrame, b: gpd.GeoDataFrame) -> list[dict]:
    """One s07_labels candidate per street with buildings: at the middle of its addressed buildings, along their main
    axis (PCA), as long as they reach. Street names only; no water."""
    out = []
    c = shapely.centroid(b.geometry.values)
    e, n = shapely.get_x(c), shapely.get_y(c)
    for street, rows in addr.groupby("street"):
        g = np.unique(rows.gid.to_numpy())
        pts = np.c_[e[g], n[g]]
        mid = pts.mean(axis=0)
        if len(g) >= 2 and np.ptp(pts, axis=0).max() > 15:
            _, _, vt = np.linalg.svd(pts - mid, full_matrices=False)
            de, dn = vt[0]
            proj = (pts - mid) @ vt[0]
            length = float(max(60.0, np.ptp(proj)))
        else:
            de, dn, length = 1.0, 0.0, 60.0
        ang = float(np.degrees(np.arctan2(-dn, de)))     # local: from +x towards +z (south)
        out.append({"name": street, "water": False, "e": float(mid[0]), "n": float(mid[1]), "ang": ang,
                    "len": round(length), "width": 12.0})
    return out


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def years_for(cls, values, gids=None) -> pd.DataFrame:
    """Ship the real pre1968 / 1968-2007 classes as one-sided upper bounds, not UNKNOWN."""
    cls = np.asarray(cls)
    exact = cls == "exact"
    bound = np.select([cls == "pre1968", cls == "1968-2007"], [1968, 2007], default=0).astype(np.int16)
    exact_value = pd.to_numeric(pd.Series(values), errors="coerce").fillna(0).astype(int).to_numpy()
    exact &= exact_value > 0
    year = np.where(exact, exact_value, bound).astype(np.int16)
    source = exact | (bound > 0)
    flag = np.where(exact, codes.EXACT, np.where(source, codes.BOUND, codes.UNKNOWN)).astype(np.uint8)
    src = np.where(source, codes.SRC_ZBSM, codes.SRC_NONE).astype(np.uint8)
    n = len(year)
    return pd.DataFrame({
        "gid": np.arange(n, dtype=np.int32) if gids is None else gids,
        "year": year, "year_from": np.where(exact, year, 0).astype(np.int16),
        "year_to": np.where(source, year, 0).astype(np.int16), "ysrc": src, "yflag": flag,
        "period": np.where(source, city.period_indices(np.where(source, year, 2000)), 0).astype(np.uint8),
        "private": np.zeros(n, bool), "raa_id": pd.array([""] * n, dtype="str"),
        "landmark": pd.array([""] * n, dtype="str"),
    })


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="s01_zagreb", description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="ignored (the version the later steps write)")
    ap.parse_args([] if argv is None else argv)
    DATA.mkdir(exist_ok=True)
    if dict(getattr(city, "SOURCE", {})).get("kind") == "city":
        # the whole city: merged parts, OSM + Wikidata + ZBSM years, estimates, water (pipeline/zagreb_city.py)
        from types import SimpleNamespace
        from .s01_zagreb_city import main_city
        main_city(dict(city.SOURCE), SimpleNamespace(clean=_clean_geoms, MIN_HEIGHT_M=MIN_HEIGHT_M,
                                                     card_name=card_name, parse_architects=parse_architects,
                                                     parse_addresses=parse_addresses))
        return
    z, p = load_parts()
    n = len(z)
    if n < city.MIN_BUILDINGS:
        raise SystemExit(f"{n} parts, fewer than city.MIN_BUILDINGS {city.MIN_BUILDINGS}")
    gid = np.arange(n, dtype=np.int32)
    zmin = z.z_min.to_numpy(np.float64) - city.DATUM_M
    # a part under MIN_HEIGHT_M (ZG3D has slivers of a few cm) is drawn at it: 0 dm would read as no height
    height = np.maximum(z.height.to_numpy(np.float64), MIN_HEIGHT_M)
    kategori = p.get("nam", pd.Series([None] * n)).fillna("").astype(str).to_numpy()

    # buildings.parquet
    b = gpd.GeoDataFrame({
        "gid": gid, "uuid": z.oid.astype(str).to_numpy(), "oid": z.oid.to_numpy(),
        "grupp": np.full(n, "ZG3D"), "kategori": kategori, "fastighet": np.full(n, ""),
        "height": height.astype("float32"), "ground": zmin.astype("float32"),
        "area": z.geometry.area.astype("float32").to_numpy(), "prod_year": np.zeros(n, "int16"),
        "fnr": np.zeros(n, "int64"),
    }, geometry=z.geometry.values, crs=city.CRS)
    empty = b.geometry.is_empty.to_numpy()
    if empty.any():
        raise SystemExit(f"{int(empty.sum())} parts have no polygon after make_valid")
    b.to_parquet(DATA / "buildings.parquet", index=False)

    # years.parquet
    cls = p.cls.to_numpy()
    exact = cls == "exact"
    years = years_for(cls, p.get("y"), gid)
    exact = years.yflag.to_numpy() == codes.EXACT
    yflag = years.yflag.to_numpy()
    period = years.period.to_numpy()
    years.to_parquet(DATA / "years.parquet", index=False)

    # attributes.parquet
    floors_h = floors_from_height(height, kategori).astype(np.uint8)
    names = [card_name(v) for v in p.get("naz", pd.Series([None] * n))]
    attrs = pd.DataFrame({
        "gid": gid, "floors": floors_h, "fsrc": np.full(n, codes.FLOORS_HEIGHT, np.uint8),
        "rating": np.zeros(n, np.uint8), "architects": [parse_architects(v) for v in p.get("aut", [None] * n)],
        "name": pd.array(names, dtype="str"), "floors_h": floors_h, "floors_osm": np.zeros(n, np.uint8),
        "prot": np.zeros(n, np.uint8), "since": np.zeros(n, np.int16), "nofloors": np.zeros(n, bool),
    })
    attrs.to_parquet(DATA / "attributes.parquet", index=False)

    # addresses.parquet, districts.parquet
    rows = [(g, s, num) for g, adr in zip(gid, p.get("adr", [None] * n)) for s, num in parse_addresses(adr)]
    addr = pd.DataFrame(rows, columns=["gid", "street", "number"]).astype({"gid": "int32"})
    addr["withheld"] = False
    addr.to_parquet(DATA / "addresses.parquet", index=False)
    pd.DataFrame({"gid": gid, "district": np.full(n, DISTRICT)}).to_parquet(DATA / "districts.parquet", index=False)

    # domain, terrain, ground
    dom = shapely.make_valid(shapely.union_all(shapely.buffer(b.geometry.values, DOMAIN_GROW_M, quad_segs=4))
                             .buffer(-DOMAIN_GROW_M / 2).simplify(5.0))
    if dom.geom_type == "MultiPolygon":
        dom = max(dom.geoms, key=lambda g: g.area) if len(dom.geoms) else dom
    dom = shapely.Polygon(dom.exterior)            # no holes: courtyards and parks are land
    gpd.GeoDataFrame({"name": [DISTRICT]}, geometry=[dom], crs=city.CRS).to_file(DATA / "domain.geojson",
                                                                                  driver="GeoJSON")
    grid, h = build_terrain(b, zmin, dom)
    polys = terrain.to_local(b.geometry.values)
    tmin = terrain.outline_min(lambda pts: terrain.bilinear(grid, h, pts[:, 0], pts[:, 1]), polys)
    cfg = city.TERRAIN
    ground, hgt, fixed = terrain.fix_grounds(zmin, height, tmin, cfg["fix_m"]["zg3d"])
    drawn = np.maximum(ground, cfg["water_z"] + cfg["ground_min"])
    floors = floors_from_height(hgt, kategori).astype(np.uint8)
    g = pd.DataFrame({"gid": gid, "ground": drawn.astype(np.float32), "height": hgt.astype(np.float32),
                      "floors": floors, "ground_src": fixed.astype(np.uint8), "tmin": tmin.astype(np.float32)})
    g.to_parquet(DATA / "ground.parquet", index=False)
    cut = np.zeros_like(h)
    np.savez_compressed(DATA / "terrain.npz", h=h, cut=cut, use=np.ones_like(h, dtype=bool),
                        levels=np.zeros(0, np.float32))
    ok = np.isfinite(tmin)
    record = {"source": "zg3d", **grid.to_dict(), "water_z": cfg["water_z"], "levels": 0, "water_area": 0.0,
              "datum": round(float(np.median(zmin[ok] - tmin[ok])), 3), "fixed": int(fixed.sum()), "lakes": 0,
              "fixture": False, "buried": 0, "relief_max": cfg["relief_max"], "floating": 0, "sea": None,
              "datum_m": city.DATUM_M, "buildings_sha256": sha(DATA / "buildings.parquet"),
              "attributes_sha256": sha(DATA / "attributes.parquet")}
    (DATA / "terrain.json").write_text(json.dumps(record, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    # the steps s03_tiles expects from the Stockholm tiers: no estimates, no wiki, no landmarks
    p_est = city.ESTIMATE
    accuracy = {"method": "none", "held_out": "kvarter", "folds": p_est["folds"], "near_m": p_est["near_m"],
                "min_cell": p_est["min_cell"], "min_right": p_est["min_right"], "max_band": p_est["max_band"],
                "tested": int(exact.sum()), "cells": [], "fallback": [], "band_coverage": None,
                "by_true_period": [{"period": q[0], "n": 0, "right": 0, "n_estimate": 0, "right_estimate": 0}
                                   for q in city.PERIODS],
                "result": {"estimate": 0, "period": 0, "unknown": int((yflag == codes.UNKNOWN).sum())},
                "area": {"n": 0, "status": "not measurable"}, "external": no_external()}
    (DATA / "accuracy.json").write_text(json.dumps(accuracy, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    pd.DataFrame({"gid": pd.Series([], dtype="int32"), "qid": pd.Series([], dtype=str),
                  "name": pd.Series([], dtype=str), "name_en": pd.Series([], dtype=str),
                  "langs": pd.Series([], dtype=str), "photo": pd.Series([], dtype=str)}).to_parquet(
        DATA / "wiki.parquet", index=False)
    for name, value in (("photos.json", {}), ("extracts.json", {}), ("landmarks.json", [])):
        (DATA / name).write_text(json.dumps(value) + "\n", encoding="utf-8")
    labels = street_labels(addr, b)
    (DATA / "labels_zagreb.json").write_text(json.dumps(labels, ensure_ascii=False, indent=1) + "\n",
                                             encoding="utf-8")

    print(f"wrote data/ for {n:,} Donji grad parts: {int(exact.sum())} exact years (ZBSM), "
          f"{int((yflag == codes.BOUND).sum())} cadastre bounds ({int((cls == 'pre1968').sum())} before 1968, "
          f"{int((cls == '1968-2007').sum())} before 2007), {int((yflag == codes.UNKNOWN).sum())} unknown in all; periods "
          f"{np.bincount(period[exact], minlength=len(city.PERIODS)).tolist()}; {len(addr)} addresses on "
          f"{addr.gid.nunique()} parts, {addr.street.nunique()} streets; {sum(bool(x) for x in names)} named; "
          f"terrain {grid.nx} x {grid.nz} nodes, {float(h.min()):.1f}-{float(h.max()):.1f} m above {city.DATUM_M:g} m, "
          f"{int(fixed.sum())} grounds raised to the street; domain {dom.area / 1e6:.2f} km²")


if __name__ == "__main__":
    main(sys.argv[1:])
