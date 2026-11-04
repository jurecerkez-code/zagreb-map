"""Zagreb port: construction years from the City of Zagreb's heritage and survey layers (s01_zagreb, city kind).

Inputs: the copies downloaded on 2026-10-20 under city.SOURCE["heritage"] (data/raw/year-sources; the City warns its
working layers can be removed at any time, so these copies are the source of truth; see pipeline/sources.yml):

  kd_pojedinacna.geojson   KD_pojedinacna, the individual protected cultural goods (polygons, `datacija`); the national
                           Registar kulturnih dobara (rkd.csv, `Vrijeme_nastanka`, joined by Oznaka_dobra =
                           registarski_broj) fills an empty `datacija`. A RECORD per building (SRC_KD).
  kultura_zastita.geojson  KULTURA_ZASTITA: GRADEVINA = one protected building, a RECORD (SRC_ZG_HER). CJELINA/SKLOP =
                           an ensemble: an AREA year (SRC_ZG_AREA) and only for the ensembles in AREA_ENSEMBLES, whose
                           `datacija` is the construction period of the ensemble itself (read by hand, 2026-10-21).
  obnova_procelja.geojson  OBNOVA_PROCELJA: `DATACIJA_PROJEKT` is the dating of the building's original design (e.g.
                           "1926/27", Pollak i Bornstein); the renovation years (`Godina_početak_završetak_obnove`) are
                           never used. A RECORD (SRC_ZG_FACADE).
  tipologija.geojson       Tipologija_certifikat_02: the City's post-earthquake typology, working data (radni materijal,
                           not verified). Its period class is an AREA-level period, never exact (SRC_ZG_TIPO); the
                           open-ended class 'prije1968' has no lower bound and is not used.

`datacija` is free text. parse_datacija reads only the FIRST clause (before ';'): later clauses are additions,
rebuilds and adaptations. Single year -> EXACT; 'a.-b.' -> RANGE/LONG by the engine's span rule; 'oko X' -> X±5;
centuries ('19. st.' = 1801-1900, 'kraj 19. st.' = 1876-1900, 'poč.' first quarter, 'sred.'/'pol.' 1841-1860,
'prva/druga pol.' halves) -> LONG; 'prije/nakon/iza X', 'srednji vijek', 'nepoznato' and spans over MAX_SPAN years
are not years and are logged.
"""
import csv
import io
import re
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from . import city, codes
from .yearrules import LATEST_YEAR

MAX_SPAN = 200            # a dating wider than this says nothing about the standing building
TIPO_NEAR_M = 15.0        # a typology address point outside every footprint takes the nearest within this
SHED_M2 = 40.0            # a building under this inside a record polygon with a building 3x its size is left out
SURVEY_YEAR = 2022        # ZG3D 2022: every building on the map stood by then ('nakon2000' = 2001-2022)
DOWNLOADED = "2026-10-20"

# KULTURA_ZASTITA ensembles (CJELINA / SKLOP) whose datacija is the ensemble's own construction period, by
# br_zastite. Left out on purpose: village cores dated '13. st.' (Kašina, Vugrovec: the settlement, not its houses),
# Dotrščina (a memorial forest), and every complex whose text lists additions or several phases (Paromlin, Pivovara,
# Ruđer Bošković, Mirogoj 'od 1883.', Maksimir, the Cathedral complex, monasteries, ...).
AREA_ENSEMBLES = {
    "Z-1530": "Željeznička kolonija", "Z-1542": "Prva hrvatska štedionica, Trešnjevka", "Z-1543": "Cvjetno naselje",
    "Z-1544": "Vile u Novakovoj ulici", "Z-5809": "TEŽ", "Z-2133": "Tehnički muzej", "Z-0460": "Glavni kolodvor",
    "Z-2288": "Pupinovo naselje", "Z-2152": "Niz najamnih stambenih zgrada", "Z-1534": "Gradska klaonica",
    "Z-0471": "Kukovićeva kuća", "Z-1549": "Kolonija na Ciglani", "Z-0455": "Crkva Srca Isusova",
    "Z-2142": "Stambene zgrade", "Z-4753": "Pasaž Masarykova - Varšavska", "Z-1233": "Rudolfova vojarna",
    "Z-1535": "Zakladni blok", "Z-0224": "Prva hrvatska štedionica", "Z-0491": "Vatikan (Nadarbina)",
    "Z-1042": "Kuće Wellisch", "Z-2144": "Poštanska štedionica", "Z-0704": "Bolnica Vrapče",
    "Z-1541": "Gogoljin brijeg", "Z-2139": "Dječačko sjemenište", "Z-0724": "Ksaver",
    "Z-5249": "Veterinarski fakultet", "Z-2282": "Crkva BDM i župni dvor", "Z-2285": "Pionirski grad",
    "Z-2287": "Građevinski školski centar", "Z-2284": "Brodarski institut", "Z-2951": "Zagrebački velesajam",
    "Z-2286": "Studentski dom Stjepan Radić", "Z-1550": "Mali stanovi za invalide i izbjeglice iz Istre",
}
# KD_pojedinacna goods that are not buildings: their dating is a monument's, a plaque's or an interior's
KD_NOT_BUILDING = {"javna plastika", "memorijalna obilježja i mjesta", "sakralno obilježje u prostoru"}
KD_NOT_BUILDING_NAME = re.compile(r"interijer|spomen-ploč|ugrađen\w* oprem", re.I)
TIPO_SPAN = {"od1968_do1980": (1968, 1980), "od1980_do2000": (1980, 2000), "nakon2000": (2001, SURVEY_YEAR)}


# ---------------------------------------------------------------- parsing
def _century(c: int, qual: str) -> tuple[int, int]:
    a = (c - 1) * 100
    q = (qual or "").strip().lower().replace(" ", "")
    if q.startswith("poč"):
        return a + 1, a + 25
    if q.startswith("kraj"):
        return a + 76, a + 100
    if q.startswith(("prva", "1.")):
        return a + 1, a + 50
    if q.startswith(("druga", "2.")):
        return a + 51, a + 100
    if q.startswith(("sred", "pol")):
        return a + 41, a + 60
    return a + 1, a + 100


def span_flag(y0: int, y1: int, long_span: int = 15) -> tuple[int, int, int, int]:
    y0, y1 = min(y0, y1), max(y0, y1)
    if y0 == y1:
        return y0, y0, y0, codes.EXACT
    if y1 - y0 <= long_span:
        return y1, y0, y1, codes.RANGE
    return y0, y0, y1, codes.LONG


QUAL = r"(kraj|poč\.?|sred\.?|prva\s*pol\.?|druga\s*pol\.?|[12]\.\s*pol\.?|pol\.?)?\s*"


def parse_datacija(text) -> tuple[tuple | None, str]:
    """(year, from, to, yflag) or None, and how it was read ('year', 'span', 'circa', 'century' or the reason it
    was not)."""
    if not isinstance(text, str) or not text.strip():
        return None, "empty"
    t = text.strip().lower()
    t = t.replace("g. n.e.", "").replace("n.e.", "").replace("god.", "").replace(" do ", " - ").replace("–", "-")
    t = re.sub(r"\(.*?\)", "", t)
    first = re.split(r";|,\s*(?=[a-zčćšžđ])", t)[0].strip().rstrip(",")
    first = re.sub(r"^\d{1,2}\.\s*\d{1,2}\.\s*(\d{4})\.?$", r"\1", first)      # '26.4.1880.' (a full date)
    if not first or first in ("-", "nepoznato", "nedatirano") or "vijek" in first:
        return None, "no date"
    if re.match(r"(prije|nakon|iza|poslije|pr\.|od)\b", first):
        return None, "bound, not a year"
    if re.match(r"(dogradnj|pregradnj|adaptacij|rekonstrukcij|obnov)", first):
        return None, "rebuild, not construction"
    circa = bool(re.match(r"oko\b", first))
    first = re.sub(r"^oko\s*", "", first)
    first = re.sub(r"^između\s+(\d{4})\.?\s+i\s+(\d{2,4})\.?$", r"\1 - \2", first)
    first = re.sub(r"\s+i\s+.*$", "", first)                 # '1249.-54. i poč.16.st.': the first period
    # centuries: '19. st.', 'kraj 18./poč.19.st.', '18. st. - 19. st.', '17. - 19.' (two-digit = century), '18./19. st.'
    cent = r"(\d{1,2})\.?\s*(?:st\.?|stoljeće)?"
    m = re.fullmatch(QUAL + cent + r"\s*[-/]\s*" + QUAL + cent, first)
    if m and (("st" in first) or len(m.group(2)) <= 2 and len(m.group(4)) <= 2):
        a, _ = _century(int(m.group(2)), m.group(1))
        _, b = _century(int(m.group(4)), m.group(3))
        return _span(a, b, "century")
    m = re.fullmatch(QUAL + r"(\d{1,2})\.?\s*(?:st\.?|stoljeće)?", first)
    if m and ("st" in first or m.group(1) or len(m.group(2)) <= 2):
        a, b = _century(int(m.group(2)), m.group(1))
        return _span(a, b, "century")
    # years: '1790.', '1959. - 1963.', '1955.-57.', '1926/27', '1934.-35.', '1883. st.' (a year mislabelled st.)
    m = re.fullmatch(r"(?:poč\.?\s*)?(\d{4})\.?\s*(?:st\.?)?\s*(?:[-/]\s*(?:kraj\s*)?(\d{2,4})\.?\s*(?:st\.?)?)?\s*\.?",
                     first)
    if m:
        a = int(m.group(1))
        b = m.group(2)
        b = a if b is None else int(str(a)[:4 - len(b)] + b)
        if circa and b == a:        # 'oko 1900.': the stated year, within ±5
            return (a, a - 5, a + 5, codes.RANGE), "circa"
        if circa:
            return _span(a - 5, b, "circa")
        return _span(a, b, "year" if a == b else "span")
    # 'poč.20.st.-1930': a century part then a year
    m = re.fullmatch(QUAL + r"(\d{1,2})\.?\s*st\.?\s*-\s*(\d{4})\.?", first)
    if m:
        a, _ = _century(int(m.group(2)), m.group(1))
        return _span(a, int(m.group(3)), "century")
    # '1865. - 2. pol 20. st.'
    m = re.fullmatch(r"(\d{4})\.?\s*-\s*" + QUAL + r"(\d{1,2})\.?\s*st\.?", first)
    if m:
        _, b = _century(int(m.group(3)), m.group(2))
        return _span(int(m.group(1)), b, "century")
    return None, "unparsed"


def _span(a: int, b: int, how: str):
    a, b = min(a, b), max(a, b)
    b = min(b, LATEST_YEAR)
    if a < 1000 or a > LATEST_YEAR:
        return None, "out of range"
    if b - a > MAX_SPAN:
        return None, f"span over {MAX_SPAN} years"
    return span_flag(a, b), how


# ---------------------------------------------------------------- loading
def _read(path: Path) -> gpd.GeoDataFrame:
    g = gpd.read_file(path)
    g = (g.set_crs(4326) if g.crs is None else g).to_crs(city.CRS)
    g["geometry"] = shapely.make_valid(g.geometry.values)
    return g[g.geometry.notna() & ~g.geometry.is_empty].reset_index(drop=True)


def _rkd(path: Path) -> dict:
    if not path.exists():
        return {}
    rows = csv.DictReader(io.StringIO(path.read_bytes().decode("utf-8-sig")))
    return {r["Oznaka_dobra"].strip(): (r.get("Vrijeme_nastanka") or "").strip() for r in rows}


def _within_smallest(points, polys) -> np.ndarray:
    tree = shapely.STRtree(polys)
    pi, gi = tree.query(points, predicate="within")
    out = np.full(len(points), -1, dtype=np.int64)
    if len(pi):
        area = shapely.area(np.asarray(polys)[gi])
        order = np.lexsort((area, pi))
        pi, gi = pi[order], gi[order]
        first = np.r_[True, pi[1:] != pi[:-1]]
        out[pi[first]] = gi[first]
    return out


def candidates(b: gpd.GeoDataFrame, folder: Path) -> tuple[dict, dict, list[dict]]:
    """({key: {gid: (year, from, to, yflag, how, ref)}}, info, log rows, {gid: register name}). Keys: kd, zg_her, zg_facade (records),
    zg_area, zg_tipo (area level). `ref` names the register entry (registration number or object id)."""
    cand = {k: {} for k in ("kd", "zg_her", "zg_facade", "zg_area", "zg_tipo")}
    info, log = {}, []
    rep = shapely.point_on_surface(b.geometry.values)

    def polygon_layer(key, g, texts, refs, keep, area=False):
        parsed = []
        for t, r, k in zip(texts, refs, keep):
            if not k:
                parsed.append(None)
                continue
            p, how = parse_datacija(t)
            parsed.append(None if p is None else (*p, how))
            log.append({"layer": key, "ref": r, "datacija": t, "read": how,
                        "years": "" if p is None else f"{p[1]}-{p[2]}"})
        hit = _within_smallest(rep, g.geometry.values)
        if not area:   # a shed or garage inside a protected parcel is not the protected building
            ba = shapely.area(b.geometry.values)
            big = pd.Series(ba[hit >= 0]).groupby(hit[hit >= 0]).max()
            small = (hit >= 0) & (ba < SHED_M2)
            small &= big.reindex(np.maximum(hit, 0)).fillna(0).to_numpy() >= 3 * SHED_M2
            info.setdefault("sheds_skipped", {})[key] = int(small.sum())
            hit = np.where(small, -1, hit)
        n = 0
        for gid in np.flatnonzero(hit >= 0):
            p = parsed[hit[gid]]
            if p is None:
                continue
            yflag = codes.AREA if area else p[3]
            cand[key][int(gid)] = (p[0], p[1], p[2], yflag, p[4], refs[hit[gid]])
            n += 1
        used = [p is not None for p in parsed]
        info[key] = {"features": int(sum(keep)), "dated_features": int(sum(used)), "buildings": n}

    # KD_pojedinacna (+ RKD where its datacija is empty)
    kd = _read(folder / "kd_pojedinacna.geojson")
    rkd = _rkd(folder / "rkd.csv")
    texts = [d if isinstance(d, str) and d.strip() else rkd.get(str(r).strip(), "")
             for d, r in zip(kd.datacija, kd.registarski_broj)]
    keep = [(c not in KD_NOT_BUILDING) and not KD_NOT_BUILDING_NAME.search(str(nm or ""))
            for c, nm in zip(kd.klasifikacija, kd.naziv)]
    polygon_layer("kd", kd, texts, kd.registarski_broj.astype(str).tolist(), keep)
    info["kd"]["rkd_rows_joined"] = int(sum(str(r).strip() in rkd for r in kd.registarski_broj))
    names = {}
    hit = _within_smallest(rep, kd.geometry.values)
    for gid in np.flatnonzero(hit >= 0):
        if keep[hit[gid]] and isinstance(kd.naziv.iat[hit[gid]], str):
            names[int(gid)] = kd.naziv.iat[hit[gid]].strip()

    kz = _read(folder / "kultura_zastita.geojson")
    gr = kz[kz.kategorija == "GRADEVINA"].reset_index(drop=True)
    polygon_layer("zg_her", gr, gr.datacija.tolist(), gr.br_zastite.astype(str).tolist(),
                  [not KD_NOT_BUILDING_NAME.search(str(nm or "")) for nm in gr.naziv])
    hit = _within_smallest(rep, gr.geometry.values)
    for gid in np.flatnonzero(hit >= 0):
        if int(gid) not in names and isinstance(gr.naziv.iat[hit[gid]], str):
            names[int(gid)] = gr.naziv.iat[hit[gid]].strip()
    ens = kz[kz.kategorija.isin(["CJELINA", "SKLOP"])].reset_index(drop=True)
    polygon_layer("zg_area", ens, ens.datacija.tolist(), ens.br_zastite.astype(str).tolist(),
                  [str(r) in AREA_ENSEMBLES for r in ens.br_zastite], area=True)
    info["zg_area"]["by_ensemble"] = {
        AREA_ENSEMBLES[r]: int(sum(1 for v in cand["zg_area"].values() if v[5] == r)) for r in AREA_ENSEMBLES}

    ob = _read(folder / "obnova_procelja.geojson")
    polygon_layer("zg_facade", ob, ob.DATACIJA_PROJEKT.tolist(), [f"OBNOVA {i}" for i in ob.ID],
                  [True] * len(ob))

    # typology points: in a footprint, else the nearest within TIPO_NEAR_M; a building with several points keeps
    # the most frequent class
    tp = _read(folder / "tipologija.geojson")
    tp = tp[tp.Razdoblje.notna()].reset_index(drop=True)
    for r in tp.Razdoblje:
        log.append({"layer": "zg_tipo", "ref": "", "datacija": r,
                    "read": "period" if r in TIPO_SPAN else "open-ended class, not used",
                    "years": "-".join(map(str, TIPO_SPAN[r])) if r in TIPO_SPAN else ""})
    pts = tp.geometry.values
    g_in = _within_smallest(pts, b.geometry.values)
    miss = g_in < 0
    if miss.any():
        qi, gi = shapely.STRtree(b.geometry.values).query_nearest(pts[miss], max_distance=TIPO_NEAR_M)
        got = np.full(int(miss.sum()), -1)
        got[qi] = gi
        g_in[np.flatnonzero(miss)] = got
    per = {}
    for g, r in zip(g_in, tp.Razdoblje):
        if g >= 0:
            per.setdefault(int(g), []).append(r)
    for g, rs in per.items():
        r = max(set(rs), key=rs.count)
        if r in TIPO_SPAN and rs.count(r) == len(rs):          # points that disagree: no year
            a, z = TIPO_SPAN[r]
            y, a, z, _ = span_flag(a, z)
            cand["zg_tipo"][g] = (y, a, z, codes.AREA, "period", f"Tipologija {r}")
    info["zg_tipo"] = {"points": int(len(tp)), "matched_buildings": len(per), "buildings": len(cand["zg_tipo"]),
                       "by_class": pd.Series(tp.Razdoblje).value_counts().to_dict()}
    info["downloaded"] = DOWNLOADED
    return cand, info, log, names


def write_log(log: list[dict], path: Path) -> dict:
    df = pd.DataFrame(log)
    df.to_csv(path, index=False, encoding="utf-8")
    return {k: v for k, v in df.groupby(["layer", "read"]).size().items()} if len(df) else {}
