"""Local dev server for web/: like `python3 -m http.server`, but every response says Cache-Control: no-store,
so a reload always shows the current code and data (browsers otherwise keep stale CSS/JS between edits), and /rt,
which serves ZET's live tram positions as JSON because the feed at zet.hr sends no CORS header and the page could
not read it (web/trams-layer.js polls it).
Usage: python3 scripts/serve.py [port] [--bind ADDRESS]   (default 8642, 127.0.0.1; --bind 0.0.0.0 for a phone)."""
import argparse
import functools
import http.server
import json
import math
import struct
import time
import urllib.request
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
RT_URL = "https://zet.hr/gtfs-rt-protobuf"
RT_CACHE_S = 5          # the feed is a 90 KB download from a city server: one fetch serves every poll in this window
ORIGIN = (459370.1, 5074937.5)      # pipeline/city.py's ORIGIN, EPSG:3765: engine local metres from here

# ---- GTFS-Realtime, read by hand
# The feed is protobuf, and the page needs about a dozen of its numbers. One pip package (gtfs-realtime-bindings) would
# be the only dependency this script has besides the standard library, so the few fields we need are read here.


def _varint(buf, i):
    value = shift = 0
    while True:
        if i >= len(buf):
            raise ValueError("truncated varint")
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7


def _fields(buf):
    """(field number, wire type, value) for every field of a message: varints as ints, 64/32-bit as raw bytes,
    length-delimited as bytes (a nested message, or a string)."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 1:
            value, i = buf[i:i + 8], i + 8
        elif wire == 2:
            length, i = _varint(buf, i)
            value, i = buf[i:i + length], i + length
        elif wire == 5:
            value, i = buf[i:i + 4], i + 4
        else:
            raise ValueError(f"wire type {wire}")
        yield field, wire, value


def _msg(buf):
    return {field: value for field, _wire, value in _fields(buf)}


def _text(buf):
    return buf.decode("utf-8", "replace")


def _double(field, wire, value):
    # Position.latitude is a double in the spec and a float here: ZET's feed sends fixed32, so both are read.
    if wire == 1:
        return struct.unpack("<d", value)[0]
    if wire == 5:
        return struct.unpack("<f", value)[0]
    return None


# ---- EPSG:4326 to EPSG:3765 (HTRS96 / Croatia TM), engine local metres
# pyproj is what the pipeline projects with, so it is used when it can be imported (uv run python scripts/serve.py);
# a plain python3 has no pyproj, and then the same projection is computed here: GRS80, one transverse Mercator with
# its central meridian at 16.5 E. Checked against pyproj over the city: 0.3 mm at the corners.
_A, _F = 6378137.0, 1 / 298.257222101


def _tm(lat, lon, lon0=16.5, k0=0.9999, fe=500000.0, fn=0.0):
    f = _F
    e2 = 2 * f - f * f
    ep2 = e2 / (1 - e2)
    e4, e6 = e2 * e2, e2 * e2 * e2
    phi = math.radians(lat)
    lam = math.radians(lon) - math.radians(lon0)
    sp, cp, tp = math.sin(phi), math.cos(phi), math.tan(phi)
    n = _A / math.sqrt(1 - e2 * sp * sp)
    t, c, al = tp * tp, ep2 * cp * cp, lam * cp
    m = _A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
              - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
              + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
              - (35 * e6 / 3072) * math.sin(6 * phi))
    east = fe + k0 * n * (al + (1 - t + c) * al ** 3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * ep2) * al ** 5 / 120)
    north = fn + k0 * (m + n * tp * (al * al / 2 + (5 - t + 9 * c + 4 * c * c) * al ** 4 / 24
                                     + (61 - 58 * t + t * t + 600 * c - 330 * ep2) * al ** 6 / 720))
    return east, north


try:
    from pyproj import Transformer
    _transformer = Transformer.from_crs(4326, 3765, always_xy=True)

    def to_engine(lat, lon):
        east, north = _transformer.transform(lon, lat)
        return east - ORIGIN[0], -(north - ORIGIN[1])
except Exception:                                    # no pyproj: the same projection, written out
    def to_engine(lat, lon):
        east, north = _tm(lat, lon)
        return east - ORIGIN[0], -(north - ORIGIN[1])


# ---- the trip ids the schedule has, so a live vehicle can be marked as a tram
_schedule = {"version": None, "trips": frozenset()}


def _trip_ids():
    """The trip ids in web/data/<current version>/trams.json, reloaded when the version changes: a vehicle whose
    trip is not one of them is a bus on another ZET line and the map does not draw it."""
    try:
        version = json.loads((WEB / "data" / "current.json").read_text(encoding="utf-8"))["version"]
    except Exception:
        return frozenset()
    if _schedule["version"] != version:
        try:
            trams = json.loads((WEB / "data" / version / "trams.json").read_text(encoding="utf-8"))
            _schedule["trips"] = frozenset(trams.get("trip_ids") or ())
        except Exception:
            _schedule["trips"] = frozenset()
        _schedule["version"] = version
    return _schedule["trips"]


def read_feed(buf):
    """{"header": ts, "vehicles": [...]} from a FeedMessage: header=1, entity=2; entity's vehicle=4; in the
    VehiclePosition trip=1, position=2, timestamp=5, vehicle=8 (the id); in the Position latitude=1, longitude=2,
    bearing=3, speed=4."""
    header, vehicles = 0, []
    for field, _wire, value in _fields(buf):
        if field == 1:
            header = _msg(value).get(3, 0)
        elif field == 2:
            entity = _msg(value)
            if 4 not in entity:
                continue                     # an alert, a trip update
            veh = _msg(entity[4])
            trip = _msg(veh[1]) if 1 in veh else {}
            if 2 not in veh:
                continue
            pos = {(f, w): v for f, w, v in _fields(veh[2])}
            lat = next((_double(f, w, v) for (f, w), v in pos.items() if f == 1), None)
            lon = next((_double(f, w, v) for (f, w), v in pos.items() if f == 2), None)
            if lat is None or lon is None:
                continue                     # a vehicle with no position yet
            bearing = next((_double(f, w, v) for (f, w), v in pos.items() if f == 3), None)
            speed = next((_double(f, w, v) for (f, w), v in pos.items() if f == 4), None)
            desc = _msg(veh[8]) if 8 in veh else {}
            vehicles.append({
                "id": _text(desc[1]) if 1 in desc else _text(entity.get(1, b"")),
                "trip": _text(trip[1]) if 1 in trip else "",
                "route": _text(trip[5]) if 5 in trip else "",
                "lat": lat, "lon": lon,
                # ZET's feed sends neither a bearing nor a speed: null, and the map takes the direction from the
                # shape the trip drives.
                "bearing": bearing,
                "speed": speed,
                "ts": veh.get(5, header),
            })
    known = _trip_ids()
    for v in vehicles:
        east, north = to_engine(v["lat"], v["lon"])
        v["x"], v["z"] = round(east, 1), round(north, 1)
        v["kind"] = "tram" if v["trip"] in known else "bus"
    return {"ts": header, "vehicles": vehicles}


_cache = {"at": 0.0, "body": None}


def feed_json():
    """The feed as JSON, cached for RT_CACHE_S; a stale copy still served beats an empty map when zet.hr hiccups."""
    now = time.time()
    if _cache["body"] is not None and now - _cache["at"] < RT_CACHE_S:
        return _cache["body"]
    try:
        req = urllib.request.Request(RT_URL, headers={"User-Agent": "zagreb-by-building dev server"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.dumps(read_feed(resp.read()), ensure_ascii=False).encode("utf-8")
        _cache.update(at=now, body=body)
        return body
    except Exception as exc:
        if _cache["body"] is not None:
            return _cache["body"]
        raise RuntimeError(f"zet.hr did not answer: {exc}") from exc


class NoStore(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/rt":
            return self.send_rt()
        super().do_GET()

    def send_rt(self):
        try:
            body = feed_json()
            self.send_response(200)
        except Exception as exc:
            body = json.dumps({"error": str(exc), "ts": 0, "vehicles": []}).encode("utf-8")
            self.send_response(503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    # The page asks for about 15 modules at once. With socketserver's default listen backlog of 5, macOS resets the
    # connections beyond it ("Connection reset by peer"), and the page can hang at "Building the city 0%".
    request_queue_size = 128


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("port", nargs="?", type=int, default=8642)
    ap.add_argument("--bind", default="127.0.0.1")
    a = ap.parse_args(argv)
    handler = functools.partial(NoStore, directory=str(WEB))
    with Server((a.bind, a.port), handler) as httpd:
        print(f"serving {WEB} on http://{a.bind}:{a.port}/ (no-store), live trams on /rt", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
