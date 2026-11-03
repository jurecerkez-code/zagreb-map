"""Write ZET's live positions as the JSON the map reads, for the scheduled snapshot on a static host.

Reuses scripts/serve.py: the protobuf parse, the projection to engine metres and the trip filter all live there, so
the snapshot and the dev server's /rt cannot drift apart. Needs web/data/current.json and its trams.json present, the
same files the dev server reads, because a vehicle is only a tram if its trip is in the timetable.

    python3 scripts/rt_snapshot.py rt.json
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import serve  # noqa: E402

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "rt.json")
body = serve.feed_json()
out.write_bytes(body)
feed = json.loads(body)
trams = sum(1 for v in feed.get("vehicles", []) if v.get("kind") == "tram")
print(f"{out}: {len(feed.get('vehicles', []))} vehicles, {trams} trams, ts {feed.get('ts')}")
