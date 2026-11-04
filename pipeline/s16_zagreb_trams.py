"""Zagreb: the real tram network and its timetable, from ZET's own GTFS.

    uv run python -m pipeline.s16_zagreb_trams --version vYYYYMMDD-x

Written into web/data/<version>/:
  trams.json        lines, the shape index, licence line, counts
  trams_shapes.bin  float32 x, z per shape point, engine local metres (city.py ORIGIN), gzipped
  trams_trips.bin   int32 per trip: shape index, start second, end second, line index, gzipped
  trams_rails.bin   float32 x, z per rail vertex + an index, the mapped railway=tram ways, gzipped

Sources:
- Routes, trips, shapes and times: ZET GTFS static (https://zet.hr/gtfs-scheduled/latest), Croatian Open Licence.
  Only route_type 0 (tram) is taken. Both directions are separate shapes in the feed, so a trip's geometry is
  the geometry the vehicle actually drives, not a reversed guess.
- Rails: OpenStreetMap railway=tram ways from the Croatia extract (ODbL).

What is real here: which lines exist, which shape each trip drives, and when it leaves and arrives. What is a
model: the position between the two ends. Without a stop-by-stop walk a vehicle would move at one average speed
for the whole trip, so the client spreads each trip's schedule over each trip's stops (trams_stops.bin) instead.
"""
import argparse
import csv
import gzip
import json
from datetime import date, datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
GTFS = ROOT / "data" / "raw" / "zet" / "gtfs"
WEB = Path(__file__).resolve().parents[1] / "web"
ORIGIN = (459370.1, 5074937.5)      # city.py ORIGIN, EPSG:3765

LICENCE = ("GTFS: Zagrebacki elektricni tramvaj d.o.o., Otvorena dozvola / Open Licence (Republika Hrvatska); "
           "rails: OpenStreetMap contributors, ODbL")
TRAM = "0"
CONNECT = 40.0                      # metres a segment block may sit from the previous block's end to still belong


def rows(name):
    with open(GTFS / name, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def seconds(hhmmss):
    h, m, s = (int(x) for x in hhmmss.split(":"))
    return h * 3600 + m * 60 + s


def active_services(day: date):
    """calendar.txt plus the exceptions in calendar_dates.txt, which is how ZET handles holidays."""
    active = set()
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][day.weekday()]
    for r in rows("calendar.txt"):
        if r[wd] != "1":
            continue
        if r["start_date"] <= day.strftime("%Y%m%d") <= r["end_date"]:
            active.add(r["service_id"])
    for r in rows("calendar_dates.txt"):
        if r["date"] != day.strftime("%Y%m%d"):
            continue
        if r["exception_type"] == "1":
            active.add(r["service_id"])
        elif r["exception_type"] == "2":
            active.discard(r["service_id"])
    return active


def local(lon, lat):
    """EPSG:4326 to the engine's local metres (x east, z south), through EPSG:3765."""
    from pyproj import Transformer
    t = Transformer.from_crs(4326, 3765, always_xy=True)
    e, n = t.transform(np.asarray(lon, dtype="float64"), np.asarray(lat, dtype="float64"))
    return np.asarray(e) - ORIGIN[0], -(np.asarray(n) - ORIGIN[1])


def chain(p):
    """ZET writes one shape_id as a pile of segment blocks with several route variants merged into it, and the
    duplicates are not marked. Read in feed order it teleports: shape 3_3 has 286 rows for 189 distinct sequences and
    61.7 km of geometry for a line about 10 km long, with 808 m jumps between neighbouring points. A tram drives one
    variant, so take the longest chain of blocks whose ends touch: continuous, no zigzag, no jump across town."""
    blocks, cur = [], [p[0]]
    for a, b in zip(p, p[1:]):
        if b[0] == a[0] + 1:
            cur.append(b)
        else:
            blocks.append(cur)
            cur = [b]
    blocks.append(cur)
    if len(blocks) < 2:
        return p
    bx, bz = local([b[0][1] for b in blocks], [b[0][2] for b in blocks])          # block starts
    ex, ez = local([b[-1][1] for b in blocks], [b[-1][2] for b in blocks])        # block ends
    n = len(blocks)
    lengths = []
    for b in blocks:
        lx, lz = local([q[1] for q in b], [q[2] for q in b])
        lengths.append(float(np.hypot(np.diff(lx), np.diff(lz)).sum()) if len(b) > 1 else 0.0)
    best = list(lengths)
    prev = [-1] * n
    for j in range(1, n):
        for i in range(j):
            if (bx[j] - ex[i]) ** 2 + (bz[j] - ez[i]) ** 2 <= CONNECT * CONNECT and best[i] + lengths[j] > best[j]:
                best[j] = best[i] + lengths[j]
                prev[j] = i
    j = max(range(n), key=lambda k: best[k])
    chosen = []
    while j >= 0:
        chosen.append(blocks[j])
        j = prev[j]
    out = []
    for b in reversed(chosen):
        out.extend(b[1:] if out and (out[-1][1], out[-1][2]) == (b[0][1], b[0][2]) else b)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", required=True)
    ap.add_argument("--date", default=None, help="service day, YYYY-MM-DD (default today)")
    args = ap.parse_args(argv)
    out = WEB / "data" / args.version
    out.mkdir(parents=True, exist_ok=True)
    day = datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else date.today()

    routes = {r["route_id"]: r for r in rows("routes.txt") if r["route_type"] == TRAM}
    lines = sorted(routes, key=lambda k: (len(k), k))
    line_at = {rid: i for i, rid in enumerate(lines)}
    print(f"{len(lines)} tram lines: {', '.join(routes[r]['route_short_name'] for r in lines)}", flush=True)

    services = active_services(day)
    trips = [t for t in rows("trips.txt") if t["route_id"] in routes and t["service_id"] in services]
    print(f"service day {day}: {len(services)} calendars active, {len(trips):,} tram trips", flush=True)

    # ---- shapes: only the ones a trip of the day drives, in the feed's own point order
    want = {t["shape_id"] for t in trips}
    pts = {}
    for r in rows("shapes.txt"):
        if r["shape_id"] in want:
            pts.setdefault(r["shape_id"], []).append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]),
                                                      float(r["shape_pt_lat"])))
    shape_ids = sorted(pts)
    shape_at = {s: i for i, s in enumerate(shape_ids)}
    xs, zs, index, total_len = [], [], [], []
    for s in shape_ids:
        p = chain(sorted(pts[s]))
        x, z = local([q[1] for q in p], [q[2] for q in p])
        seg = np.hypot(np.diff(x), np.diff(z)).sum()
        index.append({"shape": s, "offset": len(xs), "count": len(x)})
        xs.extend(np.asarray(x, dtype="float32").tolist())
        zs.extend(np.asarray(z, dtype="float32").tolist())
        total_len.append(round(float(seg), 1))
    for i, ln in enumerate(total_len):
        index[i]["length_m"] = ln
    shape_arr = np.empty((len(xs) * 2,), dtype="<f4")
    shape_arr[0::2] = np.asarray(xs, dtype="<f4")
    shape_arr[1::2] = np.asarray(zs, dtype="<f4")
    (out / "trams_shapes.bin.gz").write_bytes(gzip.compress(shape_arr.tobytes(), 6))
    print(f"shapes {len(shape_ids):,}, {len(xs):,} points, {sum(total_len) / 1000:.0f} km of driven geometry",
          flush=True)

    # ---- per trip: when it leaves the first stop, when it arrives at the last, and where each stop sits along the
    # shape (distance in cm), so the client can hold a tram at a stop and run it between two stops instead of
    # spreading the whole trip over the whole line at one average speed.
    from shapely.geometry import LineString, Point
    stop_xy = {}
    for r in rows("stops.txt"):
        stop_xy[r["stop_id"]] = (float(r["stop_lon"]), float(r["stop_lat"]))
    shapely_line = {}
    for s in shape_ids:
        o, c = index[shape_at[s]]["offset"], index[shape_at[s]]["count"]
        shapely_line[s] = LineString(list(zip(xs[o:o + c], zs[o:o + c])))
    headsigns, stop_names = [], []
    headsign_at, name_at = {}, {}
    for t in trips:
        h = (t.get("trip_headsign") or "").strip()
        if h not in headsign_at:
            headsign_at[h] = len(headsigns)
            headsigns.append(h)
    for r in rows("stops.txt"):
        n = (r.get("stop_name") or "").strip()
        if n not in name_at:
            name_at[n] = len(stop_names)
            stop_names.append(n)
    by_trip = {}
    with open(GTFS / "stop_times.txt", encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            by_trip.setdefault(r["trip_id"], []).append((int(r["stop_sequence"]), r["arrival_time"],
                                                         r["departure_time"], r["stop_id"]))
    rec, stop_rec, trip_ids = [], [], []
    dist_cache = {}
    stop_name_of = {r["stop_id"]: (r.get("stop_name") or "").strip() for r in rows("stops.txt")}
    for t in trips:
        st = sorted(by_trip.get(t["trip_id"], []))
        if not st:
            continue
        start, end = seconds(st[0][2]), seconds(st[-1][1])
        if end <= start:
            continue
        trip_index = len(rec)
        rec.append((shape_at[t["shape_id"]], start, end, line_at[t["route_id"]],
                    headsign_at.get((t.get("trip_headsign") or "").strip(), -1)))
        trip_ids.append(t["trip_id"])
        ln = shapely_line[t["shape_id"]]
        for seq, arr, dep, stop_id in st:
            key = (t["shape_id"], stop_id)
            d = dist_cache.get(key)
            if d is None:
                lon, lat = stop_xy.get(stop_id, (None, None))
                if lon is None:
                    d = 0
                else:
                    x, z = local([lon], [lat])
                    d = int(round(ln.project(Point(float(x[0]), float(z[0])))) * 100)
                dist_cache[key] = d
            stop_rec.append((trip_index, seconds(arr), seconds(dep), d, name_at.get(stop_name_of.get(stop_id, ""), -1)))
    trips_arr = np.asarray(rec, dtype="<i4")
    (out / "trams_trips.bin.gz").write_bytes(gzip.compress(trips_arr.tobytes(), 6))
    stops_arr = np.asarray(stop_rec, dtype="<i4")
    (out / "trams_stops.bin.gz").write_bytes(gzip.compress(stops_arr.tobytes(), 6))
    print(f"trips {len(rec):,}, stop calls {len(stop_rec):,}", flush=True)

    # ---- rails: the mapped railway=tram ways, which is what a tram actually runs on
    try:
        import pyogrio
        from shapely.geometry import LineString
        ln = pyogrio.read_dataframe(ROOT / "data" / "raw" / "osm" / "croatia-latest.osm.pbf", layer="lines",
                                    bbox=(15.78, 45.61, 16.25, 45.97))
        ln = ln[ln["railway"].isin(["tram"])].to_crs(3765)
        rx, rz, rindex = [], [], []
        for geom in ln.geometry.to_numpy():
            if not isinstance(geom, LineString) or len(geom.coords) < 2:
                continue
            c = np.asarray(geom.coords, dtype="float64")
            x, z = c[:, 0] - ORIGIN[0], -(c[:, 1] - ORIGIN[1])
            rindex.append({"offset": len(rx), "count": len(x)})
            rx.extend(np.asarray(x, dtype="float32").tolist())
            rz.extend(np.asarray(z, dtype="float32").tolist())
        rarr = np.empty((len(rx) * 2,), dtype="<f4")
        rarr[0::2] = np.asarray(rx, dtype="<f4")
        rarr[1::2] = np.asarray(rz, dtype="<f4")
        (out / "trams_rails.bin.gz").write_bytes(gzip.compress(rarr.tobytes(), 6))
        rails = {"ways": len(rindex), "points": len(rx), "index": rindex}
        print(f"rails {len(rindex):,} ways, {len(rx):,} points", flush=True)
    except Exception as e:
        rails = {"ways": 0, "points": 0, "index": [], "note": f"rails skipped: {e}"}
        print("rails: skipped", e, flush=True)

    meta = {
        "day": day.isoformat(),
        "lines": [{"id": r, "short": routes[r]["route_short_name"], "long": routes[r]["route_long_name"],
                   "colour": "#ffffff", "text": "#1c3f94"} for r in lines],
        "shapes": index,
        "rails": rails,
        "trip_ids": trip_ids,
        "headsigns": headsigns,
        "stop_names": stop_names,
        "columns": {"trips": ["shape", "start_s", "end_s", "line", "headsign"], "stops": ["trip", "arrive_s", "depart_s", "dist_cm", "name"]},
        "vehicle": {"model": "TMK 2200", "length_m": 32.0, "width_m": 2.3, "height_m": 3.4,
                    "note": "ZET runs 140 of these five-part units; 2.3 m wide, 3.4 m high without the pantograph"},
        "counts": {"trips": len(rec), "shapes": len(shape_ids), "stop_calls": len(stop_rec)},
        "licence": LICENCE,
        "source": "ZET GTFS static (/gtfs-scheduled/latest) and OpenStreetMap railway=tram",
    }
    (out / "trams.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"written into web/data/{args.version}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
