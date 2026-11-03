"""The Zagreb funicular, from OpenStreetMap: two tracks, sampled on the terrain, and the two cabins at their ends.

    python scripts/build_funicular.py

The city model has no funicular (ZG3D carries buildings, not railways), so the shortest public railway in the world was
invisible on a map that names it. Its two tracks are mapped (`railway=funicular`, 59 m between Tomiceva and the
Strossmayer promenade); this bakes them into data/funicular.json in the map's own local metres, on the terrain's height,
with one cabin at each end. Nothing is invented: the tracks are the mapped ones and the cabins sit where the cars stand.
"""
import json
import os

import numpy as np
import pyogrio
import shapely

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
PBF = os.path.join(os.path.dirname(os.path.dirname(WEB)), "data", "raw", "osm", "croatia-latest.osm.pbf")
ORIGIN = (459370.1, 5074937.5)          # pipeline/city.py, EPSG:3765; local x = e - Ox, z = -(n - Oy)
STEP_M = 1.5


def terrain():
    data = os.path.join(os.path.dirname(WEB), "data")
    t = json.loads(open(os.path.join(data, "terrain.json")).read())
    h = np.load(os.path.join(data, "terrain.npz"))["h"].astype(float)

    def at(x, z):
        i = np.clip((x - t["x0"]) / t["cell"], 0, t["nx"] - 1.001)
        j = np.clip((z - t["z0"]) / t["cell"], 0, t["nz"] - 1.001)
        i0, j0 = int(i), int(j)
        fi, fj = i - i0, j - j0
        return float((h[j0, i0] * (1 - fi) + h[j0, i0 + 1] * fi) * (1 - fj)
                     + (h[j0 + 1, i0] * (1 - fi) + h[j0 + 1, i0 + 1] * fi) * fj)
    return at


def main():
    lines = pyogrio.read_dataframe(PBF, layer="lines", bbox=(15.96, 45.80, 15.99, 45.83)).to_crs(3765)
    funi = lines[lines["railway"] == "funicular"]
    if not len(funi):
        raise SystemExit("no railway=funicular in the extract")
    at = terrain()
    tracks = []
    for geom in funi.geometry:
        loc = shapely.transform(geom, lambda c: np.c_[c[:, 0] - ORIGIN[0], -(c[:, 1] - ORIGIN[1])])
        n = max(2, int(loc.length / STEP_M))
        pts = []
        for d in [loc.length * i / (n - 1) for i in range(n)]:
            p = loc.interpolate(d)
            pts.append([round(p.x, 2), round(at(p.x, p.y) + 0.35, 2), round(p.y, 2)])
        tracks.append(pts)
    # one car at each end of the tracks: the lower at the bottom station, the upper at the top
    ends = [t[0] for t in tracks] + [t[-1] for t in tracks]
    low = min(ends, key=lambda p: p[1])
    high = max(ends, key=lambda p: p[1])
    out = {
        "name": "Uspinjača (OpenStreetMap railway=funicular)",
        "tracks": tracks,
        "cabins": [low, high],
        "length_m": round(float(funi.geometry.length.max()), 1),
        "source": "OpenStreetMap, (c) OpenStreetMap contributors, ODbL; heights from the map's terrain model",
    }
    path = os.path.join(WEB, "data", "funicular.json")
    json.dump(out, open(path, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)
    print(f"funicular: {len(tracks)} tracks, {out['length_m']} m, {sum(len(t) for t in tracks)} points -> {path}")


if __name__ == "__main__":
    main()
