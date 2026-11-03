"""Zagreb port: Wikidata items that date a building in Zagreb, once, outside the pipeline's steps.

    uv run python -m pipeline.zagreb_wikidata

Two SPARQL queries (query.wikidata.org, with a User-Agent):
  1. items located in Grad Zagreb (P131* wd:Q1435), or within 25 km of Trg bana Jelačića, with coordinates (P625) and
     an inception (P571), service entry (P729) or opening (P1619), each with its date precision; label hr/en, image
     (P18), architects (P84), heritage designation (P1435), the hr/en Wikipedia article, instance-of (P31) classes;
  2. which of those P31 classes are architectural structures (P279* wd:Q811979), so a company, a club or a street
     founded in some year never dates a building.
Writes ../data/raw/wikidata/zg_wikidata_raw.json (both answers) and zg_wikidata.parquet: one row per item and date
property, keeping only items whose class is an architectural structure. precision 9+ = year, 8 = decade (a span),
anything coarser is dropped.
"""
import json
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "raw" / "wikidata"
URL = "https://query.wikidata.org/sparql"
UA = {"User-Agent": "zagreb-by-building/0.1 (https://github.com/amirelion/husforhus port; jure)",
      "Accept": "application/sparql-results+json"}

Q_IDS = """
SELECT DISTINCT ?item WHERE {
  %s
  FILTER EXISTS { ?item wdt:P571|wdt:P729|wdt:P1619 [] }
}
"""
WHERE_ADMIN = "?item wdt:P131* wd:Q1435 ; wdt:P625 [] ."
WHERE_AROUND = ('SERVICE wikibase:around { ?item wdt:P625 ?c . bd:serviceParam wikibase:center '
                '"Point(15.9772 45.8131)"^^geo:wktLiteral . bd:serviceParam wikibase:radius "25" . }')

Q_ITEMS = """
SELECT ?item ?coord ?prop ?t ?prec ?lhr ?len ?img
  (GROUP_CONCAT(DISTINCT ?archL; separator="|") AS ?arch)
  (GROUP_CONCAT(DISTINCT ?herL; separator="|") AS ?her)
  (GROUP_CONCAT(DISTINCT STRAFTER(STR(?cls), "entity/"); separator="|") AS ?classes)
  (SAMPLE(?hrw) AS ?hrwiki) (SAMPLE(?enw) AS ?enwiki)
WHERE {
  VALUES ?item { %s }
  ?item wdt:P625 ?coord .
  VALUES (?prop ?p ?psv) { ("P571" p:P571 psv:P571) ("P729" p:P729 psv:P729) ("P1619" p:P1619 psv:P1619) }
  ?item ?p ?st . ?st ?psv ?v . ?v wikibase:timeValue ?t ; wikibase:timePrecision ?prec .
  OPTIONAL { ?item wdt:P31 ?cls }
  OPTIONAL { ?item rdfs:label ?lhr FILTER(LANG(?lhr) = "hr") }
  OPTIONAL { ?item rdfs:label ?len FILTER(LANG(?len) = "en") }
  OPTIONAL { ?item wdt:P18 ?img }
  OPTIONAL { ?item wdt:P84 ?a . ?a rdfs:label ?archL FILTER(LANG(?archL) = "hr") }
  OPTIONAL { ?item wdt:P1435 ?h . ?h rdfs:label ?herL FILTER(LANG(?herL) = "en") }
  OPTIONAL { ?hrw schema:about ?item ; schema:isPartOf <https://hr.wikipedia.org/> }
  OPTIONAL { ?enw schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}
GROUP BY ?item ?coord ?prop ?t ?prec ?lhr ?len ?img
"""

Q_CLASSES = """
SELECT DISTINCT ?c WHERE { VALUES ?c { %s } ?c wdt:P279* wd:Q811979 . }
"""


def sparql(q: str) -> list[dict]:
    for attempt in range(4):
        r = requests.post(URL, data={"query": q}, headers=UA, timeout=300)
        if r.status_code == 200:
            return r.json()["results"]["bindings"]
        print(f"HTTP {r.status_code}: {r.text[:200]}")
        time.sleep(10 * (attempt + 1))
    raise SystemExit("Wikidata SPARQL failed")


def v(row, k):
    return row[k]["value"] if k in row else None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ids = set()
    for where in (WHERE_ADMIN, WHERE_AROUND):
        got = {v(r, "item").rsplit("/", 1)[1] for r in sparql(Q_IDS % where)}
        print(f"{len(got)} dated items from {where[:30]}")
        ids |= got
    ids = sorted(ids)
    rows = []
    for i in range(0, len(ids), 150):
        rows += sparql(Q_ITEMS % " ".join(f"wd:{q}" for q in ids[i:i + 150]))
    classes = sorted({c for r in rows for c in (v(r, "classes") or "").split("|") if c})
    structural = set()
    for i in range(0, len(classes), 300):
        chunk = " ".join(f"wd:{c}" for c in classes[i:i + 300])
        structural |= {v(r, "c").rsplit("/", 1)[1] for r in sparql(Q_CLASSES % chunk)}
    (OUT / "zg_wikidata_raw.json").write_text(json.dumps({"items": rows, "structural_classes": sorted(structural)},
                                                         ensure_ascii=False), encoding="utf-8")
    out = []
    for r in rows:
        lon, lat = (v(r, "coord") or "Point( )").removeprefix("Point(").rstrip(")").split(" ")[:2]
        t, prec = v(r, "t") or "", int(v(r, "prec") or 0)
        try:
            year = int(t[:5].lstrip("+")) if t[0] in "+-" else int(t[:4])
        except ValueError:
            continue
        cls = [c for c in (v(r, "classes") or "").split("|") if c]
        out.append({"qid": v(r, "item").rsplit("/", 1)[1], "lon": float(lon), "lat": float(lat),
                    "prop": v(r, "prop"), "year": year, "prec": prec, "label_hr": v(r, "lhr"),
                    "label_en": v(r, "len"), "image": v(r, "img"), "architects": v(r, "arch") or "",
                    "heritage": v(r, "her") or "", "classes": "|".join(cls),
                    "structure": any(c in structural for c in cls),
                    "hrwiki": v(r, "hrwiki"), "enwiki": v(r, "enwiki")})
    df = pd.DataFrame(out)
    df.to_parquet(OUT / "zg_wikidata.parquet", index=False)
    print(f"{len(rows)} rows, {df.qid.nunique()} items with a date; {df[df.structure].qid.nunique()} of them "
          f"architectural structures; by precision {df[df.structure].prec.value_counts().to_dict()}")


if __name__ == "__main__":
    main()
