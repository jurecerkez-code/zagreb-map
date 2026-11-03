"""The sightseeing walk: ten stops through the centre, in the order a visitor would take them.

    python scripts/build_tour.py

Nothing here is invented. Every stop is one of the map's own history facts (data/facts.json: its place, its year, its
text, its photo and its sources), picked by id in a walking order that goes up the hill and back down to the theatre.
A leg's length is the straight line between two stops times 1.25 (the detour a street grid adds) and its time is at
80 m a minute, the pace walk.js already uses; both are labelled as estimates wherever they are shown.
"""
import json
import math
import os

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
DATA = os.path.join(WEB, "data")

# The walk, in order: up from the square, over Gradec, down through Dolac and Kaptol, then south to the theatre.
WALK = [
    ("mandusevac-legenda", "Start on the square: the well that gave the city its name"),
    ("uspinjaca-1890", "The funicular, the shortest public railway in the world"),
    ("gricki-top-1877", "Lotrščak tower and the cannon that marks noon"),
    ("zidine-1266", "The Stone Gate, the only gate of Gradec left standing"),
    ("gradec-1242", "St Mark's square: the free royal town and its charter"),
    ("tunel-gric-1943", "The tunnel dug under Gradec in the war"),
    ("dolac-1930", "Dolac, the market above the old walls"),
    ("potres-1880", "The cathedral, and the earthquake that rebuilt it"),
    ("kaptol-1094", "Kaptol, where the diocese and the name begin"),
    ("hnk-1895", "End at the theatre on the Green Horseshoe"),
]

METRES_PER_MIN = 80.0
DETOUR = 1.25


def main():
    facts = json.load(open(os.path.join(DATA, "facts.json"), encoding="utf-8"))
    by_id = {f["id"]: f for f in facts}
    stops, total = [], 0.0
    for n, (fid, why_hr) in enumerate(WALK, 1):
        f = by_id.get(fid)
        if f is None:
            raise SystemExit(f"no such fact: {fid}")
        stops.append({"n": n, "fact": fid, "x": f["x"], "z": f["z"], "why_hr": why_hr})
    for a, b in zip(stops, stops[1:]):
        d = math.dist((a["x"], a["z"]), (b["x"], b["z"])) * DETOUR
        a["leg_m"] = int(round(d, -1))
        a["leg_min"] = max(1, int(round(d / METRES_PER_MIN)))
        total += d
    tour = {
        "title": {"en": "A walk through the centre", "hr": "Šetnja kroz centar"},
        "lede": {"en": "Ten stops, about {km} km and {min} minutes on foot. The times between two stops are estimates.",
                 "hr": "Deset postaja, oko {km} km i {min} minuta hoda. Vremena između dvije postaje su procjena."},
        "km": round(total / 1000, 1),
        "min": int(round(total / METRES_PER_MIN)),
        "stops": stops,
    }
    out = os.path.join(DATA, "tour.json")
    json.dump(tour, open(out, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)
    print(f"tour: {len(stops)} stops, {tour['km']} km, {tour['min']} min -> {out}")
    for s in stops[:-1]:
        print(f"  {s['n']:>2}. {s['fact']:<20} -> next {s['leg_m']:>4} m, {s['leg_min']} min")


if __name__ == "__main__":
    main()
