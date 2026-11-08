"""Zagreb port, whole city: the main of s01_zagreb for city.SOURCE kind "city" (see pipeline/zagreb_city.py)."""
import hashlib
import json
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from . import address_sources as ads
from . import city, codes, terrain
from . import zagreb_city as zc
from . import zagreb_heritage as zh
from . import zagreb_sat as zs
from .s02_attributes import floors_from_height
from .s04_base import land_and_water

DATA = Path("data")
HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parent


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def log(t0, msg):
    print(f"[{time.perf_counter() - t0:6.1f} s] {msg}", flush=True)


def uuids(oid, osm_id, gid) -> np.ndarray:
    """One uuid per building: the ZG3D feature id, except where several buildings came from one feature (its parts
    fell in different OSM footprints). Those took the same uuid, which made contributions.py refuse a hand-entered
    year for the whole group; they take their own OSM id instead, or the gid where OSM has none."""
    out = np.array([str(o) for o in oid], dtype=object)
    shared = pd.Series(out).duplicated(keep=False).to_numpy()
    osm_id = np.asarray(osm_id, dtype=object)
    if shared.any():
        out[shared] = [s if isinstance(s, str) and s else f"{u}:{g}"
                       for s, u, g in zip(osm_id[shared], out[shared], gid[shared])]
    return out


def main_city(src: dict, helpers) -> None:
    t0 = time.perf_counter()
    rel = lambda k: (SRC_DIR / src[k]) if not Path(src[k]).is_absolute() else Path(src[k])  # noqa: E731
    osm = rel("osm")
    DATA.mkdir(exist_ok=True)
    dom, cet = zc.boundary(osm)
    log(t0, f"Grad Zagreb {dom.area / 1e6:.1f} km², {len(cet)} gradske četvrti")
    parts = zc.load_parts(rel("parts"), dom, helpers.clean)
    log(t0, f"{len(parts):,} ZG3D parts inside the city")
    osm_b = gpd.read_parquet(osm / "zg_osm_buildings.parquet")
    osm_b = osm_b[~osm_b.geometry.is_empty & osm_b.geometry.notna()].reset_index(drop=True)
    osm_b["geometry"] = shapely.make_valid(osm_b.geometry.values)
    parts = zc.split_oversized(parts, osm_b)
    b, gid_of_part, towers = zc.merge(parts, osm_b)
    n = len(b)
    if n < city.MIN_BUILDINGS:
        raise SystemExit(f"{n} buildings, fewer than city.MIN_BUILDINGS {city.MIN_BUILDINGS}")
    log(t0, f"merged {len(parts):,} parts into {n:,} buildings ({int((b.nparts > 1).sum()):,} of several parts; "
            f"{int((b.osm >= 0).sum()):,} on an OSM footprint); {len(towers):,} further parts drawn")

    # kategori: the OSM building type; small unnamed residential/'yes' buildings count as houses (privacy)
    ob = osm_b.building.to_numpy(dtype=object)
    kat = np.array([ob[o] if o >= 0 else "" for o in b.osm], dtype=object)
    zbsm = gpd.read_file(rel("zbsm")).to_crs(city.CRS)
    zbsm["geometry"] = shapely.make_valid(zbsm.geometry.values)
    wd = pd.read_parquet(rel("wikidata"))
    her, her_info, her_log, her_names = zh.candidates(b, rel("heritage"))
    her_reads = zh.write_log(her_log, DATA / "year_parse_log.csv")
    log(t0, f"heritage layers: {her_info}")
    y = zc.assign_years(b, parts, gid_of_part, osm_b, zbsm, wd, her=her)
    log(t0, f"years: {y['info']}")
    height_max = np.maximum(b.top_max.to_numpy() - b.zmin.to_numpy(), helpers.MIN_HEIGHT_M)
    area = shapely.area(b.geometry.values)
    oname = osm_b["name"].to_numpy(dtype=object)
    named_osm = np.array([o >= 0 and isinstance(oname[o], str) and bool(oname[o]) for o in b.osm])
    zb_of = y["zbsm_of_gid"]
    zb_name = np.array([helpers.card_name(zbsm.naziv.iat[zb_of[g]]) if g in zb_of else "" for g in range(n)],
                       dtype=object)
    infer = (np.isin(kat, list(zc.HOUSE_INFER["types"])) | (kat == "")) & (area <= zc.HOUSE_INFER["max_area"]) \
        & (height_max <= zc.HOUSE_INFER["max_height"]) & ~named_osm & (zb_name == "")
    zb_use = np.array([str(zbsm.gradjevina_namjena.iat[zb_of[g]] or "") if g in zb_of else "" for g in range(n)],
                      dtype=object)
    infer &= ~pd.Series(zb_use, dtype=str).str.startswith(("javne", "poslovne", "gospodarske")).to_numpy()
    house = np.isin(kat, list(zc.HOUSE_TYPES)) | infer
    kategori = np.where(house, "house", np.where(kat == "", "unmapped", kat)).astype(object)

    # districts
    rep = shapely.point_on_surface(b.geometry.values)
    di = zc.within(rep, cet.geometry.values)
    if (di < 0).any():
        miss = np.flatnonzero(di < 0)
        _, near = shapely.STRtree(cet.geometry.values).query_nearest(rep[miss])
        di[miss[_]] = near
    district = cet.key.to_numpy(dtype=object)[np.maximum(di, 0)]

    # estimate tier (cross-validated), then the privacy rule
    # Trained and tested on the record years only (EXACT/RANGE/LONG); area and typology years (AREA) never enter it.
    accuracy = zc.run_estimate(b, kategori, height_max, district, y)
    period, private = zc.privacy(y, kategori == "house")
    log(t0, f"estimate: {accuracy['result']}; cells estimating: "
            f"{[(c['group'], c['era'], c['inner'], c.get('right_period'), c.get('band')) for c in accuracy['cells'] if c['status'] == 'estimate']}")

    # names, architects, protection, wiki
    items = {qid: r for qid, r, _ in y["items"]}
    wd_of = {g: v[5] for g, v in y["cand"]["wikidata"].items()}
    names, archs, prot = [], [], np.zeros(n, np.uint8)
    for g in range(n):
        nm = zb_name[g]
        ar = helpers.parse_architects(zbsm.autor.iat[zb_of[g]]) if g in zb_of else []
        if g in zb_of and isinstance(zbsm.status.iat[zb_of[g]], str) and zbsm.status.iat[zb_of[g]]:
            prot[g] = codes.PROT_LISTED
        if g in her["kd"] or g in her["zg_her"]:        # a registered cultural good (KD_pojedinacna / GRADEVINA)
            prot[g] = codes.PROT_LISTED
        if g in wd_of:
            r = items[wd_of[g]]
            nm = nm or (r.label_hr or r.label_en or "")
            ar = ar or [a for a in (r.architects or "").split("|") if a]
        if not nm and (g in her["kd"] or g in her["zg_her"]) and g in her_names:
            nm = helpers.card_name(her_names[g])
        if not nm and b.osm.iat[g] >= 0 and isinstance(oname[b.osm.iat[g]], str):
            nm = helpers.card_name(oname[b.osm.iat[g]])
        names.append("" if kategori[g] == "house" else nm)    # a private house shows no name (no reviewed list)
        archs.append([] if kategori[g] == "house" else ar)

    gid = np.arange(n, dtype=np.int32)
    zmin = b.zmin.to_numpy() - city.DATUM_M
    height = np.maximum(b.top_min.to_numpy() - b.zmin.to_numpy(), helpers.MIN_HEIGHT_M)
    osm_ids = [osm_b.osm_id.iat[o] if o >= 0 else "" for o in b.osm]
    bb = gpd.GeoDataFrame({
        "gid": gid, "uuid": uuids(b.oid.to_numpy(), osm_ids, gid), "oid": b.oid.to_numpy(),
        "grupp": np.full(n, "ZG3D"), "kategori": kategori.astype(str), "fastighet": np.full(n, ""),
        "height": height.astype("float32"), "ground": zmin.astype("float32"), "area": area.astype("float32"),
        "prod_year": np.zeros(n, "int16"), "fnr": np.zeros(n, "int64"), "height_max": height_max.astype("float32"),
        "top_max": (b.top_max.to_numpy() - city.DATUM_M).astype("float32"),
        "nparts": b.nparts.to_numpy().astype("int16"),
        "osm_id": osm_ids,
    }, geometry=b.geometry.values, crs=city.CRS)
    bb.to_parquet(DATA / "buildings.parquet", index=False)
    # the satellite lower bound (card text only; s03_tiles shows it where the building has no other year)
    sat = zs.sample(shapely.point_on_surface(b.geometry.values), rel("ghsl"), rel("wsf"))
    pd.DataFrame({"gid": np.arange(n, dtype=np.int32), "sat": sat.sat.to_numpy(np.int16)}).to_parquet(
        DATA / "sat.parquet", index=False)
    log(t0, f"satellite lower bound: {int((sat.sat == 1990).sum()):,} after 1990, {int((sat.sat == 2000).sum()):,} "
            "after 2000")

    years = pd.DataFrame({
        "gid": gid, "year": y["year"].astype(np.int16), "year_from": y["y_from"].astype(np.int16),
        "year_to": y["y_to"].astype(np.int16), "ysrc": y["ysrc"].astype(np.uint8),
        "yflag": y["yflag"].astype(np.uint8), "period": period.astype(np.uint8), "private": private.astype(bool),
        "raa_id": pd.array([str(int(zbsm.id.iat[zb_of[g]])) if g in zb_of and y["ysrc"][g] == codes.SRC_ZBSM
                            and pd.notna(zbsm.id.iat[zb_of[g]]) and not private[g] else "" for g in range(n)],
                           dtype="str"),
        "landmark": pd.array([""] * n, dtype="str"),
    })
    years.to_parquet(DATA / "years.parquet", index=False)

    floors_h = floors_from_height(height_max, kategori).astype(np.uint8)
    lev = pd.to_numeric(pd.Series([osm_b.levels.iat[o] if o >= 0 else None for o in b.osm]), errors="coerce")
    floors_osm = np.clip(lev.fillna(0).round().to_numpy(), 0, 60).astype(np.uint8)
    use_osm = (floors_osm > 0) & (np.abs(floors_osm.astype(int) - floors_h.astype(int)) <= 2)
    attrs = pd.DataFrame({
        "gid": gid, "floors": np.where(use_osm, floors_osm, floors_h).astype(np.uint8),
        "fsrc": np.where(use_osm, codes.FLOORS_OSM, codes.FLOORS_HEIGHT).astype(np.uint8),
        "rating": np.zeros(n, np.uint8), "architects": archs, "name": pd.array(names, dtype="str"),
        "floors_h": floors_h, "floors_osm": floors_osm, "prot": prot, "since": np.zeros(n, np.int16),
        "nofloors": np.isin(kat, list(city.NO_FLOORS_KATEGORI)),   # a church or chimney has no storeys to count
    })
    attrs.to_parquet(DATA / "attributes.parquet", index=False)

    # addresses: ZBSM, the OSM building's own tags, and only uniquely located OSM/RPJ source points. A point covered by
    # several footprints is ambiguous and stays out (never nearest or smallest-polygon assignment); the local evidence
    # records every candidate. Configured RPJ input is local and licensed: this step does not download address data.
    rows = []
    for g, z in zb_of.items():
        rows += [(g, s, num) for s, num in helpers.parse_addresses(zbsm.adresa.iat[z])]
    for g, o in zip(b.gid, b.osm):
        if o >= 0 and isinstance(osm_b.addr_street.iat[o], str) and isinstance(osm_b.addr_number.iat[o], str):
            rows += [(int(g), osm_b.addr_street.iat[o], num.strip()) for num in osm_b.addr_number.iat[o].split(";")]
    ap = gpd.read_parquet(osm / "zg_osm_addr_points.parquet")
    matched, evidence = ads.match_unique(ap, b, source="osm_zagreb")
    rows += list(matched[["gid", "street", "number"]].itertuples(index=False, name=None))
    if src.get("rpj_addresses"):
        rpj, rpj_evidence = ads.match_unique(ads.read_rpj(rel("rpj_addresses")), b)
        rows += list(rpj[["gid", "street", "number"]].itertuples(index=False, name=None))
        evidence = pd.concat([evidence, rpj_evidence], ignore_index=True)
    evidence.to_parquet(DATA / "address_evidence.parquet", index=False)
    addr = pd.DataFrame(rows, columns=["gid", "street", "number"]).drop_duplicates()
    addr = addr[addr.number.str.match(r"^\d")].astype({"gid": "int32"})
    addr["withheld"] = False
    addr.to_parquet(DATA / "addresses.parquet", index=False)
    address_coverage = ads.coverage(addr, bb)
    zc.write_json(DATA / "address_report.json", {
        "coverage": address_coverage, "matched_source_points": ads.summary(evidence),
        "unaddressed_buildings": {"all": len(bb) - address_coverage["all"]["addressed"],
                                  "over_30_m2": address_coverage["over_30_m2"]["buildings"]
                                                - address_coverage["over_30_m2"]["addressed"]},
        "why": "No valid non-withheld address row. New source points stay unmatched when outside all footprints or "
               "covered by multiple footprints; no nearest-building, street-facing, range or interpolation inference. "
               "Direct ZBSM/OSM-building-tag rows predate per-row source/match fields and are not relabelled."})
    pd.DataFrame({"gid": gid, "district": district}).to_parquet(DATA / "districts.parquet", index=False)
    log(t0, f"{len(addr):,} addresses on {addr.gid.nunique():,} buildings; "
            f"source points: {ads.summary(evidence)}; coverage {address_coverage['all']['coverage']:.2%}")

    # domain = the city boundary; water from OSM, cut into 1 km pieces with a level each
    dom_poly = max(getattr(dom, "geoms", [dom]), key=lambda g: g.area)
    gpd.GeoDataFrame({"name": ["Grad Zagreb"]}, geometry=[dom_poly], crs=city.CRS).to_file(
        DATA / "domain.geojson", driver="GeoJSON")
    wat = gpd.read_parquet(osm / "zg_osm_water.parquet")
    land, water = land_and_water(shapely.force_2d(wat.geometry.values), dom_poly)
    water = zc.split_water(water)
    gpd.GeoDataFrame(geometry=water, crs=city.CRS).to_file(DATA / "water_zagreb.geojson", driver="GeoJSON")
    gpd.GeoDataFrame(geometry=land, crs=city.CRS).to_file(DATA / "land_zagreb.geojson", driver="GeoJSON")

    cfg = city.TERRAIN
    minx, miny, maxx, maxy = dom_poly.bounds
    x0, z0 = city.to_local(minx, maxy)
    x1, z1 = city.to_local(maxx, miny)
    grid = terrain.grid_for((float(x0), float(z0), float(x1), float(z1)), cfg["cell"])
    prep = shapely.point_on_surface(parts.geometry.values)
    px, pz = city.to_local(shapely.get_x(prep), shapely.get_y(prep))
    dem = zc.dem_sampler(sorted(rel("dem").glob("*.tif")))
    h, shift, share = zc.build_terrain(grid, np.c_[px, pz], parts.z_min.to_numpy() - city.DATUM_M, dem, cfg)
    # water levels: the DSM's median over each piece (a water surface), never above the shore's terrain
    levels = []
    for p in water:
        pts = shapely.get_coordinates(p.representative_point())
        inner = np.asarray(shapely.get_coordinates(shapely.segmentize(p.exterior, 20.0)))
        ins = p.buffer(-5) if p.area > 2000 else p
        sample = np.r_[pts, shapely.get_coordinates(shapely.segmentize(ins.exterior, 20.0))
                       if ins.geom_type == "Polygon" and not ins.is_empty else pts]
        dz = dem(sample[:, 0], sample[:, 1]) - city.DATUM_M + shift
        lx, lz = city.to_local(inner[:, 0], inner[:, 1])
        shore = terrain.bilinear(grid, h, lx, lz)
        lv = float(np.nanmedian(dz)) if np.isfinite(dz).any() else float(np.nanmin(shore)) - 1.0
        lv = min(lv, float(np.nanpercentile(shore, 5)) - 0.3)
        levels.append(max(lv, cfg["water_z"]))
    levels = np.asarray(levels, np.float32)
    # terrain nodes in water sit just under its level
    if water:
        lev_grid = terrain.burn([terrain.to_local(p) for p in water], levels, (grid.nz, grid.nx),
                                grid.node_transform(), fill=np.nan, dtype="float32", all_touched=True)
        wet = np.isfinite(lev_grid)
        h = np.where(wet, np.minimum(h, lev_grid - 0.5), h).astype(np.float32)
        h = np.maximum(h, cfg["water_z"] + cfg["ground_min"]).astype(np.float32)
    polys = terrain.to_local(bb.geometry.values)
    tmin = terrain.outline_min(lambda pts: terrain.bilinear(grid, h, pts[:, 0], pts[:, 1]), polys)
    ground, hgt, fixed = terrain.fix_grounds(zmin, height, tmin, cfg["fix_m"]["zg3d"])
    drawn = np.maximum(ground, cfg["water_z"] + cfg["ground_min"])
    g = pd.DataFrame({"gid": gid, "ground": drawn.astype(np.float32), "height": hgt.astype(np.float32),
                      "floors": attrs.floors.to_numpy(), "ground_src": fixed.astype(np.uint8),
                      "tmin": tmin.astype(np.float32)})
    g.to_parquet(DATA / "ground.parquet", index=False)
    np.savez_compressed(DATA / "terrain.npz", h=h, cut=np.zeros_like(h), use=np.ones_like(h, dtype=bool),
                        levels=levels)
    ok = np.isfinite(tmin)
    record = {"source": "zg3d", **grid.to_dict(), "water_z": cfg["water_z"], "levels": int(len(levels)),
              "water_area": float(sum(p.area for p in water)),
              "datum": round(float(np.median(zmin[ok] - tmin[ok])), 3), "fixed": int(fixed.sum()),
              "lakes": int((levels > cfg["water_z"]).sum()), "fixture": False, "buried": 0,
              "relief_max": cfg["relief_max"], "floating": 0, "sea": None, "datum_m": city.DATUM_M,
              "dem_shift_m": round(shift, 2), "nodes_from_buildings": round(share, 3),
              "buildings_sha256": sha(DATA / "buildings.parquet"), "attributes_sha256": sha(DATA / "attributes.parquet")}
    (DATA / "terrain.json").write_text(json.dumps(record, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    log(t0, f"terrain {grid.nx} x {grid.nz} nodes ({share:.0%} from buildings, DSM shift {shift:+.1f} m), "
            f"{float(h.min()):.0f}-{float(h.max()):.0f} m above datum; water {len(water)} pieces "
            f"{sum(p.area for p in water) / 1e6:.2f} km², levels {levels.min():.1f}-{levels.max():.1f}")

    # further parts (s03_tiles draws them as parts of their building)
    towers.to_parquet(DATA / "towers.parquet", index=False)
    (DATA / "towers.json").write_text(json.dumps({"buildings_sha256": sha(DATA / "buildings.parquet"),
                                                  "source": "zg3d parts"}) + "\n", encoding="utf-8")

    (DATA / "accuracy.json").write_text(json.dumps(accuracy, indent=1, sort_keys=True, default=_jsonable) + "\n",
                                        encoding="utf-8")
    wrows = []
    for g_, q in wd_of.items():
        if private[g_] or kategori[g_] == "house":
            continue
        r = items[q]
        langs = ",".join(code for code, w in (("en", r.enwiki),) if isinstance(w, str))
        wrows.append((g_, q, r.label_hr or r.label_en or "", r.label_en or "", langs, ""))
    pd.DataFrame(wrows, columns=["gid", "qid", "name", "name_en", "langs", "photo"]).astype(
        {"gid": "int32"}).to_parquet(DATA / "wiki.parquet", index=False)
    for name, value in (("photos.json", {}), ("extracts.json", {}), ("landmarks.json", [])):
        (DATA / name).write_text(json.dumps(value) + "\n", encoding="utf-8")

    streets = gpd.read_parquet(osm / "zg_osm_streets.parquet")
    cands = zc.street_candidates(streets, dom_poly)
    wn = wat[wat["name"].notna()]
    cands += zc.water_candidates(gpd.GeoDataFrame({"name": wn["name"]}, geometry=wn.geometry.values, crs=city.CRS))
    cands += zc.river_candidates(gpd.read_parquet(osm / "zg_osm_waterways.parquet"), water, dom_poly)
    zc.write_json(DATA / "labels_zagreb.json", cands)

    if len(y["review"]):
        y["review"].to_csv(DATA / "year_disagreements.csv", index=False)
    yf = years.yflag.to_numpy()
    report = {
        "parts": int(len(parts)), "buildings": n, "multi_part_buildings": int((b.nparts > 1).sum()),
        "on_osm_footprint": int((b.osm >= 0).sum()), "further_parts": int(len(towers)),
        "sources": y["info"], "disagreements": int(len(y["review"])),
        "winner": {k: int((y["winner"] == k).sum()) for k in zc.PRIORITY},
        "yflag": {k: int((yf == v).sum()) for k, v in (("exact", codes.EXACT), ("range", codes.RANGE),
                                                       ("long", codes.LONG), ("area", codes.AREA),
                                                       ("estimate", codes.ESTIMATE), ("unknown", codes.UNKNOWN))},
        "heritage": her_info, "heritage_reads": {f"{a}: {b_}": int(c) for (a, b_), c in her_reads.items()},
        "satellite": {"after_1990": int((sat.sat == 1990).sum()), "after_2000": int((sat.sat == 2000).sum())},
        "private_houses": int((kategori == "house").sum()), "private_dated": int(private.sum()),
        "periods": np.bincount(period[yf != codes.UNKNOWN], minlength=len(city.PERIODS)).tolist(),
        "addresses": int(len(addr)), "address_coverage": address_coverage, "address_matches": ads.summary(evidence),
        "street_label_candidates": len(cands), "water_pieces": int(len(water)),
    }
    zc.write_json(DATA / "zagreb_report.json", report)
    log(t0, "report: " + json.dumps(report, ensure_ascii=False))


def _jsonable(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (set, np.ndarray)):
        return list(o)
    raise TypeError(type(o))
