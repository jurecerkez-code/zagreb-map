"""Auditable address attribution and measured coverage for Zagreb.

Only a point covered by exactly one building outline is attached to that building. No nearest-building or distance
fallback exists here. Overlapping outlines leave the address unattributed and all candidates in the local evidence log.
RPJ house-number values are verbatim source values: slashes, ranges and suffixes are not expanded into invented
addresses. `withheld` is privacy/takedown state, not a geometry review outcome.

This module never downloads data. Pass a licensed local ArcGIS GeoJSON export to --rpj, or just measure the existing
addresses and actual search shards. The public search schema stays gid/street/number with no source URLs or internals.

    uv run python -m pipeline.address_sources --buildings data/buildings.parquet \
      --addresses data/addresses.parquet --search web/data/<version>/search/addr
    uv run python -m pipeline.address_sources --buildings data/buildings.parquet \
      --addresses data/addresses.parquet --rpj data/raw/addresses/rpj.geojson \
      --out data/addresses.parquet --audit data/address_evidence.parquet --report data/address_report.json
"""
import argparse
import json
import math
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

COLUMNS = ["gid", "street", "number", "withheld"]
NO_NUMBER = {"bb", "b.b.", "b.b", "bez broja", "bez kucnog broja", "bez kućnog broja", "-", "--"}


def _text(value) -> str:
    return " ".join(str(value).split()) if isinstance(value, str) else ""


def _valid_number(value) -> bool:
    return bool(_text(value)) and _text(value).casefold() not in NO_NUMBER


def _object_id(value) -> str:
    if value is None or pd.isna(value):
        return ""
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    if isinstance(value, (float, np.floating)) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def rpj_addresses(frame: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Normalize Grad Zagreb RPJKucniBroj fields (ArcGIS: KB, UL_IME, OBJECTID, UL_JID) without inferring addresses."""
    required = {"KB", "UL_IME", "OBJECTID", "UL_JID", "geometry"}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"RPJ address input lacks {', '.join(sorted(missing))}")
    street = frame.UL_IME.map(_text)
    number = frame.KB.map(_text)
    point = frame.geometry.geom_type.eq("Point") & frame.geometry.notna() & ~frame.geometry.is_empty
    valid = street.ne("") & number.map(_valid_number) & point.to_numpy()
    out = gpd.GeoDataFrame({
        "street": street[valid], "number": number[valid],
        "source": "grad_zagreb_rpj",
        "source_ref": [f"RPJKucniBroj:{_object_id(v)}" for v in frame.OBJECTID[valid]],
        "street_id": frame.UL_JID[valid].map(_text),
    }, geometry=frame.geometry[valid], crs=frame.crs)
    return out.reset_index(drop=True)


def read_rpj(path: str | Path) -> gpd.GeoDataFrame:
    """Read a local ArcGIS GeoJSON export; no network access and no licence inference from its public availability."""
    return rpj_addresses(gpd.read_file(path))


def _frame_columns(frame: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    # An absent legacy withheld column means no takedown, just like s03_tiles.shown_addresses: not True from "".
    return pd.DataFrame({c: frame[c] if c in frame else pd.Series(
        False if c == "withheld" else "", index=frame.index) for c in columns})


def _records(points: gpd.GeoDataFrame, source: str) -> pd.DataFrame:
    records = _frame_columns(points.reset_index(drop=True), ["street", "number", "source", "source_ref", "street_id"])
    records.street = records.street.map(_text)
    records.number = records.number.map(_text)
    records.source = records.source.map(_text).replace("", source or "unknown")
    records.source_ref = records.source_ref.map(_text)
    if "osm_id" in points:
        actual = points.reset_index(drop=True).osm_id.map(_text)
        records.loc[records.source_ref == "", "source_ref"] = actual[records.source_ref == ""]
    records.street_id = records.street_id.map(_text)
    return records


def match_unique(points: gpd.GeoDataFrame, buildings: gpd.GeoDataFrame, source: str = "") -> tuple[pd.DataFrame, pd.DataFrame]:
    """(standard address rows, one evidence row per input source point).

    A covered point with exactly one candidate is `unique_covered_by`; zero candidates is `outside`; two or more are
    `ambiguous_covered_by` and yield no address. Distance is 0 only for actual coverage. Outside points deliberately
    get no nearest-building distance: gathering one would invite the unverified fallback this matcher forbids.
    `street_id` and `source_ref` stay in the local evidence file only, never the public address/search schema.
    """
    if "gid" not in buildings or buildings.gid.duplicated().any():
        raise ValueError("building gids must exist and be unique before address attribution")
    if buildings.geometry.isna().any() or buildings.geometry.is_empty.any():
        raise ValueError("address attribution requires non-empty building geometry")
    if points.crs is None or buildings.crs is None:
        raise ValueError("address points and buildings must both have an explicit CRS")
    points = points.to_crs(buildings.crs) if points.crs != buildings.crs else points
    records = _records(points, source)
    records["match_kind"] = "invalid_source_record"
    records["gid"] = pd.Series([pd.NA] * len(records), dtype="Int64")
    records["candidate_gids"] = pd.Series([[] for _ in range(len(records))], dtype=object)
    records["match_distance_m"] = pd.Series([math.nan] * len(records), dtype=float)
    valid = records.street.ne("").astype(bool) & records.number.map(_valid_number).astype(bool)
    if len(points):
        valid &= (points.geometry.geom_type.eq("Point").to_numpy()
                  & points.geometry.notna().to_numpy() & ~points.geometry.is_empty.to_numpy())

    vi = np.flatnonzero(valid.to_numpy())
    if len(vi) and len(buildings):
        candidate, geometry_i = shapely.STRtree(buildings.geometry.values).query(
            points.geometry.values[vi], predicate="covered_by")
        gids = buildings.gid.to_numpy(np.int64)
        order = np.lexsort((gids[geometry_i], candidate)) if len(candidate) else []
        candidate, geometry_i = candidate[order], geometry_i[order]
        candidates: dict[int, list[int]] = {}
        for p, f in zip(candidate, geometry_i, strict=True):
            gid = int(gids[f])
            if gid not in candidates.setdefault(int(p), []):
                candidates[int(p)].append(gid)
        for p in range(len(vi)):
            row = int(vi[p])
            found = candidates.get(p, [])
            records.at[row, "candidate_gids"] = found
            if found:
                records.at[row, "match_distance_m"] = 0.0
            if len(found) == 1:
                records.at[row, "match_kind"] = "unique_covered_by"
                records.at[row, "gid"] = found[0]
            elif len(found) > 1:
                records.at[row, "match_kind"] = "ambiguous_covered_by"
            else:
                records.at[row, "match_kind"] = "outside"
    elif len(vi):
        records.loc[records.index[vi], "match_kind"] = "outside"

    matched = records.loc[records.match_kind == "unique_covered_by", ["gid", "street", "number"]].copy()
    matched = matched.drop_duplicates()
    matched["withheld"] = False
    matched = matched[COLUMNS].astype({"gid": "int32"}).reset_index(drop=True)
    return matched, records.reset_index(drop=True)


def merge_addresses(existing: pd.DataFrame, additions: pd.DataFrame, known_gids=None) -> pd.DataFrame:
    """Conservative union. Existing entries win, their takedowns cover new sources, and unknown gids cannot enter.

    With no `known_gids`, only gids already in `existing` are accepted. Callers adding buildings must pass the actual
    footprint gid set: no new building is inferred merely from the presence of an address record.
    """
    old = _frame_columns(existing, COLUMNS).copy()
    new = _frame_columns(additions, COLUMNS).copy()
    if len(old):
        old["withheld"] = old.withheld.fillna(False).astype(bool)
    if len(new):
        new["withheld"] = new.withheld.fillna(False).astype(bool)
    out = pd.concat([old, new], ignore_index=True)
    if not len(out):
        return out.astype({"gid": "int32"})[COLUMNS]
    out["gid"] = pd.to_numeric(out.gid, errors="coerce")
    known = set(old.gid.dropna().astype(int)) if known_gids is None else {int(g) for g in known_gids}
    out = out[out.gid.isin(known)].copy()
    out.street = out.street.map(_text)
    out.number = out.number.map(_text)
    out = out[out.street.ne("") & out.number.map(_valid_number)]
    blocked = set(out.loc[out.withheld.astype(bool), "gid"].astype(int))
    out.loc[out.gid.astype(int).isin(blocked), "withheld"] = True
    out = out.drop_duplicates(["gid", "street", "number"], keep="first")
    out["gid"] = out.gid.astype("int32")
    return out[COLUMNS].reset_index(drop=True)


def _valid_addresses(addresses: pd.DataFrame) -> pd.DataFrame:
    a = addresses.copy()
    if not len(a):
        return pd.DataFrame(columns=COLUMNS)
    a = _frame_columns(a, COLUMNS)
    return a[a.street.map(_text).ne("") & a.number.map(_valid_number)]


def _coverage(n: int, addressed: int, target: float) -> dict:
    share = addressed / n if n else 0.0
    return {"buildings": int(n), "addressed": int(addressed), "coverage": share, "target_met": share >= target if n else False}


def coverage(addresses: pd.DataFrame, buildings: pd.DataFrame, min_area: float = 30.0, target: float = 0.95) -> dict:
    """Coverage from distinct known gids in valid, non-withheld rows, not files, addresses-on-parts or source fields."""
    a = _valid_addresses(addresses)
    present = a.drop_duplicates(["gid", "street", "number"])
    withheld_rows = int(a.withheld.fillna(False).astype(bool).sum())
    shown = a[~a.withheld.fillna(False).astype(bool)].drop_duplicates(["gid", "street", "number"])
    known = set(buildings.gid.astype(int))
    addressed = {int(g) for g in shown.gid} & known
    large = set(buildings.loc[buildings["area"] > min_area, "gid"].astype(int))
    unknown = {int(g) for g in shown.gid} - known
    return {"definition": "distinct known gids with a non-empty, non-sentinel, non-withheld address",
            "target": float(target), "min_area_m2_exclusive": float(min_area),
            "all": _coverage(len(buildings), len(addressed), target),
            "over_30_m2": _coverage(len(large), len(addressed & large), target),
            "address_rows_present": int(len(present)), "address_rows_shown": int(len(shown)),
            "withheld_rows": withheld_rows, "unknown_gids_excluded": int(len(unknown))}


def search_coverage(folder: str | Path, buildings: pd.DataFrame, target: float = 0.95) -> dict:
    """Compute distinct gids from real [number,gid,district] pairs in all shipped address shards."""
    known = set(buildings.gid.astype(int))
    seen, found, invalid, unknown = set(), set(), 0, set()
    paths = sorted(Path(folder).glob("*.json"))
    for path in paths:
        body = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(body, dict):
            raise ValueError(f"address shard {path} is not an object")
        for street, pairs in body.items():
            if not _text(street) or not isinstance(pairs, list):
                invalid += 1
                continue
            for pair in pairs:
                if (not isinstance(pair, list) or len(pair) < 2 or not _text(pair[0])
                        or isinstance(pair[1], bool) or not isinstance(pair[1], int)):
                    invalid += 1
                    continue
                seen.add((street, pair[0], pair[1]))
                if pair[1] not in known:
                    unknown.add(pair[1])
                else:
                    found.add(pair[1])
    return {"shards": len(paths), "address_pairs": len(seen), "invalid_pairs": invalid,
            "unknown_gids": len(unknown), **_coverage(len(known), len(found), target)}


def summary(evidence: pd.DataFrame) -> dict:
    """Aggregate only: evidence records can hold addresses, but logs/reports need not repeat those locations."""
    if evidence.empty:
        return {"source_points": 0, "unique_covered_by": 0, "ambiguous_covered_by": 0, "outside": 0,
                "invalid_source_record": 0, "distinct_buildings_matched": 0}
    counts = evidence.match_kind.value_counts()
    return {"source_points": int(len(evidence)),
            **{k: int(counts.get(k, 0)) for k in ("unique_covered_by", "ambiguous_covered_by", "outside",
                                                 "invalid_source_record")},
            "distinct_buildings_matched": int(evidence.gid.dropna().nunique())}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--buildings", type=Path, required=True)
    ap.add_argument("--addresses", type=Path, required=True)
    ap.add_argument("--search", type=Path, help="the version's search/addr directory, read all real shards")
    ap.add_argument("--rpj", type=Path, help="a licensed local RPJKucniBroj GeoJSON; never fetched by this command")
    ap.add_argument("--out", type=Path, help="write the merged local addresses.parquet")
    ap.add_argument("--audit", type=Path, help="write local per-point match evidence; do not publish to web/data")
    ap.add_argument("--report", type=Path, help="write the aggregate JSON measurement")
    args = ap.parse_args(argv)
    b = gpd.read_parquet(args.buildings)
    old = pd.read_parquet(args.addresses)
    report = {"before": coverage(old, b)}
    if args.search:
        report["search_before"] = search_coverage(args.search, b)
    if args.rpj:
        matched, evidence = match_unique(read_rpj(args.rpj), b)
        new = merge_addresses(old, matched, b.gid)
        report["match"] = summary(evidence)
        report["after"] = coverage(new, b)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            new.to_parquet(args.out, index=False)
        if args.audit:
            args.audit.parent.mkdir(parents=True, exist_ok=True)
            evidence.to_parquet(args.audit, index=False)
    text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    main()
