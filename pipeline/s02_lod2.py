"""Zagreb port: draw every building from ZG3D's LoD2.2 roof faces (pipeline/zagreb_lod2.py) instead of one box per part.

Runs after s01_zagreb and changes ONLY the drawn geometry: data/ground.parquet `height` (the footprint, now at the
building's lowest roof band) and data/towers.parquet (every higher band, drawn from the building's ground to its
top_z by s03_tiles.tower_parts). buildings.parquet, years, attributes, cards and gids are not touched; the step
checks that the ZG3D parts → gid merge it rebuilds is exactly s01's.

Inputs: the district SHP/FGDB files under city.SOURCE["lod2"] (one folder per gradska četvrt, see RUN.md), the ZG3D
parts and OSM buildings s01 used. Roof faces are assigned to the building whose footprint holds their representative
point; a ZG3D part whose footprint the faces cover less than MIN_COVER of is drawn as before (a flat face at its
Z_Max). Writes data/lod2_report.json (counts, match rates, the validation buildings before and after) and keeps the
LoD1 inputs as data/ground_lod1.parquet / data/towers_lod1.parquet.
"""
import argparse
import hashlib
import json
import os
import shutil
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from . import city
from . import zagreb_lod2 as L

DATA = Path("data")
SRC_DIR = Path(__file__).resolve().parent.parent
MIN_COVER = 0.3          # roof-face area / part area under this: the part keeps its LoD1 box
CHUNKS = 64
ROOF_RADIUS_M = 3500      # real roofs only where the near LOD can see them; farther tiles keep the flat roof
MIN_HEIGHT_M = 0.5
CHECK = {"cathedral": [92387], "sv_marko": [89124], "hnk": [53384], "zagrepcanka": [294236, 294237, 294238, 294239],
         "glavni_kolodvor": [52056]}


def log(t0, msg):
    print(f"[{time.perf_counter() - t0:6.1f} s] {msg}", flush=True)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def district_files(root: Path) -> list[Path]:
    out = []
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        shp = sorted(d.glob("*.shp")) or sorted(d.glob("*.gdb"))
        if not shp:
            raise SystemExit(f"{d}: no .shp or .gdb (see RUN.md, ZG3D LoD2 inputs)")
        out.append(shp[0])
    return out


def parts_and_gids(b: gpd.GeoDataFrame, t0) -> gpd.GeoDataFrame:
    """s01's ZG3D parts with the gid s01's merge gave each (cached in data/lod2_parts.parquet for this buildings
    file). Refuses to go on when the rebuilt merge differs from data/buildings.parquet."""
    cache, rec = DATA / "lod2_parts.parquet", DATA / "lod2_parts.json"
    bsha = sha(DATA / "buildings.parquet")
    if cache.exists() and rec.exists() and json.loads(rec.read_text())["buildings_sha256"] == bsha:
        return gpd.read_parquet(cache)
    from . import zagreb_city as zc
    from .s01_zagreb import _clean_geoms
    src = dict(city.SOURCE)
    rel = lambda k: (SRC_DIR / src[k]) if not Path(src[k]).is_absolute() else Path(src[k])  # noqa: E731
    dom, _ = zc.boundary(rel("osm"))
    parts = zc.load_parts(rel("parts"), dom, _clean_geoms)
    osm_b = gpd.read_parquet(rel("osm") / "zg_osm_buildings.parquet")
    osm_b = osm_b[~osm_b.geometry.is_empty & osm_b.geometry.notna()].reset_index(drop=True)
    osm_b["geometry"] = shapely.make_valid(osm_b.geometry.values)
    parts = zc.split_oversized(parts, osm_b)
    bb, gid_of_part, _ = zc.merge(parts, osm_b)
    if len(bb) != len(b) or not np.array_equal(bb.oid.to_numpy(), b.oid.to_numpy()) \
            or not np.array_equal(bb.nparts.to_numpy(), b.nparts.to_numpy()):
        raise SystemExit("the rebuilt ZG3D merge differs from data/buildings.parquet (run s01_zagreb again)")
    d = shapely.hausdorff_distance(bb.geometry.values[::97], b.geometry.values[::97])
    if np.nanmax(d) > 0.01:
        raise SystemExit(f"rebuilt footprints differ from data/buildings.parquet by up to {np.nanmax(d):.2f} m")
    out = gpd.GeoDataFrame({"oid": parts.oid.to_numpy(), "gid": gid_of_part.astype(np.int64),
                            "z_min": parts.z_min.to_numpy(), "z_max": parts.z_max.to_numpy()},
                           geometry=parts.geometry.values, crs=city.CRS)
    out.to_parquet(cache, index=False)
    rec.write_text(json.dumps({"buildings_sha256": bsha}) + "\n")
    log(t0, f"rebuilt s01's merge: {len(out):,} parts → {len(b):,} gids, identical to buildings.parquet")
    return out


def _roof_triangles(fgid, face2d, unit, zmin, zmax, cent, grounds):
    """Triangulate every roof face into planar triangles, grouped by gid; vertices are deduplicated at 0.1 m.
    Returns {gid: {"xz": (n, 2) EPSG:3011 E/N, "y": (n,) metres above the building's drawn ground, "tri": (m, 3)}}."""
    out = {}
    for f in range(len(face2d)):
        gid = int(fgid[f])
        if gid < 0 or unit[f, 2] <= 0.05:
            continue
        face = face2d[f]
        if face.is_empty or face.area < 0.01:
            continue
        try:
            parts = shapely.get_parts(shapely.constrained_delaunay_triangles(face, only_edges=False))
        except Exception:
            parts = shapely.get_parts(shapely.delaunay_triangles(face, only_edges=False))
        if not len(parts):
            continue
        cx, cy, cz = cent[f]
        ux, uy, uz = unit[f]
        g = grounds[f]
        got = out.setdefault(gid, {"v": {}, "xz": [], "y": [], "tri": []})
        for tri in parts:
            if shapely.get_type_id(tri) != 3:
                continue
            c = shapely.get_coordinates(tri, include_z=False)
            if len(c) < 3 or shapely.area(tri) < 0.05:
                continue
            ids = []
            for x, y in c[:3]:
                z = cz - (ux * (x - cx) + uy * (y - cy)) / uz
                if not (g - 5.0 <= z <= g + 400.0):
                    break
                key = (round(x * 10), round(y * 10), round(z * 10))
                if key not in got["v"]:
                    got["v"][key] = len(got["xz"])
                    got["xz"].append((x, y))
                    got["y"].append(z - g)
                ids.append(got["v"][key])
            if len(set(ids)) == 3:
                got["tri"].append(ids)
    return {gid: {"xz": np.asarray(v["xz"], np.float64), "y": np.asarray(v["y"], np.float64),
                  "tri": np.asarray(v["tri"], np.int64)} for gid, v in out.items() if v["tri"]}


def _chunk(args):
    """Worker: one chunk of gids → [(gid, base height a.s.l., [(height a.s.l., wkb)], roof)]."""
    gids, faces_wkb, unit, zmin, zmax, cent, fgid, foot_wkb, grounds, near = args
    face2d = shapely.from_wkb(faces_wkb)
    foot = dict(zip(gids, shapely.from_wkb(foot_wkb)))
    a = shapely.area(np.array(list(foot.values()), dtype=object))
    order = np.argsort(fgid, kind="stable")
    face2d, unit, zmin, zmax, cent, fgid = face2d[order], unit[order], zmin[order], zmax[order], cent[order], fgid[order]
    grounds = grounds[order]
    near = near[order]
    g = pd.DataFrame({"gid": fgid, "zmin": zmin, "zmax": zmax})
    r = g.groupby("gid").agg(r0=("zmin", "min"), r1=("zmax", "max"))
    area = pd.Series(a, index=list(foot.keys()))
    step_g = pd.Series(L.steps_for(r.r0.to_numpy(), r.r1.to_numpy(), area.reindex(r.index).to_numpy()), index=r.index)
    r0 = r.r0.reindex(fgid).to_numpy()
    step = step_g.reindex(fgid).to_numpy()
    df, geoms = L.bands(fgid, face2d, unit, zmin, zmax, cent, r0, step)
    df["w"] = df.slice * df.h
    bt = df.groupby(["gid", "k"]).agg(slice=("slice", "sum"), w=("w", "sum"), hm=("h", "mean")).reset_index()
    bt["h"] = np.where(bt.slice > 0, bt.w / bt.slice.where(bt.slice > 0, 1.0), bt.hm)
    keep_roof = near
    roofs = _roof_triangles(fgid[keep_roof], face2d[keep_roof], unit[keep_roof], zmin[keep_roof], zmax[keep_roof],
                            cent[keep_roof], grounds[keep_roof])
    out = []
    rows_by_gid = df.groupby("gid").indices
    for gid, t in bt.groupby("gid"):
        groups = L.groups_of(zip(t.k.to_numpy(), t.slice.to_numpy(), t.h.to_numpy()))
        base_h = groups[0][1]
        idx = rows_by_gid[gid]
        rk, rwhole = df.k.to_numpy()[idx], df.whole.to_numpy()[idx]
        parts = []
        for k, h, _ in groups[1:]:
            if h <= base_h + 0.3:
                continue
            sel = idx[(rk == k) | (rwhole & (rk > k))]
            if not len(sel):
                continue
            reg = L.region(k, sel, geoms, foot[gid])
            if reg is not None:
                parts.append((h, shapely.to_wkb(reg)))
        out.append((int(gid), float(base_h), parts, roofs.get(int(gid))))
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="s02_lod2", description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="ignored (the version the later steps write)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args([] if argv is None else argv)
    t0 = time.perf_counter()
    src = dict(city.SOURCE)
    if "lod2" not in src:
        print("s02_lod2: city.SOURCE has no 'lod2' folder; nothing to do")
        return
    root = (SRC_DIR / src["lod2"]).resolve()
    b = gpd.read_parquet(DATA / "buildings.parquet")
    for name in ("ground", "towers"):
        keep = DATA / f"{name}_lod1.parquet"
        rec = DATA / f"{name}_lod1.json"
        bsha = sha(DATA / "buildings.parquet")
        if not keep.exists() or not rec.exists() or json.loads(rec.read_text())["buildings_sha256"] != bsha:
            if (DATA / "towers.json").exists() and json.loads((DATA / "towers.json").read_text()).get("source") \
                    == "zg3d lod2" and name == "towers":
                raise SystemExit("data/towers.parquet is already LoD2 and no LoD1 copy matches: run s01_zagreb again")
            shutil.copyfile(DATA / f"{name}.parquet", keep)
            rec.write_text(json.dumps({"buildings_sha256": bsha}) + "\n")
    ground = pd.read_parquet(DATA / "ground.parquet")
    old_towers = gpd.read_parquet(DATA / "towers_lod1.parquet")
    old_ground = pd.read_parquet(DATA / "ground_lod1.parquet")
    parts = parts_and_gids(b, t0)
    files = district_files(root)
    log(t0, f"{len(parts):,} parts, {len(b):,} buildings; reading {len(files)} district files from {root}")

    with ProcessPoolExecutor(min(args.workers, len(files))) as ex:
        res = list(ex.map(L.district_roofs, files))
    n_feat = sum(r["n_features"] for r in res)
    n_faces = sum(r["n_faces"] for r in res)
    off = np.cumsum([0] + [r["n_features"] for r in res])
    face2d = np.concatenate([shapely.from_wkb(r["wkb"]) for r in res])
    unit = np.concatenate([r["unit"] for r in res])
    zmin = np.concatenate([r["zmin"] for r in res])
    zmax = np.concatenate([r["zmax"] for r in res])
    cent = np.concatenate([r["cent"] for r in res])
    area = np.concatenate([r["area"] for r in res])
    ffeat = np.concatenate([r["fidx"] + o for r, o in zip(res, off[:-1])])
    log(t0, f"{n_feat:,} LoD2 features, {n_faces:,} faces, {len(face2d):,} roof faces")
    ok = ~shapely.is_empty(face2d) & (zmin >= 95.0)
    face2d, unit, zmin, zmax, cent, area, ffeat = (a[ok] for a in (face2d, unit, zmin, zmax, cent, area, ffeat))

    # faces → part (the smallest part holding the face's representative point) → its gid
    from .zagreb_city import within
    rep = shapely.point_on_surface(face2d)
    fpart = within(rep, parts.geometry.values)
    fgid = np.where(fpart >= 0, parts.gid.to_numpy()[np.maximum(fpart, 0)], -1)
    # matches: per feature, the part with most of its roof area; per part, the share of its area the faces cover
    fa = pd.DataFrame({"feat": ffeat, "part": fpart, "a": area})
    in_part = fa[fa.part >= 0].groupby(["feat", "part"]).a.sum().reset_index()
    tot = fa.groupby("feat").a.sum()
    best = in_part.sort_values("a", ascending=False).drop_duplicates("feat")
    share = best.set_index("feat").a / tot.reindex(best.feat).to_numpy()
    feat_matched = int((share >= 0.5).sum())
    cover = fa[fa.part >= 0].groupby("part").a.sum().reindex(np.arange(len(parts))).fillna(0.0).to_numpy() \
        / np.maximum(shapely.area(parts.geometry.values), 1e-9)
    fallback = np.flatnonzero(cover < MIN_COVER)
    part_ratio = shapely.area(parts.geometry.values[best.part.to_numpy()]) / tot.reindex(best.feat).to_numpy()
    log(t0, f"features with >= 50% of their roof in one ZG3D part: {feat_matched:,} of {n_feat:,} "
            f"({feat_matched / n_feat:.1%}); parts covered >= {MIN_COVER:.0%}: {len(parts) - len(fallback):,} of "
            f"{len(parts):,} ({1 - len(fallback) / len(parts):.1%}); {len(fallback):,} keep their LoD1 box")
    # unmatched parts: one flat face at Z_Max
    fb = parts.iloc[fallback]
    keepf = fgid >= 0
    face2d = np.r_[face2d[keepf], fb.geometry.values]
    unit = np.r_[unit[keepf], np.tile([0.0, 0.0, 1.0], (len(fb), 1))]
    zmin = np.r_[zmin[keepf], fb.z_max.to_numpy()]
    zmax = np.r_[zmax[keepf], fb.z_max.to_numpy()]
    c = shapely.centroid(fb.geometry.values)
    cent = np.r_[cent[keepf], np.c_[shapely.get_x(c), shapely.get_y(c), fb.z_max.to_numpy()]]
    fgid = np.r_[fgid[keepf], fb.gid.to_numpy()]

    # chunks of gids, about equal face counts
    gids = np.unique(fgid)
    nface = np.bincount(fgid, minlength=len(b))[gids]
    cut = np.searchsorted(np.cumsum(nface), np.linspace(0, nface.sum(), CHUNKS + 1)[1:-1])
    foot_wkb = shapely.to_wkb(b.geometry.values)
    face_wkb = shapely.to_wkb(face2d)
    grounds = (ground.ground.to_numpy(np.float64) + city.DATUM_M)
    cen = shapely.centroid(b.geometry.values)
    bx, bz = city.to_local(shapely.get_x(cen), shapely.get_y(cen))
    near = np.hypot(bx, bz) < ROOF_RADIUS_M
    order = np.argsort(fgid, kind="stable")
    bounds = np.searchsorted(fgid[order], gids)
    jobs = []
    for part_g in np.split(np.arange(len(gids)), cut):
        if not len(part_g):
            continue
        g0, g1 = part_g[0], part_g[-1]
        lo = bounds[g0]
        hi = bounds[g1 + 1] if g1 + 1 < len(gids) else len(order)
        sel = order[lo:hi]
        gg = gids[part_g]
        jobs.append((gg, face_wkb[sel], unit[sel], zmin[sel], zmax[sel], cent[sel], fgid[sel], foot_wkb[gg],
                     grounds[fgid[sel]], near[fgid[sel]]))
    log(t0, f"{len(face2d):,} faces on {len(gids):,} buildings → {len(jobs)} chunks on {args.workers} workers")
    with ProcessPoolExecutor(args.workers) as ex:
        out = [r for chunk in ex.map(_chunk, jobs) for r in chunk]
    log(t0, f"skylines for {len(out):,} buildings")

    # ground.parquet: the footprint at the lowest band; towers.parquet: the higher bands
    base = np.full(len(b), np.nan)
    rows = []
    roof_rows = []
    for gid, bh, ps, roof in out:
        base[gid] = bh
        for h, w in ps:
            rows.append((gid, h, w))
        if roof:
            roof_rows.append((gid, roof))
    g_drawn = ground.ground.to_numpy(np.float64)
    old_h = old_ground.height.to_numpy(np.float64)
    have = np.isfinite(base)
    new_h = np.where(have, base - city.DATUM_M - g_drawn, old_h)
    new_h = np.maximum(new_h, MIN_HEIGHT_M)
    ground = ground.copy()
    ground["height"] = new_h.astype(np.float32)
    ground.to_parquet(DATA / "ground.parquet", index=False)
    t = pd.DataFrame(rows, columns=["gid", "h", "wkb"]).sort_values(["gid", "h"], kind="stable")
    towers = gpd.GeoDataFrame({"gid": t.gid.to_numpy(np.int64), "part": np.arange(len(t)),
                               "top_z": (t.h.to_numpy() - city.DATUM_M).astype(np.float64)},
                              geometry=shapely.from_wkb(t.wkb.to_numpy()), crs=city.CRS)
    no_faces = np.flatnonzero(~have)
    if len(no_faces):        # buildings without any face or part (none expected): keep their LoD1 parts
        towers = pd.concat([towers, old_towers[old_towers.gid.isin(no_faces)]], ignore_index=True)
        towers["part"] = np.arange(len(towers))
    towers.to_parquet(DATA / "towers.parquet", index=False)
    # issue #32: the real roof surfaces, one block per building, for s03_tiles' HFH2 packer
    if roof_rows:
        gids_r = np.array([g for g, _ in roof_rows], np.int64)
        order = np.argsort(gids_r, kind="stable")
        roof_rows = [roof_rows[i] for i in order]
        starts, tstarts = [0], [0]
        xz, y, tri = [], [], []
        for _, r in roof_rows:
            xz.append(np.asarray(r["xz"], np.float32))
            y.append(np.asarray(r["y"], np.float32))
            tri.append(np.asarray(r["tri"], np.int32) + starts[-1])
            starts.append(starts[-1] + len(r["xz"]))
            tstarts.append(tstarts[-1] + len(r["tri"]))
        np.savez_compressed(DATA / "roofs.npz", gid=np.array([g for g, _ in roof_rows], np.int64),
                            start=np.array(starts, np.int64), tstart=np.array(tstarts, np.int64),
                            xz=np.concatenate(xz), y=np.concatenate(y), tri=np.concatenate(tri))
        (DATA / "roofs.json").write_text(json.dumps({"buildings": len(roof_rows), "vertices": int(sum(len(r["xz"]) for _, r in roof_rows)), "triangles": int(sum(len(r["tri"]) for _, r in roof_rows)), "source": "zg3d lod2"}, ensure_ascii=False) + "\n", encoding="utf-8")
    else:
        for p in (DATA / "roofs.npz", DATA / "roofs.json"):
            p.unlink(missing_ok=True)
    (DATA / "towers.json").write_text(json.dumps({"buildings_sha256": sha(DATA / "buildings.parquet"),
                                                  "source": "zg3d lod2"}) + "\n", encoding="utf-8")
    # buildings.parquet is the identity: it must not have changed
    report = {"features": int(n_feat), "faces": int(n_faces), "roof_faces": int(ok.sum()),
              "features_matched": feat_matched, "feature_match_rate": round(feat_matched / n_feat, 4),
              "part_area_over_roof_area_median": round(float(np.median(part_ratio)), 3),
              "parts": int(len(parts)), "parts_lod1_fallback": int(len(fallback)),
              "buildings": int(len(b)), "buildings_with_faces": int(have.sum()),
              "towers_lod1": int(len(old_towers)), "towers_lod2": int(len(towers)),
              "buildings_with_parts_lod1": int(old_towers.gid.nunique()),
              "buildings_with_parts_lod2": int(towers.gid.nunique()),
              "params": {k: getattr(L, k) for k in ("NZ_MIN", "STEP_M", "STEP_SMALL_M", "SMALL_AREA_M2", "MAX_BANDS",
                                                     "MERGE_M", "MIN_AREA_M2", "SIMPLIFY_M")},
              "check": check_table(b, old_ground, ground, old_towers, towers)}
    (DATA / "lod2_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    log(t0, "report: " + json.dumps({k: v for k, v in report.items() if k != "check"}))


def check_table(b, g0, g1, t0, t1, extra: dict | None = None) -> dict:
    """The validation buildings before (LoD1) and after (LoD2): (area m², height above ground m) per drawn part."""
    out = {}
    for name, gids in {**CHECK, **(extra or {})}.items():
        out[name] = {}
        for gid in gids:
            rows = {}
            for tag, g, t in (("lod1", g0, t0), ("lod2", g1, t1)):
                gr = float(g.ground.iat[gid])
                ps = [(round(float(b.area.iat[gid])), round(float(g.height.iat[gid]), 1))]
                for r in t[t.gid == gid].itertuples():
                    ps.append((round(float(r.geometry.area)), round(float(r.top_z) - gr, 1)))
                rows[tag] = ps
            out[name][str(gid)] = rows
    return out


if __name__ == "__main__":
    main()
