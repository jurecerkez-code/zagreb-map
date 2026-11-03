"""Photos for the history stories: one licensed Wikimedia Commons photograph per beat, downloaded into web/scenes/img/
and written into the scene files as the player's `photo` (web/scene-player.js already draws it, credit and all).

    python scripts/scenes_photos.py [--check]

Rules, the same as the monuments': only a free licence (CC0, public domain, CC BY, CC BY-SA), and the author, the
licence and the Commons page recorded with the image. No image is placed on a beat whose topic it does not show: the
list below is curated by hand, one file per beat, and the script refuses a file whose licence it cannot name.
"""
import argparse
import json
import os
import re
import time
import urllib.parse
import urllib.request

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
SCENES = os.path.join(WEB, "scenes")
IMG = os.path.join(SCENES, "img")
API = "https://commons.wikimedia.org/w/api.php"
UA = {"User-Agent": "zagreb-by-building/1.0 (non-commercial open map of Zagreb; https://github.com/jurecerkez-code; credits every photographer)", "Accept": "application/json"}

# scene -> beat number -> Commons file title (exact, as Commons has it) and the caption the card shows.
PLAN = {
    "two-hills": {
        1: ("Puerta de Piedra, Zagreb, Croacia, 2014-04-20, DD 02.JPG", {"en": "The Stone Gate, the only gate of Gradec still standing",
                                           "sv": "Kamenita vrata, jedina sačuvana vrata Gradeca"}),
        3: ("Crkva sv. Marka Zagreb.jpg", {"en": "St Mark's Church on Gradec's square",
                                             "sv": "Crkva sv. Marka na Gradečevu trgu"}),
    },
    "earthquake-1880": {
        1: ("67c potres 1880 katedrala BDM Zagreb.jpg", {"en": "Damage after the earthquake of 9 November 1880",
                                          "sv": "Šteta nakon potresa 9. studenoga 1880."}),
    },
    "green-horseshoe": {
        1: ("Zrinjevac Park, Zagreb, Croatia - July 2022.jpg", {"en": "Zrinjevac, the first square of Lenuci's horseshoe",
                                      "sv": "Zrinjevac, prvi trg Lenucijeve potkove"}),
    },
    "interwar-estates": {
        1: ("Zagreb - Trg kralja Tomislava (4).jpg", {"en": "Trg kralja Tomislava in the interwar years",
                                                  "sv": "Trg kralja Tomislava u međuratnim godinama"}),
    },
    "across-the-sava": {
        1: ("Novi Zagreb zapad.jpg", {"en": "Novi Zagreb south of the Sava",
                                          "sv": "Novi Zagreb južno od Save"}),
    },
}

OK_LICENCE = re.compile(r"^(cc0|public domain|cc by|cc-by|pd)", re.I)


def api(params, tries=5):
    """One call, slowly: Commons throttles a burst of requests from one address with a 429, so each call waits a
    couple of seconds and a 429 is retried with a growing pause rather than failing the run."""
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": 2})
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                time.sleep(2.0)
                return json.load(r)
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == tries - 1:
                raise
            wait = 20 * (attempt + 1)
            print(f"   429, waiting {wait}s")
            time.sleep(wait)


def search(term, limit=8):
    """Candidate files for a term, best first (Commons' own relevance)."""
    j = api({"action": "query", "list": "search", "srsearch": term + " filetype:bitmap", "srnamespace": 6,
             "srlimit": limit})
    return [h["title"] for h in j.get("query", {}).get("search", [])]


def info(title):
    if not title.startswith("File:"):                  # the API wants the namespace, the plan writes plain names
        title = "File:" + title
    j = api({"action": "query", "titles": title, "prop": "imageinfo",
             "iiprop": "url|size|extmetadata", "iiurlwidth": 1200})
    pages = j.get("query", {}).get("pages", [])
    if not pages or "imageinfo" not in pages[0]:
        return None
    ii = pages[0]["imageinfo"][0]
    md = ii.get("extmetadata", {})
    def get(key):
        return (md.get(key, {}) or {}).get("value", "")
    return {"title": pages[0]["title"], "thumb": ii.get("thumburl") or ii["url"], "w": ii.get("thumbwidth", ii["width"]),
            "h": ii.get("thumbheight", ii["height"]), "page": ii["descriptionurl"],
            "author": re.sub(r"<[^>]+>", "", get("Artist")).strip() or "unknown",
            "licence": re.sub(r"<[^>]+>", "", get("LicenseShortName")).strip()}


def clean(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html or "")).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report what would be used, download nothing")
    args = ap.parse_args()
    os.makedirs(IMG, exist_ok=True)
    report = []
    for scene, beats in PLAN.items():
        path = os.path.join(SCENES, f"{scene}.json")
        if not os.path.exists(path):
            print(f"{scene}: no such scene file")
            continue
        data = json.load(open(path, encoding="utf-8"))
        by_n = {b["n"]: b for b in data["beats"]}
        for n, (title, caption) in beats.items():
            beat = by_n.get(n)
            if beat is None:
                print(f"{scene} beat {n}: no such beat")
                continue
            meta = info(title)
            if meta is None:
                print(f"{scene} beat {n}: '{title}' not found; searching")
                hits = search(title.rsplit(".", 1)[0].replace("_", " "))
                print(f"   candidates: {hits[:3]}")
                continue
            if not OK_LICENCE.match(meta["licence"] or ""):
                print(f"{scene} beat {n}: refused, licence is '{meta['licence']}'")
                continue
            name = f"{scene}-{n}.jpg"
            dest = os.path.join(IMG, name)
            report.append({"scene": scene, "beat": n, "file": meta["title"], "licence": meta["licence"],
                           "author": meta["author"], "page": meta["page"]})
            print(f"{scene} beat {n}: {meta['title']} ({meta['licence']}, {meta['author']})")
            if args.check:
                continue
            if not os.path.exists(dest):
                req = urllib.request.Request(meta["thumb"], headers=UA)
                with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                    f.write(r.read())
                time.sleep(1)
            beat["photo"] = {"src": f"img/{name}", "width": meta["w"], "height": meta["h"],
                             "caption": caption, "credit": {"author": meta["author"], "licence": meta["licence"],
                                                            "page": meta["page"]}}
        if not args.check:
            json.dump(data, open(path, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)
    if not args.check:
        json.dump(report, open(os.path.join(SCENES, "photos-report.json"), "w", encoding="utf-8", newline="\n"),
                  ensure_ascii=False, indent=1)
    print(f"\n{len(report)} photos, written into {len(PLAN)} scenes")


if __name__ == "__main__":
    main()
