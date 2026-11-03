"""Zagreb: the street network, the pavements beside it and the street lamps, from OpenStreetMap.

    uv run python -m pipeline.s17_zagreb_roads --version vYYYYMMDD-x

Written into web/data/<version>/:
  roads.bin.gz   float32 x, z per way vertex, engine local metres (city.py ORIGIN), gzipped
  roads.json     licence, the class list, one entry per way {o, c, cls, w}, the lamp block, counts
  lamps.bin.gz   float32 x, z per street lamp, gzipped

Source: OpenStreetMap contributors, ODbL. The highway=* ways and the highway=street_lamp nodes of the Croatia
extract (data/raw/osm/croatia-latest.osm.pbf), read straight with pyogrio, clipped to city.py BOX_WGS84, the same
box s16_zagreb_trams reads rails from. Every way carries its class and a ribbon width so the client can draw a road
as a strip instead of a hairline.

A way is kept whole, in the extract's own point order: OSM has already split the network at junctions, so a gap
between neighbouring points is a gap in the mapping, not in the drawing. The stage prints the worst gap and the
median gap over every way, which is how a broken read would show up.

The four pavement kinds (footway, path, steps, cycleway) stay separate classes, each with its own width, and are
also listed under "groups" so the client can switch the sidewalk layer on and off as one thing.
"""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np

from . import city

ROOT = Path(__file__).resolve().parents[2]
PBF = ROOT / "data" / "raw" / "osm" / "croatia-latest.osm.pbf"
WEB = Path(__file__).resolve().parents[1] / "web"

LICENCE = "OpenStreetMap contributors, ODbL"
# Ribbon widths in metres, by class. Croatian street space, not a lane count: one value per class decides how much
# of the ground a road covers, so the class table is the whole of the geometry model.
CLASSES = [
    ("motorway", 14.0),
    ("trunk", 12.0),
    ("primary", 10.0),
    ("secondary", 9.0),
    ("tertiary", 8.0),
    ("residential", 6.5),
    ("unclassified", 6.0),
    ("living_street", 5.5),
    ("service", 4.0),
    ("pedestrian", 6.0),
    ("footway", 1.8),
    ("path", 1.5),
    ("steps", 1.5),
    ("cycleway", 1.8),
]
WIDTH = dict(CLASSES)
# A link carries the same traffic as the road it leaves, at the same width, so it takes the parent class.
LINK = {"motorway_link": "motorway", "trunk_link": "trunk", "primary_link": "primary",
        "secondary_link": "secondary", "tertiary_link": "tertiary"}
GROUPS = {"road": [n for n, _ in CLASSES if n not in ("footway", "path", "steps", "cycleway")],
          "pavement": ["footway", "path", "steps", "cycleway"]}
# Classes the box does carry but this stage leaves out on purpose: not a carriageway, not a pavement, or not built.
SKIP = {"track", "bridleway", "corridor", "platform", "elevator", "raceway", "services", "road",
        "proposed", "planned", "construction", "bus_stop", "crossing", "steps_theatre"}


def class_of(hw):
    """The class a highway tag belongs to, or None when the tag is not one this stage draws."""
    if not isinstance(hw, str):
        return None
    hw = LINK.get(hw, hw)
    return hw if hw in WIDTH else None


def read_ways():
    """The highway ways inside the city box, clipped to it, with the tags the class and the checks need."""
    import pyogrio
    import shapely
    lon0, lat0, lon1, lat1 = city.BOX_WGS84
    # osm_id and name are read so a later check can join a way back to its OSM tags; neither goes into the output.
    df = pyogrio.read_dataframe(PBF, layer="lines", bbox=city.BOX_WGS84,
                                columns=["osm_id", "name", "highway"])
    keep = np.array([class_of(h) is not None for h in df["highway"]])
    dropped = df.loc[~keep, "highway"].value_counts(dropna=False)
    df = df[keep].copy()
    # A way that crosses the box edge is cut there, so no vertex of the output sits outside the box.
    df["geometry"] = shapely.clip_by_rect(df.geometry.to_numpy(), lon0, lat0, lon1, lat1)
    df = df[~df.geometry.is_empty].to_crs(3765)
    return df, dropped


def read_lamps():
    """The highway=street_lamp nodes inside the city box. A node is either inside or not, so nothing to clip."""
    import pyogrio
    df = pyogrio.read_dataframe(PBF, layer="points", bbox=city.BOX_WGS84, columns=["osm_id", "highway"])
    return df[df["highway"] == "street_lamp"].to_crs(3765)


def parts(geom):
    """LineString or MultiLineString (a clipped way can come back split) to a list of coordinate arrays."""
    from shapely.geometry import LineString, MultiLineString
    if isinstance(geom, LineString):
        return [np.asarray(geom.coords, dtype="float64")] if len(geom.coords) >= 2 else []
    if isinstance(geom, MultiLineString):
        return [np.asarray(g.coords, dtype="float64") for g in geom.geoms if len(g.coords) >= 2]
    return []


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", required=True)
    args = ap.parse_args(argv)
    out = WEB / "data" / args.version
    out.mkdir(parents=True, exist_ok=True)

    df, dropped = read_ways()
    df["cls"] = [class_of(h) for h in df["highway"]]
    print(f"{len(df):,} highway ways in the box, {len(WIDTH)} classes", flush=True)
    in_skip = int(sum(n for t, n in dropped.items() if t in SKIP))
    stray = int(sum(n for t, n in dropped.items() if t not in SKIP))
    top = ", ".join(f"{(t if isinstance(t, str) else 'no highway tag')} {n}" for t, n in dropped.head(6).items())
    print(f"left out {int(dropped.sum()):,} ways: {in_skip:,} on the skip list, {stray:,} of tags outside "
          f"the table ({top})", flush=True)

    xs, zs, ways = [], [], []
    per_class = {name: [0, 0.0] for name, _ in CLASSES}     # ways, metres
    gap_max_way, gaps = [], []
    for cls, geom in zip(df["cls"].to_numpy(), df.geometry.to_numpy()):
        for c in parts(geom):
            x, z = c[:, 0] - city.ORIGIN[0], -(c[:, 1] - city.ORIGIN[1])
            o = len(xs)
            ways.append({"o": o, "c": int(len(x)), "cls": cls, "w": WIDTH[cls]})
            xs.extend(np.asarray(x, dtype="<f4").tolist())
            zs.extend(np.asarray(z, dtype="<f4").tolist())
            seg = np.hypot(np.diff(x), np.diff(z))
            per_class[cls][0] += 1
            per_class[cls][1] += float(seg.sum())
            if len(seg):
                gap_max_way.append(float(seg.max()))
                gaps.append(seg)
    # ways stay in the order they were appended: the offsets point into the buffer, so sorting them would unpick it
    if not ways:
        raise SystemExit("no ways read, check the extract")

    arr = np.empty((len(xs) * 2,), dtype="<f4")
    arr[0::2] = np.asarray(xs, dtype="<f4")
    arr[1::2] = np.asarray(zs, dtype="<f4")
    if not np.isfinite(arr).all():
        raise SystemExit("road coordinates are not finite, the crs step is wrong")
    (out / "roads.bin.gz").write_bytes(gzip.compress(arr.tobytes(), 6))

    lamps = read_lamps()
    # read_lamps has already reprojected to EPSG:3765, so subtract ORIGIN; local() would take lon/lat and give inf.
    lamp_xy = np.asarray([(g.x, g.y) for g in lamps.geometry.to_numpy()], dtype="float64")
    lx = lamp_xy[:, 0] - city.ORIGIN[0]
    lz = -(lamp_xy[:, 1] - city.ORIGIN[1])
    if not (np.isfinite(lx).all() and np.isfinite(lz).all()):
        raise SystemExit("lamp coordinates are not finite, the crs step is wrong")
    larr = np.empty((len(lx) * 2,), dtype="<f4")
    larr[0::2] = np.asarray(lx, dtype="<f4")
    larr[1::2] = np.asarray(lz, dtype="<f4")
    (out / "lamps.bin.gz").write_bytes(gzip.compress(larr.tobytes(), 6))
    lamp_block = {"o": 0, "c": len(lx)}

    total_km = sum(v[1] for v in per_class.values()) / 1000.0
    for name, _ in CLASSES:
        n, m = per_class[name]
        if n:
            print(f"  {name:<13} {n:>7,} ways {m / 1000:>8.1f} km", flush=True)
    print(f"{len(ways):,} way ribbons, {len(xs):,} points, {total_km:.0f} km", flush=True)
    allgaps = np.concatenate(gaps) if gaps else np.zeros(0)
    longest = max(gap_max_way) if gap_max_way else 0.0
    print(f"gaps: median {np.median(allgaps):.1f} m, p99 {np.percentile(allgaps, 99):.1f} m, "
          f"longest {longest:.1f} m, median per way {np.median(gap_max_way):.1f} m, "
          f"{int((allgaps > 200).sum())} gaps over 200 m", flush=True)
    print(f"lamps {len(lx):,}", flush=True)

    meta = {
        "licence": LICENCE,
        "classes": [name for name, _ in CLASSES],
        "groups": GROUPS,
        "ways": ways,
        "lamps": lamp_block,
        "counts": {"ways": len(ways), "points": len(xs), "lamps": len(lx),
                   "km": {name: round(v[1] / 1000.0, 1) for name, v in per_class.items() if v[0]}},
        "source": "OpenStreetMap highway=* ways and highway=street_lamp nodes, croatia-latest.osm.pbf",
    }
    (out / "roads.json").write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False) + "\n",
                                    encoding="utf-8")
    for name in ("roads.bin.gz", "roads.json", "lamps.bin.gz"):
        print(f"  {name:<13} {(out / name).stat().st_size / 1e6:.2f} MB", flush=True)
    print(f"written into web/data/{args.version}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
