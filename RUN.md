# Zagreb, building by building — how to run (husforhus engine, whole city)

Paths are relative to `CODE university/PROJEKTI/zagreb-by-building/`. Run commands from `engine/` (first time: `uv sync`, `npm ci`).

## 1. Inputs (once, by hand)

| File | How |
|---|---|
| `data/processed/zagreb_buildings.parquet` | ZG3D 2022, all 357,683 building parts (EPSG:3765; `zg3d_id, height, z_min, z_max`) |
| `data/raw/zenodo/zgr_zg_data.geojson` | Zagreb Building Stock Model (Zenodo 10.5281/zenodo.13602015) |
| `data/raw/osm/croatia-latest.osm.pbf` → `zg_osm_*.parquet` | `curl -L -o ../data/raw/osm/croatia-latest.osm.pbf https://download.geofabrik.de/europe/croatia-latest.osm.pbf`, then `uv run python -m pipeline.zagreb_osm` (GDAL OSM driver, ~1 min) |
| `data/raw/wikidata/zg_wikidata.parquet` | `uv run python -m pipeline.zagreb_wikidata` (query.wikidata.org, ~1 min) |
| `data/raw/dem/Copernicus_DSM_COG_10_N45_00_E01{5,6}_00_DEM.tif` | `https://copernicus-dem-30m.s3.amazonaws.com/<name>/<name>.tif` |

Overpass is not reachable from this laptop; the Geofabrik PBF replaces it.

## 2. Build (about 3.5 min)

```bash
cd engine && HFH_NO_CURRENT=1 uv run python -m pipeline.run s01_zagreb s03_tiles s04_base s07_labels s14_search s99_validate -- --version v20261021-city
```

`HFH_NO_CURRENT=1` writes the version without switching `web/data/current.json` (still `v20261020`, the Donji grad pilot). Drop it, or edit `current.json`, to make the whole city the live version. The pilot build is `SOURCE = SOURCE_PILOT` in `pipeline/city.py`.

## 3. Serve and check

```bash
cd engine && python scripts/serve.py 8642                            # serves current.json's version
cd engine && python scripts/serve_version.py 8643 v20261021-city      # serves web/ with current.json pinned to one version
export PATH=/c/Users/jurec/portable/node-v26.8.2-win-x64:$PATH
node scripts/zagreb_city_check.mjs http://127.0.0.1:8643/ ../data/checks   # errors, failed requests, load time, landmark cards, city_home.png
node scripts/zagreb_card.mjs http://127.0.0.1:8643/ 92387                   # one card's text (92387 = the cathedral)
uv run python scripts/zagreb_pixels.py ../data/checks/city_home.png         # pixels per period colour
```

Last run (2026-10-21, headless Chromium with SwiftShader): no console errors, no failed requests; the map opens after 6.3 s and the whole city has streamed in by ~14 s; 20.7 MB transferred in 182 requests. The version folder is 17.7 MB (packs 11.2 MB gz, attrs 2.8 MB gz, first load 3.5 MB).

## What the whole-city build does (2026-10-21)

1. **Parts → buildings.** 357,540 ZG3D parts inside Grad Zagreb (OSM admin_level 4; 133 broken parts with Z under 95 m a.s.l. are left out) become 297,377 buildings. Parts whose representative point lies in the same OSM building polygon share one gid, card and year (30,712 buildings have several parts; HNK was 17 cards and is now one). The footprint is the union of the parts, drawn at the lowest part's top. Every taller part is drawn as a part of that building through `data/towers.parquet` and s03's existing `partStart` (`city.BUILDING_PARTS`: no Lantmäteriet credit, kept on private houses, not cut). The card gives the tallest part's height (`top_max`).
2. **Years** (`pipeline/zagreb_city.py`), best source first: ZBSM heritage rows, then other ZBSM rows, then Wikidata (architectural-structure classes only; the point inside the footprint or within 10 m), then OSM `start_date`. Spans follow husforhus: one year is EXACT, a span of 15 years or less is RANGE and shows its last year, a longer span is LONG and shows its first. The two named cadastre-before statements become BOUND with `year_from = 0` and `year = year_to = 1968 / 2007`: they join the film and ordinary histogram at that bound, distinct from UNKNOWN and estimates. Their two classes are counted separately in `bounds` and `stats.byBound`, and s99 checks them against the files. Centuries and other vague 'before X' text are not treated as years. 37 disagreements of more than 10 years are in `data/year_disagreements.csv`.
3. **Estimates**: husforhus' kNN tier, houses only. A cell needs at least 30 tests, at least 70% in the right period and a band of 15 years or less. Zagreb has no property designations, so the held-out blocks are 1 km grid cells (`ESTIMATE_BLOCK_M`; with 250 m cells, ZBSM's dated ensembles leaked into their own test). One cell passes (house × 1919–1945 × inner city: 72 tests, 100% right, ±5 years), giving 4,183 estimates.
4. **Privacy**: kategori "house" covers the OSM house types plus small unnamed residential or untyped buildings (≤250 m², ≤12 m). These show only the decade, with no name, no Wikidata or Wikipedia link and no architect.
5. **Base map**: the land is the city boundary. Water is the OSM water areas (Sava, Jarun, Bundek …), cut into 1 km pieces, each at the DSM's water level. Terrain comes from ZG3D Z_Min near buildings and from the Copernicus DSM (min-filtered) elsewhere, up to 920 m above the 100 m datum on Medvednica. Street labels sit on OSM centrelines and river names on OSM waterways. Search knows the 17 gradske četvrti plus aliases. Addresses come from ZBSM, OSM building tags and OSM address nodes.
6. **Viewer**: `app.js` opens the map once the 4 centre-most packs are drawn (`revealPacks`) and streams the rest in (headless: 60 s → 6 s). `CITY_REACH_M` is 25 km. User-visible Donji grad/pilot strings now say Zagreb. `card.prot.2` reads "Protected cultural property (Register of Cultural Goods)". `news.json` describes this build.
7. **Validation relaxations** (`city.VALIDATE`, read by s99): first load 4.5 MB (was 2.5) and whole city 18 MB (was 8), since Zagreb has 3.8× Stockholm's buildings; terrain and ground up to 1,000 m (was 250/200 m) for Medvednica; building height up to 250 m (was 200) for TE-TO's 203 m chimney; building-part height 0.3–400 m (was 5–400 m, a laser-tower rule). `check_towers` skips the private-house and Lantmäteriet-credit checks when the parts are the building's own, and `_outline` make_valids each ring. `sources.yml` adds ZG3D for the whole city, OSM (ODbL), Wikidata (CC0) and the Copernicus DEM (`LicenseRef-Copernicus`, pending-O1).

## Coverage (v20261021-city)

297,377 buildings:
- 2,446 dated from records (0.82%): 1,127 exact, 980 range, 339 long. By source: ZBSM 2,210, Wikidata 162, OSM 74.
- 4,183 estimated (1.41%).
- 290,748 unknown (97.77%).

Matches per source before priority: ZBSM 2,210 buildings (2,369 of its 6,388 rows have a real year); Wikidata 267 (364 dated structures, 343 with year or decade precision, 272 matched to a footprint); OSM 316 (432 tagged, 362 parseable). Reports: `data/zagreb_report.json`, `data/accuracy.json`.

## Still missing / known problems

- Years are still the bottleneck. The next data build can retain the source's 4,014 ZBSM-level 'prije 1968/2007' rows as BOUND (what survives matching has not been built here), keeping `year_from = 0` instead of turning them into construction years. They never train, test or feed the neighbour estimate. `web/data/current.json` and the existing production data remain unchanged.
- The estimate tier's independent check (buildings dated only by Wikidata or OSM) is too small to measure: the rule would estimate 3 of them and get 1 right. All 4,183 estimates come from one cell, so keep an eye on them.
- The cathedral shows 1879: ZBSM gives the complex 1879–1902, and a span over 15 years shows its first year. A curated tier (s08_landmarks) would fix single landmarks like this.
- 183,544 buildings have no OSM footprint and stay single ZG3D parts. An OSM building polygon that covers several houses merges them into one.
- Some ZBSM architect strings are messy ("Šafranek i Weisner"-1891 dogradnja).
- The language switch is off; Croatian sits in the `sv` slot. Before going public: a maker and contact for About, plus checks of the ZG3D and Copernicus licences.
- The web unit tests that check Stockholm values still fail (they were not re-run for this build).
