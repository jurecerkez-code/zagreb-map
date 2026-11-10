"""Zagreb addresses: one street name per street, a footprint per house number, a street reference where neither.

Issue #30 asks for three things this module does and one it refuses to do:

1. **One canonical street name per street.** Address points spell a street in several ways ("Adamičeva" and
   "Adamičeva ulica"); the canonical spelling is the one on the OSM street way carrying that name, else the most
   common spelling among the addresses themselves. Only the generic descriptor `ulica` / `ul.` is optional when
   grouping, so `Ulica Ilica` and `Ilica` are one street while `Cesta` versus `Ulica` of the same stem stay two:
   nothing semantic is merged to make a count look better. Every other spelling stays a search alias.
2. **House numbers on footprints.** An address point covered by exactly one footprint is that footprint's address
   (`inside`). A point covered by several is left unattributed, with every candidate gid in the evidence file. A
   point on no footprint is matched to the nearest footprint within `MAX_NEAR_M` **only if that footprint also lies
   within `MAX_NEAR_M` of the address's own street** (`near`): the issue's "nearest footprint edge to the street
   centreline", so an address across a courtyard never lands on the building behind it. Everything else stays
   unmatched — there is no distance-only fallback, and no house number is ever invented.
3. **Interpolation ranges.** `addr:interpolation` ways are expanded from their numbered endpoint nodes (`interpolated`),
   never from arithmetic alone: a way whose ends carry no house number yields nothing.
4. **A street reference, not a number, for the rest.** A building with no address gets "uz <street>" from the nearest
   named street within `MAX_STREET_REF_M`, so it is findable by street and its card says what it is. The coverage
   report counts these separately from house numbers.

The public address schema stays `gid, street, number, withheld`; match method, OSM ids and distances live only in the
local evidence table (`data/address_evidence.parquet`), never in `web/data`.

    uv run python -m pipeline.zagreb_addresses \
      --buildings data/buildings.parquet --addresses data/raw/osm/addresses --streets data/raw/osm/streets \
      --out-addresses data/addresses.parquet --refs data/street_refs.parquet --report data/address_report.json
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer

from . import city
from .address_sources import NO_NUMBER, _text, coverage, merge_addresses
from .addresses import numbers as house_numbers
from .textfold import fold

CRS = city.CRS
MAX_NEAR_M = 25.0          # issue #30 step 3: the nearest footprint within 25 m that faces the street
MAX_STREET_REF_M = 60.0    # issue #30 step 4: the nearest street within 60 m
MIN_AREA_M2 = 30.0         # the issue's "over 30 m²" denominator, strictly greater
TARGET = 0.95

GENERIC_HEAD = re.compile(r"^(?:ulica|ul) (.+)$")
GENERIC_TAIL = re.compile(r"^(.+?) ulica$")


def street_key(text) -> str:
    """The grouping key of a street name: folded, with the generic `ulica` / `ul.` descriptor made optional.

    `Adamičeva`, `Adamičeva ulica`, `UL. Adamičeva` are one key. `Cesta` and `Ulica` of one stem are not: the
    descriptor is only ever dropped when it is the generic word `ulica` (never `cesta`, `trg`, `avenija`, ...).
    """
    return GENERIC_TAIL.sub(r"\1", GENERIC_HEAD.sub(r"\1", fold(_text(text)))).strip()


def canonical_streets(address_names, way_names) -> dict[str, str]:
    """{street_key: canonical display name} from the address spellings and the OSM street ways' `name` values.

    The canonical spelling is the street way's name when one exists (it is the name the map itself draws), else the
    most common address spelling; a tie goes to the alphabetically first, so the result never depends on input order.
    """
    ways: dict[str, Counter] = {}
    for name in way_names:
        t = _text(name)
        if t:
            ways.setdefault(street_key(t), Counter())[t] += 1
    spellings: dict[str, Counter] = {}
    for name in address_names:
        t = _text(name)
        if t:
            spellings.setdefault(street_key(t), Counter())[t] += 1
    out = {}
    for key in set(ways) | set(spellings):
        pool = ways.get(key) or spellings.get(key)
        out[key] = sorted(pool.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return out


def canonicalise(frame: pd.DataFrame, canonical: dict[str, str], column: str = "street") -> pd.Series:
    """The canonical display name of every row's street; an unknown street keeps its own spelling."""
    text = frame[column].map(_text)
    return text.map(lambda s: canonical.get(street_key(s), s) if s else "")


def _osm_elements(path: Path) -> list[dict]:
    path = Path(path)
    files = sorted(p for p in ([path] if path.is_file() else path.glob("*.json")))
    elements = []
    for file in files:
        body = json.loads(file.read_text(encoding="utf-8"))
        elements.extend(body.get("elements", []))
    return elements


def address_points(paths, transformer=None) -> gpd.GeoDataFrame:
    """One row per house number of every address element (a node, or a way's centre), in EPSG:3765.

    Ranges and lists are split by the same rule the rest of the pipeline uses (`addresses.numbers`): the ends the
    source states, never a number it does not.
    """
    transformer = transformer or Transformer.from_crs(4326, CRS, always_xy=True)
    rows = []
    for element in _osm_elements(paths):
        tags = element.get("tags") or {}
        street = _text(tags.get("addr:street"))
        at = element if element.get("type") == "node" else (element.get("center") or {})
        if not street or "lat" not in at or "lon" not in at:
            continue
        for number in house_numbers(tags.get("addr:housenumber")):
            rows.append((f"{element.get('type')}/{element.get('id')}", street, number, float(at["lon"]),
                         float(at["lat"])))
    frame = pd.DataFrame(rows, columns=["osm", "street", "number", "lon", "lat"])
    if not len(frame):
        return gpd.GeoDataFrame({"osm": [], "street": [], "number": []},
                                geometry=gpd.GeoSeries([], crs=CRS), crs=CRS)
    x, y = transformer.transform(frame.lon.to_numpy(float), frame.lat.to_numpy(float))
    return gpd.GeoDataFrame(frame[["osm", "street", "number"]], geometry=shapely.points(x, y), crs=CRS)


def street_ways(paths, canonical: dict[str, str] | None = None) -> gpd.GeoDataFrame:
    """Every named highway way as a line in EPSG:3765, with its canonical `street` name."""
    transformer = Transformer.from_crs(4326, CRS, always_xy=True)
    rows, lines = [], []
    for element in _osm_elements(paths):
        tags = element.get("tags") or {}
        name = _text(tags.get("name"))
        geometry = element.get("geometry") or []
        if not name or len(geometry) < 2 or "highway" not in tags:
            continue
        lon = np.array([g["lon"] for g in geometry], dtype=float)
        lat = np.array([g["lat"] for g in geometry], dtype=float)
        x, y = transformer.transform(lon, lat)
        rows.append(name)
        lines.append(shapely.LineString(np.column_stack([x, y])))
    frame = gpd.GeoDataFrame({"way_name": rows}, geometry=lines, crs=CRS)
    frame["street"] = frame.way_name.map(lambda n: (canonical or {}).get(street_key(n), n))
    return frame


def street_lines(paths, canonical: dict[str, str] | None = None) -> gpd.GeoDataFrame:
    """Every named street as a line in EPSG:3765, from Overpass JSON files and/or the PBF's `zg_osm_streets.parquet`.

    Both are OSM, but the PBF covers the whole city: the Overpass extract of the dense box misses named streets in the
    periphery, and a building 40 m from one of those is not "without a street".
    """
    frames = []
    for item in paths:
        if item is None:
            continue
        item = Path(item)
        candidates = [item] if item.is_file() else sorted(item.glob("*.parquet")) + sorted(item.glob("*.json"))
        for path in candidates:
            if path.suffix == ".parquet":
                frame = gpd.read_parquet(path, columns=["name", "geometry"]).to_crs(CRS)
                frame = frame[frame.name.notna() & frame.geometry.notna()]
                frames.append(gpd.GeoDataFrame({"way_name": frame.name.astype(str).str.strip()},
                                               geometry=frame.geometry.values, crs=CRS))
            elif path.name.startswith("zagreb-interpolation"):
                continue
            else:
                frames.append(street_ways(path))
    if not frames:
        return gpd.GeoDataFrame({"way_name": [], "street": []}, geometry=[], crs=CRS)
    frame = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=CRS)
    frame = frame[frame.way_name.ne("") & frame.geometry.notna() & ~frame.geometry.is_empty]
    frame = frame.drop_duplicates(subset="geometry")
    frame["street"] = frame.way_name.map(lambda n: (canonical or {}).get(street_key(n), n))
    return frame.reset_index(drop=True)


def _valid(evidence: pd.DataFrame) -> np.ndarray:
    return (evidence.street.map(_text).ne("")
            & ~evidence.number.map(_text).str.casefold().isin(NO_NUMBER)
            & evidence.geometry.notna() & ~evidence.geometry.is_empty).to_numpy(bool)


def match(points: gpd.GeoDataFrame, buildings: gpd.GeoDataFrame, lines: gpd.GeoDataFrame,
          max_near: float = MAX_NEAR_M, source: str = "osm") -> tuple[pd.DataFrame, pd.DataFrame]:
    """(address rows, one evidence row per input point) with match_kind inside / near / ambiguous / outside.

    A near match needs both distances the issue states: the footprint is the nearest within `max_near` of the point,
    and it lies within `max_near` of the centreline of the street the address names. Two footprints equally close
    (within 10 cm) are an ambiguous near match, not a coin toss.
    """
    if "gid" not in buildings or buildings.gid.duplicated().any():
        raise ValueError("building gids must exist and be unique before address attribution")
    if points.crs is None or buildings.crs is None:
        raise ValueError("address points and buildings must both have an explicit CRS")
    points = points.to_crs(buildings.crs) if points.crs != buildings.crs else points
    evidence = points.reset_index(drop=True).copy()
    evidence["street"] = evidence.street.map(_text)
    evidence["number"] = evidence.number.map(_text)
    evidence["source"] = source
    valid = _valid(evidence)
    evidence["match_kind"] = np.where(valid, "outside", "invalid_source_record")
    evidence["gid"] = pd.Series([pd.NA] * len(evidence), dtype="Int64")
    evidence["candidate_gids"] = pd.Series([[] for _ in range(len(evidence))], dtype=object)
    evidence["match_distance_m"] = np.nan
    evidence["street_distance_m"] = np.nan

    gids = buildings.gid.to_numpy(np.int64)
    position = {int(g): i for i, g in enumerate(gids)}
    geometries = buildings.geometry.values
    tree = shapely.STRtree(geometries)
    index = np.flatnonzero(valid)
    if len(index) and len(buildings):
        i_pt, i_fp = tree.query(evidence.geometry.values[index], predicate="covered_by")
        order = np.lexsort((gids[i_fp], i_pt))
        i_pt, i_fp = i_pt[order], i_fp[order]
        covered: dict[int, list[int]] = {}
        for p, f in zip(i_pt, i_fp, strict=True):
            found = covered.setdefault(int(p), [])
            if int(gids[f]) not in found:
                found.append(int(gids[f]))
        for p, found in covered.items():
            row = int(index[p])
            evidence.at[row, "candidate_gids"] = found
            evidence.at[row, "match_distance_m"] = 0.0
            if len(found) == 1:
                evidence.at[row, "match_kind"] = "inside"
                evidence.at[row, "gid"] = found[0]
            else:
                evidence.at[row, "match_kind"] = "ambiguous_covered_by"

        missing = [int(index[p]) for p in range(len(index)) if p not in covered]
        if missing:
            street_geometry = _street_geometry(lines)
            pts = evidence.geometry.values[missing]
            (i_pt, i_fp), distance = tree.query_nearest(pts, max_distance=max_near, all_matches=True,
                                                        return_distance=True)
            nearest: dict[int, list[tuple[int, float]]] = {}
            for p, f, d in zip(i_pt, i_fp, np.asarray(distance, dtype=float), strict=True):
                nearest.setdefault(int(p), []).append((int(f), float(d)))
            for p, found in nearest.items():
                row = missing[p]
                closest = min(d for _, d in found)
                reached = [(gids[f], d) for f, d in found if d <= closest + 0.1]
                unique = sorted({int(g) for g, _ in reached})
                evidence.at[row, "candidate_gids"] = unique
                if len(unique) > 1:
                    evidence.at[row, "match_kind"] = "ambiguous_near"
                    continue
                gid = unique[0]
                way = street_geometry.get(street_key(evidence.at[row, "street"]))
                if way is None:
                    evidence.at[row, "match_kind"] = "outside"       # no centreline to face: never guess
                    continue
                gap = float(shapely.distance(geometries[position[gid]], way))
                evidence.at[row, "street_distance_m"] = gap
                if gap <= max_near:
                    evidence.at[row, "match_kind"] = "near"
                    evidence.at[row, "gid"] = gid
                    evidence.at[row, "match_distance_m"] = closest
                else:
                    evidence.at[row, "match_kind"] = "outside"       # the footprint does not face the street

    matched = evidence.loc[evidence.match_kind.isin(["inside", "near"]), ["gid", "street", "number"]].copy()
    matched = matched.drop_duplicates()
    matched["withheld"] = False
    matched = matched[["gid", "street", "number", "withheld"]].astype({"gid": "int32"}).reset_index(drop=True)
    return matched, evidence.reset_index(drop=True)


def _street_geometry(lines: gpd.GeoDataFrame) -> dict[str, shapely.Geometry]:
    """{street_key: every way of that street, dissolved} for the facing test."""
    if not len(lines):
        return {}
    frame = lines.copy()
    frame["key"] = frame.street.map(street_key)
    return {key: shapely.union_all(group.geometry.values) for key, group in frame.groupby("key")}


def interpolation_points(ways, endpoints: dict[int, dict], canonical: dict[str, str] | None = None,
                         transformer=None, points: gpd.GeoDataFrame | None = None,
                         max_endpoint_m: float = 20.0) -> gpd.GeoDataFrame:
    """House numbers along `addr:interpolation` ways, from numbered endpoints only.

    `ways` are Overpass elements (`nodes`, `tags`, `geometry`); `endpoints` maps a node id to `{"number", "street"}`.
    Zagreb's extract keeps a way's vertices but not their node ids (0 of its 22 ways), so a way without them takes each
    end's nearest address point (`points`: osm, street, number, geometry) within `max_endpoint_m` — a number a mapper
    put on that spot, never one made up here. A segment expands when both ends are numbered and differ by more than one
    step; the numbers in between are spread evenly along it. Anything else yields nothing: no endpoint, no range.
    """
    transformer = transformer or Transformer.from_crs(4326, CRS, always_xy=True)
    tree = shapely.STRtree(points.geometry.values) if points is not None and len(points) else None

    def end_number(lat: float, lon: float) -> dict | None:
        """The nearest address point to a way's end vertex, when it is within max_endpoint_m."""
        if tree is None:
            return None
        x, y = transformer.transform(lon, lat)
        vertex = shapely.points(x, y)
        hits = tree.query(vertex.buffer(max_endpoint_m))
        if not len(hits):
            return None
        near = points.iloc[hits]
        pick = near.iloc[int(np.argmin(shapely.distance(near.geometry.values, vertex)))]
        return {"number": str(pick["number"]), "street": str(pick["street"])}

    rows, geometry = [], []
    for way in ways:
        tags = way.get("tags") or {}
        parity = str(tags.get("addr:interpolation", "")).lower()
        nodes = way.get("nodes") or []
        vertices = [(node["lat"], node["lon"]) for node in way.get("geometry") or []]
        if parity not in ("odd", "even", "all") or len(vertices) < 2:
            continue
        positions = {node["id"]: (node["lat"], node["lon"]) for node in way.get("geometry") or [] if "id" in node}
        segments = []
        if nodes and len(nodes) > 1:
            for first, second in zip(nodes, nodes[1:]):
                a, b = endpoints.get(int(first)), endpoints.get(int(second))
                at = (positions.get(int(first)), positions.get(int(second)))
                if a and b and None not in at:
                    segments.append((at[0], at[1], a, b))
        else:
            a, b = end_number(*vertices[0]), end_number(*vertices[-1])
            if a and b:
                segments.append((vertices[0], vertices[-1], a, b))
        for at, bt, a, b in segments:
            try:
                n0, n1 = int(str(a["number"]).strip()), int(str(b["number"]).strip())
            except (KeyError, ValueError):
                continue
            if abs(n1 - n0) < 2:
                continue
            step = 1 if parity == "all" else 2
            street = _text(tags.get("addr:street")) or _text(a.get("street"))
            if not street:
                continue
            for number in range(min(n0, n1) + step, max(n0, n1), step):
                fraction = (number - n0) / (n1 - n0)
                lat = at[0] + fraction * (bt[0] - at[0])
                lon = at[1] + fraction * (bt[1] - at[1])
                x, y = transformer.transform(lon, lat)
                rows.append((f"w{way.get('id')}", (canonical or {}).get(street_key(street), street), str(number)))
                geometry.append(shapely.points(x, y))
    if not rows:
        return gpd.GeoDataFrame({"osm": [], "street": [], "number": []},
                                geometry=gpd.GeoSeries([], crs=CRS), crs=CRS)
    return gpd.GeoDataFrame(pd.DataFrame(rows, columns=["osm", "street", "number"]), geometry=geometry, crs=CRS)


def inherit_ancillary(buildings: gpd.GeoDataFrame, addresses: pd.DataFrame,
                      max_area: float = MIN_AREA_M2) -> pd.DataFrame:
    """A garage or shed of at most `max_area` that shares an edge with an addressed footprint inherits its address.

    The issue's step 4: "pripada zgradi Ilica 25". One pass only, from an addressed building to its unaddressed
    neighbour, so a chain of sheds never walks away from the house that owns it; the parent is the lowest gid when a
    shed touches two, which keeps the result independent of file order.
    """
    if not len(addresses) or not len(buildings):
        return pd.DataFrame(columns=["gid", "street", "number", "withheld", "match_kind"])
    known = addresses[~addresses.withheld.fillna(False).astype(bool)]
    by_gid = known.drop_duplicates("gid").set_index("gid")
    small = buildings[(buildings["area"] <= max_area) & ~buildings.gid.astype(int).isin(set(by_gid.index))]
    if not len(small) or not len(known):
        return pd.DataFrame(columns=["gid", "street", "number", "withheld", "match_kind"])
    parents = buildings[buildings.gid.astype(int).isin(set(by_gid.index))]
    tree = shapely.STRtree(parents.geometry.values)
    i_small, i_parent = tree.query(small.geometry.values, predicate="intersects")
    best: dict[int, int] = {}
    for s, p in zip(i_small.tolist(), i_parent.tolist(), strict=True):
        child, parent = int(small.gid.to_numpy()[s]), int(parents.gid.to_numpy()[p])
        if parent in by_gid.index and child not in best:
            best[child] = parent
        elif child in best and parent < best[child] and parent in by_gid.index:
            best[child] = parent
    rows = [(child, str(by_gid.at[parent, "street"]), str(by_gid.at[parent, "number"]), False, "inherited")
            for child, parent in sorted(best.items())]
    return pd.DataFrame(rows, columns=["gid", "street", "number", "withheld", "match_kind"])


def street_references(buildings: gpd.GeoDataFrame, lines: gpd.GeoDataFrame, addressed,
                      max_m: float = MAX_STREET_REF_M) -> pd.DataFrame:
    """gid, street, distance_m for every building without an address: the nearest named street within `max_m`.

    A reference names a street from the map's own centrelines; it is never a house number and never a rough guess
    from a street name someone typed.
    """
    if not len(buildings) or not len(lines):
        return pd.DataFrame(columns=["gid", "street", "distance_m"])
    todo = buildings[~buildings.gid.astype(int).isin(set(int(g) for g in addressed))]
    if not len(todo):
        return pd.DataFrame(columns=["gid", "street", "distance_m"])
    frame = lines[lines.geometry.notna() & ~lines.geometry.is_empty].reset_index(drop=True)
    tree = shapely.STRtree(frame.geometry.values)
    (i_pt, i_line), distance = tree.query_nearest(todo.geometry.values, max_distance=max_m, all_matches=False,
                                                  return_distance=True)
    out = pd.DataFrame({"gid": todo.gid.to_numpy(np.int32)[i_pt],
                        "street": frame.street.to_numpy(object)[i_line],
                        "distance_m": np.asarray(distance, dtype=float)})
    return out.drop_duplicates("gid").sort_values("gid").reset_index(drop=True)


def unreferenced_distance(buildings: gpd.GeoDataFrame, lines: gpd.GeoDataFrame, unresolved) -> dict:
    """How far the buildings with neither a number nor a reference are from the nearest named street at all.

    This is the measured reason they have no reference: a 60 m rule is not the only thing between them and one.
    """
    todo = buildings[buildings.gid.astype(int).isin(set(int(g) for g in unresolved))]
    if not len(todo) or not len(lines):
        return {"buildings": 0}
    tree = shapely.STRtree(lines.geometry.values)
    (i_pt, _i_line), distance = tree.query_nearest(todo.geometry.values, all_matches=False, return_distance=True)
    gaps = np.asarray(distance, dtype=float)
    return {"buildings": int(len(todo)), "median_m": float(np.median(gaps)),
            "p90_m": float(np.percentile(gaps, 90)), "max_m": float(gaps.max()),
            "within_100_m": int((gaps <= 100).sum()), "beyond_200_m": int((gaps > 200).sum())}


def report(addresses: pd.DataFrame, references: pd.DataFrame, buildings: gpd.GeoDataFrame,
           evidence: pd.DataFrame | None = None, min_area: float = MIN_AREA_M2,
           target: float = TARGET) -> dict:
    """The issue's measurement: house numbers, street references only, neither — all buildings and over 30 m².

    The denominator is every footprint in the build (298,675 on `v20261103-fix`), not the address rows and not the
    buildings a source happens to mention. Withheld rows never count as covered.
    """
    shown = addresses[~addresses.withheld.fillna(False).astype(bool)] if len(addresses) else addresses
    numbered = {int(g) for g in shown.gid} if len(shown) else set()
    referenced = {int(g) for g in references.gid} - numbered if len(references) else set()
    gids = buildings.gid.to_numpy(np.int64)
    # not `buildings.area`: on a GeoDataFrame that property is the geometry's area, not the source column
    area = buildings["area"].to_numpy(float)
    large = area > min_area

    def share(mask: np.ndarray) -> dict:
        total = int(mask.sum())
        numbers = int(np.isin(gids[mask], list(numbered)).sum())
        refs = int(np.isin(gids[mask], list(referenced)).sum())
        return {"buildings": total, "with_number": numbers, "number_share": numbers / total if total else 0.0,
                "reference_only": refs, "findable": numbers + refs,
                "findable_share": (numbers + refs) / total if total else 0.0,
                "neither": total - numbers - refs}

    out = {"definition": "distinct known gids with a non-withheld house number, else a street reference",
           "target": float(target), "min_area_m2_exclusive": float(min_area),
           "all": share(np.ones(len(buildings), dtype=bool)), "over_min_area": share(large),
           "address_rows": int(len(shown)), "reference_rows": int(len(references))}
    out["number_target_met"] = out["over_min_area"]["number_share"] >= 0.8
    out["target_met"] = out["over_min_area"]["findable_share"] >= target
    if evidence is not None and len(evidence):
        methods = evidence.loc[evidence.gid.notna()].drop_duplicates("gid")
        out["matched_by_method"] = {str(k): int(v) for k, v in methods.match_kind.value_counts().items()}
        out["matched_by_source"] = {str(k): int(v) for k, v in methods.source.value_counts().items()}
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--buildings", type=Path, default=Path("data/buildings.parquet"))
    ap.add_argument("--addresses", type=Path, default=Path("data/raw/osm/addresses"))
    ap.add_argument("--streets", type=Path, default=Path("data/raw/osm/streets"),
                    help="Overpass street extract (JSON), or a folder of it")
    ap.add_argument("--street-lines", type=Path, default=None,
                    help="the PBF's zg_osm_streets.parquet: named ways for the whole city, not only the dense box")
    ap.add_argument("--interpolation", type=Path, default=None,
                    help="the Overpass file of addr:interpolation ways (default: <streets>/zagreb-interpolation-*.json)")
    ap.add_argument("--existing", type=Path, default=None,
                    help="an addresses.parquet to union with (existing entries win, takedowns hold)")
    ap.add_argument("--out-addresses", type=Path, default=None, help="write the matched address rows")
    ap.add_argument("--refs", type=Path, default=None, help="write gid, street for every building without one")
    ap.add_argument("--evidence", type=Path, default=None, help="write the local per-point match evidence")
    ap.add_argument("--report", type=Path, default=None, help="write the coverage report")
    args = ap.parse_args(argv)

    buildings = gpd.read_parquet(args.buildings, columns=["gid", "area", "geometry"])
    points = address_points(args.addresses)
    ways = street_lines([args.streets, args.street_lines])
    canonical = canonical_streets(points.street, ways.way_name)
    points["street"] = canonicalise(points, canonical)
    ways["street"] = ways.way_name.map(lambda n: canonical.get(street_key(n), n))
    matched, evidence = match(points, buildings, ways)
    before = coverage(pd.read_parquet(args.existing), buildings) if args.existing else None
    if args.existing:
        # the shipped table gets the canonical street names too, or one street would keep two spellings in the index
        old = pd.read_parquet(args.existing)
        old["street"] = canonicalise(old, canonical)
        matched = merge_addresses(old, matched, buildings.gid)
    interpolation_file = args.interpolation or next(iter(sorted(args.streets.glob("zagreb-interpolation-*.json"))), None)
    interpolation = (interpolation_points(_osm_elements(interpolation_file), {}, canonical, points=points)
                     if interpolation_file else interpolation_points([], {}, canonical))
    if len(interpolation):
        extra, extra_evidence = match(interpolation, buildings, ways, source="osm_interpolation")
        matched = (pd.concat([matched, extra], ignore_index=True)
                   .drop_duplicates(["gid", "street", "number"]).reset_index(drop=True))
        evidence = pd.concat([evidence, extra_evidence], ignore_index=True)
    inherited = inherit_ancillary(buildings, matched)
    if len(inherited):
        matched = pd.concat([matched, inherited.drop(columns="match_kind")], ignore_index=True)
        evidence = pd.concat([evidence, inherited.assign(osm="", source="osm_inherited")], ignore_index=True)
    referenced = street_references(buildings, ways, set(matched.gid.astype(int)))
    result = report(matched, referenced, buildings, evidence)
    neither = set(buildings.gid.astype(int)) - set(matched.gid.astype(int)) - set(referenced.gid.astype(int))
    result["neither_nearest_street_m"] = unreferenced_distance(buildings, ways, neither)
    if before is not None:
        result["before"] = before
    result["interpolation"] = {"file": str(interpolation_file) if interpolation_file else None,
                              "ways": len(_osm_elements(interpolation_file)) if interpolation_file else 0,
                              "expanded_points": int(len(interpolation)),
                              "note": "an end takes the nearest address point within 20 m when the extract carries no node ids; "
                              "a range without two numbered ends yields nothing"}
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    for path, frame in ((args.out_addresses, matched), (args.refs, referenced), (args.evidence, evidence)):
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            frame.to_parquet(path, index=False)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    main()
