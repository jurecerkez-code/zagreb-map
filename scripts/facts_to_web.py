"""Turn data/facts/zagreb_facts.json into the map's own facts layer: web/data/facts.json with local coordinates
(local x/z of city.py's EPSG:3765 origin) and the licensed photos copied next to it under web/data/facts/.

The facts themselves are untouched: same titles, same texts, same source URLs, same photo credits. Only the geometry
is added, so the map can place a marker at the place the fact is about.
"""
import json
import os
import re
import time
import urllib.request

from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "..", "data", "facts", "zagreb_facts.json")
OUT = os.path.join(ROOT, "web", "data", "facts.json")
PHOTOS = os.path.join(ROOT, "web", "data", "facts")

# pipeline/city.py: ORIGIN = (459370.1, 5074937.5) in EPSG:3765; local x = e - Ox, z = -(n - Oy)
OE, ON = 459370.1, 5074937.5
UA = {"User-Agent": "zagreb-by-building/1.0 (research, non-commercial open map of Zagreb; credits every source)"}


def main():
    facts = json.load(open(SRC, encoding="utf-8"))
    tr = Transformer.from_crs(4326, 3765, always_xy=True)
    os.makedirs(PHOTOS, exist_ok=True)
    rows, downloaded = [], 0
    for f in facts:
        place = f.get("place") or {}
        if not place.get("lat"):
            continue
        e, n = tr.transform(place["lon"], place["lat"])
        row = {
            "id": f["id"], "year": int(f["year"]),
            "x": round(e - OE, 1), "z": round(-(n - ON), 1),
            "title_hr": f["title_hr"], "title_en": f["title_en"],
            "text_hr": f["text_hr"], "text_en": f["text_en"],
            "place_hr": place.get("label_hr") or "", "kind": f.get("kind") or "event",
            "sources": [{"url": u} for u in f.get("source_urls", [])],
        }
        photo = f.get("photo")
        if photo and photo.get("url"):
            name = re.sub(r"[^a-z0-9-]+", "-", f["id"].lower()) + ".jpg"
            dest = os.path.join(PHOTOS, name)
            if os.path.exists(dest) and os.path.getsize(dest) == 0:
                os.remove(dest)                                # an empty file is a failed attempt, not a photo
            if not os.path.exists(dest):
                for attempt in range(3):                       # Commons answers 429 when asked too fast
                    try:
                        req = urllib.request.Request(photo["url"], headers=UA)
                        body = urllib.request.urlopen(req, timeout=60).read()
                        if body[:2] != b"\xff\xd8":               # only a JPEG is a photo
                            raise ValueError("not a JPEG")
                        open(dest, "wb").write(body)
                        downloaded += 1
                        break
                    except Exception as exc:                   # a missing photo never blocks the fact
                        if attempt == 2:
                            print("photo failed:", f["id"], exc)
                        else:
                            time.sleep(20 * (attempt + 1))
            if os.path.exists(dest) and os.path.getsize(dest) > 5000:
                row["photo"] = {"url": "data/facts/" + name, "author": photo.get("author", ""),
                                "licence": photo.get("licence", ""), "licence_url": photo.get("licence_url", ""),
                                "page": photo.get("page", "")}
        rows.append(row)
    rows.sort(key=lambda r: r["year"])
    json.dump(rows, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"facts {len(rows)}, photos {sum(1 for r in rows if r.get('photo'))} ({downloaded} new), "
          f"years {rows[0]['year']} to {rows[-1]['year']} -> web/data/facts.json")


if __name__ == "__main__":
    main()
