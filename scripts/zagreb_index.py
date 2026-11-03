"""A SQLite index of every Zagreb building and of the evidence behind its year.

The engine's data is parquet plus a version folder, which is right for the build and wrong for
looking things up: you cannot ask it "which houses in Donji grad are still unknown", "where did
the 1,218 KD years come from", or "what did I add by hand last week" without writing pandas code.

This script writes one file, <project>/data/zagreb_index.sqlite, and keeps it current:

  buildings      one row per building: address, district, WGS84 centroid, height, area, year,
                 the source code, the flag (exact / range / long / area / period / unknown)
  sources        every year source with its licence, credit and URL
  year_evidence  append-only log of every year you add or correct by hand, keyed by uuid
  year_conflicts the 131 disagreements already recorded by the pipeline
  monuments      the 421 monuments with their years and photos
  facts          the 24 sourced history facts
  views          v_coverage, v_coverage_by_source, v_coverage_by_district, v_coverage_by_period,
                 v_unknown, v_dated, v_year_by_decade, v_evidence_progress

Usage (from engine/):
  uv run python scripts/zagreb_index.py build
  uv run python scripts/zagreb_index.py coverage
  uv run python scripts/zagreb_index.py find "Ilica 12"
  uv run python scripts/zagreb_index.py add-year --address "Ilica 12" --year 1898 \
      --precision exact --source "City heritage register KD" --note "datacija 1898" --url https://...
  uv run python scripts/zagreb_index.py export

Rules the script keeps:
  - gids are NOT stable (s01 renumbers them), so every hand entry is keyed by uuid.
  - build never deletes year_evidence; it re-applies every accepted row on top of the parquet.
  - a hand year never overwrites a curated landmark year; the script refuses and says why.
"""
import argparse
import csv
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ENGINE = Path(__file__).resolve().parents[1]
PROJECT = ENGINE.parent
DATA = ENGINE / "data"
DB = PROJECT / "data" / "zagreb_index.sqlite"

# ysrc codes, mirrored from pipeline/codes.py
SRC = {
    0: ("none", "unknown", "none", None, None, None),
    1: ("curated", "curated landmark kit", "record", None, "data/landmarks (hand-checked, per-landmark licence on the card)", None),
    2: ("raa", "Riksantikvarieambetet register (Stockholm)", "record", None, None, None),
    3: ("raa_area", "Riksantikvarieambetet area", "area", None, None, None),
    4: ("wikidata", "Wikidata", "record", "CC0-1.0", "Wikidata (CC0)", "https://www.wikidata.org/"),
    5: ("estimate", "neighbour estimate (cross-validated)", "estimate", None, "derived, not a source", None),
    6: ("raa_old", "Riksantikvarieambetet old", "record", None, None, None),
    7: ("osm", "OpenStreetMap start_date", "record", "ODbL-1.0", "© OpenStreetMap contributors, ODbL", "https://www.openstreetmap.org/copyright"),
    8: ("reader", "a reader's report", "reader", "CC-BY-4.0", "a reader's report", None),
    9: ("zbsm", "Zagreb Building Stock Model", "record", "CC-BY-SA-4.0", "Zagreb Building Stock Model (Gojak, Humski 2024), CC BY-SA 4.0", "https://doi.org/10.5281/zenodo.13602015"),
    10: ("kd", "KD + RKD heritage register", "record", "LicenseRef-OD-HR", "Registar kulturnih dobara RH, Ministarstvo kulture i medija, Otvorena dozvola", "https://www.min-kulture.hr/"),
    11: ("zg_her", "City heritage layer, protected building", "record", "LicenseRef-Permission", "Grad Zagreb, used with permission (email 21.10.2026)", "https://data.zagreb.hr/"),
    12: ("zg_facade", "City facade-renewal dating", "record", "LicenseRef-Permission", "Grad Zagreb, used with permission (email 21.10.2026)", "https://data.zagreb.hr/"),
    13: ("zg_area", "City heritage layer, dated ensemble", "area", "LicenseRef-Permission", "Grad Zagreb, used with permission (email 21.10.2026)", "https://data.zagreb.hr/"),
    14: ("zg_tipo", "City Tipologija working classes", "area", "LicenseRef-Permission", "radni materijal Grad Zagreb (not verified)", "https://data.zagreb.hr/"),
}
FLAG = {0: "exact", 1: "range", 2: "long", 3: "area", 4: "estimate", 6: "period", 7: "unknown"}
PRECISION_TO_FLAG = {"exact": 0, "range": 1, "long": 2, "area": 3, "period": 6}

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sources (
  code INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
  licence TEXT, credit TEXT, url TEXT);

CREATE TABLE IF NOT EXISTS buildings (
  gid INTEGER PRIMARY KEY, uuid TEXT, osm_id TEXT, district TEXT,
  street TEXT, house_number TEXT, address TEXT, address_count INTEGER,
  name TEXT, architects TEXT,
  lat REAL, lon REAL, x3765 REAL, y3765 REAL,
  height_m REAL, top_m REAL, footprint_m2 REAL, floors INTEGER,
  category TEXT, private INTEGER NOT NULL DEFAULT 0,
  year INTEGER, year_from INTEGER, year_to INTEGER,
  ysrc INTEGER REFERENCES sources(code), yflag INTEGER, year_known INTEGER,
  period TEXT, period_key TEXT, landmark TEXT, protected INTEGER NOT NULL DEFAULT 0,
  in_engine INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_buildings_uuid ON buildings(uuid);
CREATE INDEX IF NOT EXISTS idx_buildings_district ON buildings(district);
CREATE INDEX IF NOT EXISTS idx_buildings_yflag ON buildings(yflag);
CREATE INDEX IF NOT EXISTS idx_buildings_ysrc ON buildings(ysrc);
CREATE INDEX IF NOT EXISTS idx_buildings_year ON buildings(year);
CREATE INDEX IF NOT EXISTS idx_buildings_geo ON buildings(lat, lon);
CREATE INDEX IF NOT EXISTS idx_buildings_street ON buildings(street, house_number);

CREATE TABLE IF NOT EXISTS year_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL, gid_at_entry INTEGER,
  year INTEGER, year_from INTEGER, year_to INTEGER,
  precision TEXT NOT NULL CHECK (precision IN ('exact','range','long','area','period')),
  source TEXT NOT NULL, note TEXT, url TEXT,
  added_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','candidate','rejected')),
  replaces_record INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evidence_uuid ON year_evidence(uuid);
CREATE INDEX IF NOT EXISTS idx_evidence_status ON year_evidence(status);

CREATE TABLE IF NOT EXISTS year_conflicts (
  gid INTEGER, winner TEXT, winner_years TEXT, winner_ref TEXT,
  other TEXT, other_years TEXT, other_ref TEXT, uuid TEXT);

CREATE TABLE IF NOT EXISTS monuments (
  id TEXT PRIMARY KEY, osm_id TEXT, name TEXT, name_en TEXT, kind TEXT, material TEXT, author TEXT,
  year INTEGER, height_m REAL, x REAL, z REAL, lat REAL, lon REAL,
  photo_key TEXT, photo_author TEXT, photo_licence TEXT, photo_page TEXT, qid TEXT);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, year INTEGER, kind TEXT, title_en TEXT, title_hr TEXT,
  text_en TEXT, text_hr TEXT, place TEXT, x REAL, z REAL, lat REAL, lon REAL,
  photo_key TEXT, photo_author TEXT, photo_licence TEXT, photo_page TEXT, sources TEXT);

CREATE VIRTUAL TABLE IF NOT EXISTS buildings_fts USING fts5(
  address, name, district, content='buildings', content_rowid='gid');
"""

VIEWS = """
DROP VIEW IF EXISTS v_coverage;
CREATE VIEW v_coverage AS
SELECT COUNT(*) AS buildings,
       SUM(year_known) AS dated,
       COUNT(*) - SUM(year_known) AS unknown,
       ROUND(100.0 * SUM(year_known) / COUNT(*), 2) AS dated_pct
FROM buildings;

DROP VIEW IF EXISTS v_coverage_by_source;
CREATE VIEW v_coverage_by_source AS
SELECT COALESCE(s.label, '(' || b.ysrc || ')') AS source, s.kind,
       COUNT(*) AS buildings,
       ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM buildings), 2) AS pct_of_city,
       MIN(b.year) AS first_year, MAX(b.year) AS last_year
FROM buildings b LEFT JOIN sources s ON s.code = b.ysrc
GROUP BY b.ysrc ORDER BY buildings DESC;

DROP VIEW IF EXISTS v_coverage_by_flag;
CREATE VIEW v_coverage_by_flag AS
SELECT yflag, CASE yflag WHEN 0 THEN 'exact' WHEN 1 THEN 'range' WHEN 2 THEN 'open span'
        WHEN 3 THEN 'area' WHEN 4 THEN 'estimate' WHEN 6 THEN 'period only' ELSE 'unknown' END AS how_known,
       COUNT(*) AS buildings, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM buildings), 2) AS pct
FROM buildings GROUP BY yflag ORDER BY yflag;

DROP VIEW IF EXISTS v_coverage_by_period;
CREATE VIEW v_coverage_by_period AS
SELECT period, period_key, COUNT(*) AS buildings,
       ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM buildings), 2) AS pct
FROM buildings GROUP BY period, period_key ORDER BY MIN(CASE period_key
  WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 WHEN 'p4' THEN 4 WHEN 'p5' THEN 5
  WHEN 'p6' THEN 6 ELSE 9 END);

DROP VIEW IF EXISTS v_coverage_by_district;
CREATE VIEW v_coverage_by_district AS
SELECT district, COUNT(*) AS buildings, SUM(year_known) AS dated,
       COUNT(*) - SUM(year_known) AS unknown,
       ROUND(100.0 * SUM(year_known) / COUNT(*), 2) AS dated_pct
FROM buildings GROUP BY district ORDER BY dated_pct DESC, buildings DESC;

DROP VIEW IF EXISTS v_unknown;
CREATE VIEW v_unknown AS
SELECT gid, uuid, district, address, name, lat, lon, footprint_m2, height_m, floors, private
FROM buildings WHERE year_known = 0 AND in_engine = 1;

DROP VIEW IF EXISTS v_dated;
CREATE VIEW v_dated AS
SELECT gid, uuid, district, address, name, year, year_from, year_to, yflag, ysrc, period, lat, lon
FROM buildings WHERE year_known = 1 AND in_engine = 1;

DROP VIEW IF EXISTS v_year_by_decade;
CREATE VIEW v_year_by_decade AS
SELECT (year / 10) * 10 AS decade, COUNT(*) AS buildings
FROM buildings WHERE year > 0 GROUP BY decade ORDER BY decade;

DROP VIEW IF EXISTS v_evidence_progress;
CREATE VIEW v_evidence_progress AS
SELECT substr(added_at, 1, 10) AS day, status, COUNT(*) AS entries
FROM year_evidence GROUP BY day, status ORDER BY day DESC;
"""


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("PRAGMA foreign_keys=ON")
    return con


def periods() -> tuple[dict, dict]:
    sys.path.insert(0, str(ENGINE))
    from pipeline import city  # noqa: E402  (engine package is the source of the period table)

    return ({p[0]: (p[1], p[3], p[4]) for p in city.PERIODS}, {p[1]: p[0] for p in city.PERIODS})


def period_of(year: int, per: dict) -> tuple[str, str]:
    if not year:
        return (None, None)
    for key, (label, lo, hi) in per.items():
        if lo <= year <= hi:
            return (label, key)
    return (None, None)


def build(args) -> None:
    t0 = datetime.now()
    per, _ = periods()
    con = connect()
    con.executescript(SCHEMA)
    cur = con.cursor()

    for code, (key, label, kind, licence, credit, url) in SRC.items():
        cur.execute("INSERT INTO sources(code,key,label,kind,licence,credit,url) VALUES(?,?,?,?,?,?,?) "
                    "ON CONFLICT(code) DO UPDATE SET key=excluded.key, label=excluded.label, kind=excluded.kind, "
                    "licence=excluded.licence, credit=excluded.credit, url=excluded.url",
                    (code, key, label, kind, licence, credit, url))

    b = pd.read_parquet(DATA / "buildings.parquet", columns=["gid", "uuid", "osm_id", "height", "height_max",
                                                            "area", "kategori", "geometry"])
    attrs = pd.read_parquet(DATA / "attributes.parquet", columns=["gid", "floors", "name", "architects", "prot"])
    years = pd.read_parquet(DATA / "years.parquet")
    districts = pd.read_parquet(DATA / "districts.parquet")
    wiki = pd.read_parquet(DATA / "wiki.parquet", columns=["gid", "name"])

    addr = pd.read_parquet(DATA / "addresses.parquet", columns=["gid", "street", "number", "withheld"])
    addr["full"] = addr["street"].fillna("").str.strip() + " " + addr["number"].fillna("").astype(str).str.strip()
    addr = addr[addr["withheld"] != True]  # noqa: E712
    first = addr.drop_duplicates("gid").set_index("gid")
    counts = addr.groupby("gid").size()

    # WGS84 centroid from the HTRS96/TM geometry (EPSG:3765 -> 4326)
    import geopandas as gpd

    geoms = gpd.GeoDataFrame(b[["gid"]], geometry=gpd.GeoSeries.from_wkb(b.pop("geometry").values), crs=3765)
    cent = geoms.geometry.centroid
    wgs = gpd.GeoSeries(cent, crs=3765).to_crs(4326)
    b["x3765"] = cent.x.values
    b["y3765"] = cent.y.values
    b["lon"] = wgs.x.values
    b["lat"] = wgs.y.values

    df = b.merge(attrs, on="gid", how="left").merge(years, on="gid", how="left") \
          .merge(districts, on="gid", how="left").merge(wiki, on="gid", how="left", suffixes=("", "_wiki"))

    def join_list(v):
        if v is None:
            return None
        try:
            seq = list(v)
        except TypeError:
            return str(v)
        return "; ".join(str(x) for x in seq if str(x).strip()) or None

    rows = []
    for r in df.itertuples(index=False):
        label, pkey = period_of(int(r.year or 0), per)
        rows.append((
            int(r.gid), r.uuid, getattr(r, "osm_id", None), r.district,
            first["street"].get(r.gid), first["number"].get(r.gid), first["full"].get(r.gid),
            int(counts.get(r.gid, 0)), r.name if isinstance(r.name, str) else (r.name_wiki if isinstance(r.name_wiki, str) else None),
            join_list(getattr(r, "architects", None)),
            float(r.lat), float(r.lon), float(r.x3765), float(r.y3765),
            round(float(r.height or 0), 1), round(float(r.height_max or 0), 1), round(float(r.area or 0), 1),
            int(r.floors or 0), r.kategori, 1 if r.private else 0,
            int(r.year or 0), int(r.year_from or 0), int(r.year_to or 0),
            int(r.ysrc), int(r.yflag), 0 if int(r.yflag) == 7 else 1,
            label, pkey, (r.landmark if isinstance(r.landmark, str) and r.landmark else None),
            1 if ((r.prot or 0) or int(r.ysrc) in (10, 11, 12, 13)) else 0, 1,
        ))

    con.commit()
    cur.execute("DELETE FROM buildings")
    cur.executemany("INSERT OR REPLACE INTO buildings(gid,uuid,osm_id,district,street,house_number,address,"
                    "address_count,name,architects,lat,lon,x3765,y3765,height_m,top_m,footprint_m2,floors,"
                    "category,private,year,year_from,year_to,ysrc,yflag,year_known,period,period_key,landmark,"
                    "protected,in_engine) VALUES(" + ",".join("?" * 31) + ")", rows)
    con.commit()

    # re-apply every accepted hand entry (uuid is the stable key, gids are not)
    applied = apply_evidence(con, quiet=True)

    cur.execute("INSERT INTO buildings_fts(buildings_fts) VALUES('rebuild')")

    cur.execute("DELETE FROM year_conflicts")
    dis = DATA / "year_disagreements.csv"
    if dis.exists():
        by_uuid = dict(zip(df["gid"], df["uuid"]))
        with open(dis, newline="", encoding="utf-8") as fh:
            for d in csv.DictReader(fh):
                gid = int(d["gid"])
                cur.execute("INSERT INTO year_conflicts VALUES(?,?,?,?,?,?,?,?)",
                            (gid, d["winner"], d["winner_years"], d["winner_ref"], d["other"],
                             d["other_years"], d["other_ref"], by_uuid.get(gid)))

    cur.execute("DELETE FROM monuments")
    version = json.loads((ENGINE / "web/data/current.json").read_text(encoding="utf-8")).get("version")
    mon_path = ENGINE / "web/data" / str(version) / "monuments.json"
    if mon_path.exists():
        import geopandas as gpd
        from shapely.geometry import Point

        mon = json.loads(mon_path.read_text(encoding="utf-8"))
        items = mon.get("monuments", mon) if isinstance(mon, dict) else mon
        pts = gpd.GeoSeries([Point((m.get("x") or 0) + 459370.1, -(m.get("z") or 0) + 5074937.5) for m in items], crs=3765)
        wgs = pts.to_crs(4326)
        for i, m in enumerate(items):
            ph = m.get("photo") or {}
            cur.execute("INSERT INTO monuments(id,osm_id,name,name_en,kind,material,author,year,height_m,x,z,lat,lon,"
                        "photo_key,photo_author,photo_licence,photo_page,qid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (m.get("id") or i + 1, m.get("osm") or m.get("id"), m.get("name"), m.get("en"), m.get("kind"),
                         m.get("mat"), "; ".join(m.get("by") or []) or None, m.get("year"), m.get("h"),
                         m.get("x"), m.get("z"), round(wgs.y.iloc[i], 7), round(wgs.x.iloc[i], 7),
                         ph.get("key"), ph.get("by"), ph.get("lic"), ph.get("page"), m.get("qid")))

    cur.execute("DELETE FROM facts")
    fp = ENGINE / "web/data/facts.json"
    if fp.exists():
        import geopandas as gpd
        from shapely.geometry import Point

        facts = json.loads(fp.read_text(encoding="utf-8"))
        items = facts.get("facts", facts) if isinstance(facts, dict) else facts
        pts = gpd.GeoSeries([Point((f_.get("x") or 0) + 459370.1, -(f_.get("z") or 0) + 5074937.5) for f_ in items], crs=3765)
        wgs = pts.to_crs(4326)
        for i, f_ in enumerate(items):
            ph = f_.get("photo") or {}
            cur.execute("INSERT INTO facts(id,year,kind,title_en,title_hr,text_en,text_hr,place,x,z,lat,lon,"
                        "photo_key,photo_author,photo_licence,photo_page,sources) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (f_.get("id"), f_.get("year"), f_.get("kind"), f_.get("title_en"), f_.get("title_hr"),
                         f_.get("text_en"), f_.get("text_hr"), f_.get("place_hr"), f_.get("x"), f_.get("z"),
                         round(wgs.y.iloc[i], 7), round(wgs.x.iloc[i], 7),
                         ph.get("url"), ph.get("author"), ph.get("licence"), ph.get("page"),
                         "; ".join(s.get("url", "") for s in (f_.get("sources") or []))))

    con.executescript(VIEWS)

    cur.executemany("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [
        ("built_at", now()),
        ("engine_data", str(DATA)),
        ("buildings", str(len(rows))),
        ("evidence_applied", str(applied)),
        ("generator", "engine/scripts/zagreb_index.py"),
        ("build_seconds", f"{(datetime.now() - t0).total_seconds():.1f}"),
    ])
    con.commit()
    con.execute("VACUUM")
    con.close()
    print(f"built {DB} in {(datetime.now() - t0).total_seconds():.1f}s: "
          f"{len(rows)} buildings, {applied} hand entries re-applied")


def apply_evidence(con: sqlite3.Connection, quiet: bool = False) -> int:
    """Apply the newest accepted row per uuid on top of the parquet years."""
    per, _ = periods()
    rows = con.execute("""
        SELECT e.id, e.uuid, e.gid_at_entry, e.year, e.year_from, e.year_to, e.precision, e.source, e.note,
               e.replaces_record
        FROM year_evidence e
        JOIN (SELECT uuid, MAX(id) AS id FROM year_evidence WHERE status='accepted' GROUP BY uuid) last
          ON last.id = e.id
    """).fetchall()
    n = 0
    for _id, uuid, gid_at_entry, year, yfrom, yto, precision, source, note, replaces in rows:
        targets = con.execute("SELECT gid, ysrc, landmark FROM buildings WHERE uuid=?", (uuid,)).fetchall()
        if not targets:
            if not quiet:
                print(f"  skipped evidence #{_id}: uuid {uuid} is not in this build")
            continue
        flag = PRECISION_TO_FLAG[precision]
        final_year = year if year else (yfrom or 0)
        label, pkey = period_of(final_year, per)
        hit = 0
        for gid, ysrc, landmark in targets:
            kind = (con.execute("SELECT kind FROM sources WHERE code=?", (ysrc,)).fetchone() or ("none",))[0]
            if ysrc == 1:
                if not quiet:
                    print(f"  refused evidence #{_id}: gid {gid} has a curated landmark year (kept)")
                continue
            if kind == "record" and not replaces:
                if not quiet:
                    print(f"  refused evidence #{_id}: gid {gid} has a record year and the entry does not replace it")
                continue
            con.execute("UPDATE buildings SET year=?, year_from=?, year_to=?, ysrc=8, yflag=?, year_known=1, "
                        "period=?, period_key=? WHERE gid=?",
                        (year or final_year, yfrom or year or 0, yto or year or 0, flag, label, pkey, gid))
            hit += 1
        n += hit
        if hit > 1 and not quiet:
            print(f"  evidence #{_id} applied to {hit} buildings sharing uuid {uuid}")
    con.commit()
    return n


def add_year(args) -> None:
    con = connect()
    con.executescript(SCHEMA)
    if args.uuid:
        b = con.execute("SELECT gid, uuid, address, year, ysrc FROM buildings WHERE uuid=? "
                        "ORDER BY footprint_m2 DESC LIMIT 1", (args.uuid,)).fetchone()
    elif args.address:
        want = " ".join(args.address.lower().split())
        cand = con.execute("SELECT gid, uuid, address, year, ysrc, footprint_m2 FROM buildings "
                           "WHERE address IS NOT NULL AND lower(address) LIKE ?",
                           (f"%{want}%",)).fetchall()
        exact = [c for c in cand if " ".join(c[2].lower().split()) == want]
        pick = exact or sorted(cand, key=lambda c: -c[5])
        if not pick:
            sys.exit(f"no building at '{args.address}'")
        if len(pick) > 1 and not exact:
            print(f"'{args.address}' is not an exact address; {len(pick)} candidates contain it:")
            for c in pick[:10]:
                print(f"  gid {c[0]:>7}  {c[2]}")
            sys.exit("give an exact address or a --gid")
        if len(exact) > 1:
            print(f"{len(exact)} buildings still share '{args.address}'; pick one by --gid:")
            for c in exact:
                print(f"  gid {c[0]:>7}  {c[5]:.0f} m2  {c[3] or 'unknown'}")
            sys.exit(1)
        b = (pick[0][0], pick[0][1], pick[0][2], pick[0][3], pick[0][4])
    elif args.gid is not None:
        b = con.execute("SELECT gid, uuid, address, year, ysrc FROM buildings WHERE gid=?", (args.gid,)).fetchone()
    else:
        sys.exit("give one of --gid, --uuid or --address")
    if not b:
        sys.exit("no building matched")
    gid, uuid, address, year, ysrc = b
    kind, label = con.execute("SELECT kind, label FROM sources WHERE code=?", (ysrc,)).fetchone() or ("none", "?")
    if ysrc == 1:
        sys.exit(f"gid {gid} ({address}) has a curated landmark year; edit the landmark kit, not this table")
    if kind == "record" and not args.replace_record:
        sys.exit(f"gid {gid} ({address}) already has {year} from a record: {label}. "
                 f"Re-run with --replace-record and a note that says why it is better.")
    if args.year and (args.year < 1000 or args.year > datetime.now().year + 1):
        sys.exit(f"{args.year} is not a plausible construction year")
    con.execute("INSERT INTO year_evidence(uuid,gid_at_entry,year,year_from,year_to,precision,source,note,url,"
                "added_at,status,replaces_record) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (uuid, gid, args.year, args.year_from or args.year or 0, args.year_to or args.year or 0,
                 args.precision, args.source, args.note, args.url, now(),
                 "accepted" if not args.candidate else "candidate", 1 if args.replace_record else 0))
    apply_evidence(con)
    row = con.execute("SELECT gid,address,district,year,ysrc FROM buildings WHERE uuid=?", (uuid,)).fetchone()
    print(f"logged for gid {row[0]} {row[1]} ({row[2]}): {row[3]} from source {row[4]}")
    con.close()


def find(args) -> None:
    con = connect()
    con.executescript(SCHEMA)
    q = f"%{args.text.strip()}%"
    rows = con.execute("""
        SELECT gid, address, district, year, CASE yflag WHEN 0 THEN 'exact' WHEN 1 THEN 'range' WHEN 2 THEN 'open span'
               WHEN 3 THEN 'area' WHEN 4 THEN 'estimate' WHEN 6 THEN 'period only' ELSE 'unknown' END,
               COALESCE(name,''), ROUND(footprint_m2), ROUND(height_m,1), private, uuid
        FROM buildings WHERE address LIKE ? OR name LIKE ?
        ORDER BY CASE WHEN lower(address) = lower(?) THEN 0
                      WHEN lower(address) LIKE lower(?) THEN 1 ELSE 2 END,
                 footprint_m2 DESC LIMIT ?""",
        (q, q, args.text.strip(), args.text.strip() + "%", args.limit)).fetchall()
    if not rows:
        print("nothing matched")
    for r in rows:
        print(f"gid {r[0]:>7}  {r[1] or '-':<32} {r[2] or '-':<22} {r[3] or '-':>5}  {r[4]:<11} "
              f"{r[6]:>6} m2  {r[7]:>5} m  {'private' if r[8] else ''}  {r[5]}")
    con.close()


def coverage(args) -> None:
    con = connect()
    con.executescript(SCHEMA)
    for name, sql in (
        ("COVERAGE", "SELECT * FROM v_coverage"),
        ("BY SOURCE", "SELECT * FROM v_coverage_by_source"),
        ("HOW KNOWN", "SELECT * FROM v_coverage_by_flag"),
        ("BY PERIOD", "SELECT * FROM v_coverage_by_period"),
        ("BY DISTRICT (top 24)", "SELECT * FROM v_coverage_by_district LIMIT 24"),
        ("HAND ENTRIES", "SELECT status, COUNT(*) FROM year_evidence GROUP BY status"),
    ):
        try:
            cur = con.execute(sql)
        except sqlite3.OperationalError as e:
            print(f"{name}: {e}")
            continue
        cols = [d[0] for d in cur.description]
        print(f"\n== {name} ==")
        print(" | ".join(cols))
        for r in cur.fetchall():
            print(" | ".join("" if v is None else str(v) for v in r))
    con.close()


def export(args) -> None:
    """Write the hand entries as a CSV the pipeline can read, and a QGIS-ready GeoJSON-ish CSV."""
    con = connect()
    con.executescript(SCHEMA)
    out = PROJECT / "data" / "processed" / "manual_years.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = con.execute("""
        SELECT b.uuid, b.gid, b.address, b.district, b.lat, b.lon, e.year, e.year_from, e.year_to,
               e.precision, e.source, e.note, e.url, e.added_at
        FROM year_evidence e JOIN buildings b ON b.uuid = e.uuid
        WHERE e.status='accepted'
          AND e.id IN (SELECT MAX(id) FROM year_evidence WHERE status='accepted' GROUP BY uuid)
        ORDER BY e.added_at""").fetchall()
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["uuid", "gid", "address", "district", "lat", "lon", "year", "year_from", "year_to",
                    "precision", "source", "note", "url", "added_at"])
        w.writerows(rows)
    print(f"{len(rows)} hand entries written to {out}")
    con.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("build", help="(re)build the index from engine/data (keeps year_evidence)")

    p = sub.add_parser("add-year", help="log one building's year and apply it")
    p.add_argument("--gid", type=int)
    p.add_argument("--uuid")
    p.add_argument("--address")
    p.add_argument("--year", type=int)
    p.add_argument("--year-from", type=int)
    p.add_argument("--year-to", type=int)
    p.add_argument("--precision", default="exact", choices=list(PRECISION_TO_FLAG))
    p.add_argument("--source", required=True)
    p.add_argument("--note")
    p.add_argument("--url")
    p.add_argument("--candidate", action="store_true", help="log it but do not apply it")
    p.add_argument("--replace-record", action="store_true",
                   help="overwrite a year that came from a record source (needs a reason in --note)")

    p = sub.add_parser("find", help="search address or name")
    p.add_argument("text")
    p.add_argument("--limit", type=int, default=20)

    sub.add_parser("coverage", help="print the coverage tables")
    sub.add_parser("export", help="write data/processed/manual_years.csv")

    args = ap.parse_args()
    cmd = args.cmd or "build"
    {"build": build, "add-year": add_year, "find": find, "coverage": coverage, "export": export}[cmd](args)


if __name__ == "__main__":
    main()
