"""Everything Zagreb-specific that the pipeline and the generated zagreb.json need (port of husforhus' Stockholm layer).

Local frame: metres from ORIGIN (Trg bana Jelačića), x east, z south, as upstream (three.js, y up).
CRS is HTRS96/TM (EPSG:3765). The build covers all of Grad Zagreb (17 gradske četvrti; ZG3D 2022 building parts merged
into buildings by their OSM footprint). The Donji grad pilot is SOURCE_PILOT below.
Many names below are kept from the Stockholm layer because the engine imports them; where a Stockholm feature has no
Zagreb data the value is empty and the feature is switched off in FEATURES. The Stockholm original is kept beside this
file as city_stockholm.py.orig.
"""
from bisect import bisect_right

import numpy as np

SLUG = "zagreb"
NAME = "Zagreb, building by building"
# label_sv slots carry Croatian (the engine's second-language slot; the language switch is off in this pilot)
SUBTITLE = {"en": "Zagreb, building by building", "sv": "Zagreb, zgradu po zgradu"}
CRS = 3765                                   # HTRS96 / Croatia TM
ORIGIN = (459370.1, 5074937.5)               # Trg bana Jelačića (15.9772 E, 45.8131 N), EPSG:3765
KOMMUN = "Grad Zagreb"
WIKIDATA = "Q1435"
TILE = 1200.0
N_PACKS = 24
REVEAL_PACKS = 4                             # web/app.js opens the map once the 4 centre-most packs are drawn
SIMPLIFY = 0.25                              # metres
# Donji grad from the south-south-west: the Lower Town grid and the Green Horseshoe in front, Jelačić square behind.
HOME = dict(x=0.0, z=500.0, azimuth=190.0, elevation=40.0, span=1600.0)   # over Donji grad/Gornji grad; picked by pixel share
# (key, label_en, label_hr, from, to, colour). Colours: every other step of Ärg's 12-step ramp (web/themes.js keeps the
# same six per look), so six periods still run from verdigris to copper.
PERIODS = [
    ("p1", "Before 1800",                        "Prije 1800.",                          1000, 1799, "#8ed3d0"),
    ("p2", "1800-1879: early 19th century",       "1800.-1879.: rano 19. stoljeće",       1800, 1879, "#47a0a5"),
    ("p3", "1880-1918: after the earthquake, Lower Town grid", "1880.-1918.: nakon potresa, donjogradski raster", 1880, 1918, "#387b88"),
    ("p4", "1919-1945: interwar modernism",       "1919.-1945.: međuratna moderna",       1919, 1945, "#465262"),
    ("p5", "1946-1990: socialist era",            "1946.-1990.: socijalističko razdoblje", 1946, 1990, "#aa6446"),
    ("p6", "1991-today",                         "1991.-danas",                          1991, 2100, "#e49f75"),
]
# Private homes: s01 sets kategori "house" for OSM building=house/detached/semidetached_house/terrace/bungalow/cabin/
# farm/villa, and for small unnamed residential or untyped buildings (<= 250 m², <= 12 m; pipeline/zagreb_city.py).
PRIVATE_HOUSE_KATEGORI: set[str] = {"house"}
# towers.parquet holds each merged building's own ZG3D parts (s03_tiles.tower_parts draws them, no laser credit)
BUILDING_PARTS = True
# s99_validate's limits, where Stockholm's do not fit the whole of Zagreb (each is documented in RUN.md)
VALIDATE = dict(first_load_bytes=7_500_000, whole_city_bytes=50_000_000, terrain_dm=(-100, 10_000),
                max_ground_dm=10_000, max_height_dm=2_500, tower_m=(0.3, 400.0))
# Metres per storey (no OSM levels here): one value, the Lower Town's tall 19th-century storeys in mind.
STOREY_M = {"_default": 3.8}
TIER1: list[str] = ["Ilica", "Vukovarska ulica", "Savska cesta", "Sava"]
SALTSJON = (0.0, 0.0, 0.0)                   # Stockholm's hand-placed water label; unused (no Stadskarta in Zagreb)
# The language switch is on: the second table (web/i18n/sv.json) carries Croatian, so a Zagreb reader can
# read the interface and the About panel in Croatian. ?lang=sv picks it; the choice is remembered.
FEATURES = {"quests": False, "layers": False, "energy": False, "lang": True, "search": True, "scenes": True,
            "plaques": False, "metro": False, "walks": False, "ferries": False}
STARTS = [("Trg bana Jelačića", "Trg bana Jelačića", 0.0, 0.0)]
# HFH_FIXTURE=1: a small box round Zrinjevac (unused by s01_zagreb, kept for the engine's tests)
FIXTURE_BBOX = (459100.0, 5074300.0, 459700.0, 5074800.0)
MIN_BUILDINGS = 150_000                      # whole city: ~357k ZG3D parts, merged into buildings
# s01_zagreb's input (paths relative to the engine folder). The pilot: the two Donji grad GeoJSONs. The whole city is a
# config change: {"kind": "geoparquet", "path": "../data/processed/zagreb_buildings.parquet", "bbox": (e0, n0, e1, n1)}
# or "district": a polygon file (EPSG:3765, height/z_min/z_max columns; ZBSM columns cls/y/adr/naz/aut/nam if joined),
# then lower MIN_BUILDINGS/raise TILE/N_PACKS to fit and move HOME.
SOURCE_PILOT = {"kind": "geojson_pair", "zg3d": "input/zg3d_donji.geojson", "joined": "input/donji_joined.geojson"}
SOURCE = {"kind": "city", "parts": "../data/processed/zagreb_buildings.parquet", "osm": "../data/raw/osm",
          "wikidata": "../data/raw/wikidata/zg_wikidata.parquet", "zbsm": "../data/raw/zenodo/zgr_zg_data.geojson",
          "rpj_addresses": "../data/raw/zagreb/rpj_kucni_broj.geojson",
          "dem": "../data/raw/dem",
          # City of Zagreb heritage/survey layers, downloaded 2026-10-20 (pipeline/zagreb_heritage.py, sources.yml)
          "heritage": "../data/raw/year-sources",
          # GHSL GHS-BUILT-S R2023A and WSF Evolution rasters: the card's satellite line (pipeline/zagreb_sat.py)
          "ghsl": "../data/raw/ghsl", "wsf": "../data/raw/wsf",
          # ZG3D 2022 LoD2.2 faces, one folder per gradska četvrt (SHP; FGDB for Podsused - Vrapče): s02_lod2
          "lod2": "../data/raw/zg3d_shp"}

# --- The estimate tier (husforhus' kNN, cross-validated with whole 250 m blocks held out) ---
INNER_STADSDELAR = {"DONJI GRAD", "GORNJI GRAD - MEDVEŠČAK", "TRNJE", "ČRNOMEREC", "MAKSIMIR", "TREŠNJEVKA - SJEVER"}
CORE_DISTRICT = "DONJI GRAD"                 # About's "old town" count (Stockholm: Gamla stan)
KATEGORI_GROUPS: dict[str, str] = {"house": "house", "apartments": "apartments", "residential": "apartments",
                                    "yes": "unspecified", "unmapped": "unspecified"}
GROUP_LABELS = {"house": "Houses", "apartments": "Apartment buildings", "unspecified": "Other and untyped"}
ERAS = [("before 1880", 1000, 1879), ("1880–1918", 1880, 1918), ("1919–1945", 1919, 1945),
        ("1946–1990", 1946, 1990), ("1991 on", 1991, 2100)]
# Zagreb has no property designations: held-out blocks are grid cells. 1 km, not 250 m, because ZBSM dates whole
# heritage ensembles; with 250 m cells their neighbours leak the same year into the test (measured 2026-10-21).
ESTIMATE_BLOCK_M = 1000.0
ESTIMATE = dict(
    L=280.0, w_height=3.0, w_area=0.5, w_compact=0.0, group_penalty=2.0, k=20, eps=0.05, kvarter_bonus=0.5,
    near_m=100.0, late_prod_year=2008, late_unit_fnr=10_400_000, never_groups=set(), estimate_groups={"house"},
    min_cell=30, min_right=0.7, max_band=15, give_period=False, band_step=5, folds=5, seed=0, far_rule="unknown",
    period_only_stadsdelar=set(),
)

# --- The estimate tier's calibration target (docs/faculty-paper.md) ---
# Savor Novak et al. 2026 (doi 10.1007/s10518-026-02662-y, open access): the City of Zagreb's earthquake risk
# model dates the residential stock in five construction periods. zagreb_city.calibration() measures the map's
# residential mix over these spans into accuracy.json "calibration", which the About panel shows beside the
# target. When the estimate tier runs, its output mix must reproduce the target within a reviewed margin;
# never tune a cell to pass it, a drift is reported and reviewed.
CALIBRATION_SPANS = [("before_1948", 0, 1947), ("1948_1964", 1948, 1964), ("1965_1981", 1965, 1981),
                     ("1982_2009", 1982, 2009), ("after_2009", 2010, 2100)]
CALIBRATION_TARGET = {"before_1948": 0.14, "1948_1964": 0.23, "1965_1981": 0.34, "1982_2009": 0.27, "after_2009": 0.02}
CALIBRATION_SOURCE = "Savor Novak et al. 2026, doi 10.1007/s10518-026-02662-y (open access)"

# --- Terrain ---
# Built by s01_zagreb from the ZG3D parts' Z_Min (no DTM here): heights are metres above DATUM_M (100 m a.s.l.),
# so the Lower Town reads 12-22 m and water_z stays 0 as the viewer expects.
DATUM_M = 100.0
TERRAIN = dict(
    cell=40.0, sub=4, burn=2,
    water_z=0.0, sea_max=3.0, bridge_m=30.0,
    lake_offset={"dtm": 0.3, "contours": 1.0, "zg3d": 0.3},
    fix_m={"dtm": 5.0, "contours": 20.0, "zg3d": 5.0},
    terrace_up=0.3, terrace_max_cut=20.0,
    buried_max=50,
    ground_min=0.3, datum_max=0.3,
    relief=1.0, relief_max=2.5, fade_m=400.0, terrace="none", chunk=2400.0,
    fixture_margin=500.0,
)

# --- Card, links, wiki (no Wikidata/OSM in this pilot) ---
BOX_WGS84 = (15.78, 45.61, 16.25, 45.97)
LINKS = {
    "raa": "https://doi.org/10.5281/zenodo.13602015#{id}",
    "wikidata": "https://www.wikidata.org/wiki/{qid}",
    "wikipedia": "https://www.wikidata.org/wiki/Special:GoToLinkedPage/{lang}wiki/{qid}",
    "wikipedia_rev": "https://{lang}.wikipedia.org/w/index.php?oldid={rev}",
}
FLOORS_OSM = dict(min_iou=0.5, max_levels=60)
OSM_TILES = (1, 1)
NO_FLOORS_PURPOSE: set[str] = set()
# OSM building types whose card leaves the floors row out (storeys from height mean nothing there)
NO_FLOORS_KATEGORI: set[str] = {"cathedral", "church", "chapel", "religious", "mosque", "synagogue", "temple", "tower",
                                "chimney", "water_tower", "transformer_tower", "silo", "stadium", "grandstand",
                                "hangar", "greenhouse", "roof", "bridge", "bell_tower"}
# ZBSM `naziv` values that name only a kind of building: never a card title
GENERIC_NAMES = {"stambena zgrada", "stambene zgrade", "stambeno-poslovna zgrada", "stambeno-poslovne zgrade",
                 "poslovna zgrada", "zgrada", "kuća"}
GENERIC_NAME_RE = r"^(_+|.)$"
ARCHITECT_MAX_RARE = 0
WIKI = dict(max_m=30.0, thumb_width=500, photo_bytes=400_000, extract_chars=500, langs=("en", "sv"), private_m=5.0)
PHOTO_DENY: set[str] = set()

# --- Search, About ---
_CETVRTI = ["Donji grad", "Gornji grad - Medveščak", "Trnje", "Maksimir", "Peščenica - Žitnjak", "Novi Zagreb - istok",
             "Novi Zagreb - zapad", "Trešnjevka - sjever", "Trešnjevka - jug", "Črnomerec", "Gornja Dubrava",
             "Donja Dubrava", "Stenjevec", "Podsused - Vrapče", "Podsljeme", "Sesvete", "Brezovica"]
DISTRICT_NAMES = {c.upper(): c for c in _CETVRTI}
DISTRICT_ALIASES = {"Lower Town": ("DONJI GRAD",), "Upper Town": ("GORNJI GRAD - MEDVEŠČAK",),
                    "Gornji grad": ("GORNJI GRAD - MEDVEŠČAK",), "Medveščak": ("GORNJI GRAD - MEDVEŠČAK",),
                    "Kaptol": ("GORNJI GRAD - MEDVEŠČAK",), "Novi Zagreb": ("NOVI ZAGREB - ISTOK", "NOVI ZAGREB - ZAPAD"),
                    "New Zagreb": ("NOVI ZAGREB - ISTOK", "NOVI ZAGREB - ZAPAD"), "Trešnjevka": ("TREŠNJEVKA - SJEVER", "TREŠNJEVKA - JUG"),
                    "Dubrava": ("GORNJA DUBRAVA", "DONJA DUBRAVA"), "Peščenica": ("PEŠČENICA - ŽITNJAK",),
                    "Žitnjak": ("PEŠČENICA - ŽITNJAK",), "Vrapče": ("PODSUSED - VRAPČE",), "Podsused": ("PODSUSED - VRAPČE",),
                    "Jarun": ("TREŠNJEVKA - JUG",), "Sljeme": ("PODSLJEME",)}
BUILDING_ALIASES: dict[str, str] = {}
OUTSIDE = ("Samobor", "Zaprešić", "Velika Gorica", "Sveta Nedelja", "Dugo Selo", "Stupnik", "Bistra", "Rugvica")
SEARCH = dict(addr_max_m=10.0, min_chars=2, max_rows=8, max_per_kind=4, max_edits=2,
              examples=("Hrvatsko narodno kazalište", "Novi Zagreb", "Maksimir"))
LASER = dict(ring_m=15.0, min_lod1_m=25.0, budget_bytes=500_000_000)
LASER_TOWERS: tuple = ()
PRIVATE_ADDRESSES = True
SNAPSHOT = "2022"
MAKER = "Jure Čerkez"
CONTACT = "https://github.com/jurecerkez-code/zagreb-map"
RELEASE_WAITS_FOR = ("a maker and contact for About (GDPR Art. 14)", "licence check of every source")
LANG_FROM_BROWSER = True   # a Croatian browser is not 'sv' yet, so this only helps a Swedish one for now;
# the switch and ?lang=sv are the way in. Set False to keep every visitor in English.
GROUP_LABELS_SV = {"house": "Kuće", "apartments": "Stambene zgrade", "unspecified": "Ostalo"}
ERA_LABELS_SV = {"before 1880": "prije 1880.", "1991 on": "1991. i kasnije"}

_PERIOD_STARTS = [p[3] for p in PERIODS]


def period_index(year: int) -> int:
    """0-based index into PERIODS; years before 1000 → 0, after 2100 → the last period."""
    return max(0, bisect_right(_PERIOD_STARTS, int(year)) - 1)


def period_indices(years) -> np.ndarray:
    y = np.round(np.asarray(years, dtype=float)).astype(np.int64)
    return np.maximum(0, np.searchsorted(_PERIOD_STARTS, y, side="right") - 1)


def to_local(e, n) -> tuple[np.ndarray, np.ndarray]:
    """EPSG:3765 easting/northing → local (x, z) in metres. Vectorised; scalars give 0-d arrays."""
    x = np.asarray(e, dtype=np.float64) - ORIGIN[0]
    z = -(np.asarray(n, dtype=np.float64) - ORIGIN[1])
    return x, z
