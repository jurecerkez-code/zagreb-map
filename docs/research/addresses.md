# Address sources and coverage (issue #30)

Checked against the actual `v20261103-fix` table and every `search/addr/*.json` shard on 2026-11-08.
This is a measured partial implementation, not a claim that the 95% coverage target was met.

## What is actually covered now

| measurement | buildings with an address | denominator | coverage |
|---|---:|---:|---:|
| valid, non-withheld rows in the real `addresses.parquet` | 30,527 | 298,675 | 10.2208086% |
| same, footprints over 30 m² (strictly greater than 30) | 30,042 | 195,245 | 15.3868217% |
| union of real `[number,gid,district]` pairs in all 26 public shards | 30,527 | 298,675 | 10.2208086% |

The table has 37,797 distinct valid address rows; the shards have 37,523 valid pairs, zero unknown gids and zero
invalid pairs. These are distinct-building counts, not counts inferred from filenames, house-number strings alone,
`kategori`, parts, or the header of the index. Withheld rows do not count as covered. Without new citywide geometry-
verified address assignments, **30,527 remains the measured coverage baseline**, and the 95% goal is unmet.

Reproduce, from the engine directory, with its own real data:

```bash
uv run python -m pipeline.address_sources \
  --buildings data/buildings.parquet --addresses data/addresses.parquet \
  --search web/data/v20261103-fix/search/addr
```

## Sources checked

### 1. DGU Registar prostornih jedinica (RPJ)

- **Content and format:** the official [INSPIRE address WFS
  capabilities](https://geoportal.dgu.hr/services/sla/inspire/wfs_ad/wfs?request=GetCapabilities&service=WFS&version=2.0.0)
  answered HTTP 200, with `wfs_ad:Address`, `AdminUnitName`, `PostalDescriptor`, and `ThoroughfareName`. A bounded
  `GetFeature` request for only three addresses answered HTTP 403. `https://geoportal.dgu.hr/services/sla/rpj/wfs`
  itself also answered 403 for GetCapabilities. Capabilities alone therefore do not establish accessible features,
  and no `authKey` or credential was solicited or used.
- **Anonymous alternative:** the official [Atom address feed](https://geoportal.dgu.hr/services/atom/ad/xml) answered
  HTTP 200. It links one nationwide [INSPIRE GML 3.2.1 ZIP in ETRS89/LAEA
  (EPSG:3035)](https://geoportal.dgu.hr/services/atom/INSPIRE_Addresses_(AD).zip), declared 84,406,413 bytes,
  updated **2026-11-01** (feed updated **2026-11-02**). Its subtitle explicitly lists house number, building, street
  and settlement. The whole-country archive was **not downloaded** because it is unnecessary for a bounded test.
- **Terms / blocker:** the Atom feed states `ograničenje javnog pristupa prema članku 13 stavku 1 točki (e) INSPIRE
  Direktive` (public-access restriction under INSPIRE Article 13(1)(e)). The [official data/services
  page](https://geoportal.dgu.hr/cms/podaci-i-servisi/) describes address Atom download as anonymous, while address
  WMS is registered. It does not, from the responses checked here, grant a blanket republication licence for a derived
  address index. **Needs human:** an authorized DGU/geoportal account for feature-service access and/or written DGU
  confirmation of the download and derived-publication terms. No registration or e-mail was performed.

### 2. Grad Zagreb Geoportal / ArcGIS

- **Content, format and access:** the anonymous, query-only public [RPJKucniBroj FeatureServer
  layer](https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/RPJKucniBroj/FeatureServer/0)
  returned a count of **136,448 points**. Its fields are `OBJECTID`, `KB` (house number), `UL_JID` (street ID),
  `UL_IME` (street name), `NA_IME` (settlement), `GC_IME` (district), and rotation. The service's spatial reference is
  **EPSG:3765**. GeoJSON query output in EPSG:4326 works. `maxRecordCount=2000`; stable object-ID pages or spatial
  pagination would be required instead of assuming one response is the city. This layer has a point address, **not a
  building footprint, building identifier, or authoritative address-to-building relation**.
- **Last edit reported by the service:** `dataLastEditDate=1719406350508`, **2024-06-26T12:52:30.508Z**. This is the
  reported service metadata timestamp, not an independently verified cadastral effective date.
- **Bounded real validation:** an envelope query in EPSG:3765, ordered by `OBJECTID`, saved 20 records in the root
  scratch queue as `issue30-rpj-sample.geojson` (outside the Git branch). `read_rpj` preserved its source values and
  record IDs and reprojected explicitly to the building CRS. All 20 were covered by exactly one footprint, producing
  20 matched rows on 20 distinct gids. Merging into a read-only copy of the current table added **13 new gids**
  (30,540 in this sample union). No citywide improvement is estimated from this deliberately bounded sample.
- **Terms and permission:** the ArcGIS item is `access=public` and allows anonymous `Query`; its `licenseInfo`, item
  `accessInformation`, layer `copyrightText`, and service `copyrightText` are empty ([ArcGIS item
  metadata](https://www.arcgis.com/sharing/rest/content/items/15e459400c774a8bafc4393b3435413f)). Public GET access is
  not an open-content licence. Grad Zagreb approved reuse of the layer for this project on 2026-11-10; the permission
  is recorded in `pipeline/sources.yml` (`gz_rpj`) and the required credit is **"Grad Zagreb"**. The source is named in
  the attribution shown by the map. The project publishes a derived address/search index, not a redistribution of the
  raw points.
- The local adapter downloads nothing. The permitted full extract was fetched to
  `../data/raw/zagreb/rpj_kucni_broj.geojson` (136,448 points) and is not committed.
- The [Geoportal catalogue](https://geoportal.zagreb.hr/) describes house-number layers in its cadastre/RPJ map. The
  tested ArcGIS feature layer is concrete evidence of a usable schema; the permission above is the release basis.

### 3. Existing OSM / Geofabrik and ZBSM

- **OSM:** `pipeline/sources.yml` already records the Geofabrik Croatia extract, © OpenStreetMap contributors,
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) with modified data and attribution. The local extract has
  17,573 address point rows. Its original PBF timestamp was not falsely inferred from the filesystem timestamp.
- The new OSM extractor retains `n<OSM node id>` as source evidence. The real bounded-to-existing-source measurement
  found **6,062 distinct buildings matched**, **55 ambiguous source records**, **4,545 outside records**, and **7
  invalid/no-number records**. There are duplicate OSM elements/coordinates, so evidence-record totals are not distinct
  building totals. The strict matcher includes a uniquely covered boundary point; three gids not selected by the old
  inside-only predicate were recovered, while 41 old smallest-overlap gid choices were held back. This comparison does
  not claim a total city coverage delta because direct ZBSM and tagged-building rows already overlap the point rows.
- The old city-point path chose the smallest polygon for an overlap and the generic engine has nearest-distance helpers.
  New Zagreb RPJ/OSM address-point attribution does neither: one cover candidate is accepted; zero candidates is
  outside; multiple candidates stay unattributed with all candidate gids in local evidence. Non-address proximity
  helpers (privacy/takedown or plaque placement) are not repurposed as ownership evidence.
- **ZBSM:** the [Zagreb Building Stock Model](https://doi.org/10.5281/zenodo.13602015) is a research building-stock
  model, not a newly discovered official cadastre. Existing attribution and **CC BY-SA 4.0** are retained. Direct ZBSM
  address strings and addresses tagged on the matched OSM building remain tied to their existing joins; they are not
  retrospectively relabelled as `inside` or given invented source/match fields that the old table lacks.
- **`addr:interpolation`:** used, from numbered ends only (see "Measured coverage" below). A way expands when both of
  its ends carry a number — from an endpoint node, or, as Zagreb's Overpass extract has no node ids on its 22 ways,
  from the nearest address point within 20 m of the end vertex. 110 numbers came out of 22 ways and 13 reached a
  footprint; no number is placed without a mapper's number at both ends.

## Street normalization: what was and was not done

The shards contain **3,140 street keys**. Applying the lossless, diacritic-folded descriptor lookup rule identifies
**403 shared lookup-key groups** and **349 bare-name / `* ulica` pairs**. These are lookup collisions, **not proof of
  canonical equality**. The issue's reported 336 pairs are not turned into a fabricated canonical-answer fixture.
  Official `UL_JID` / OSM street-way corroboration is still needed to choose canonical display names and resolve real
  `Cesta` versus `Ulica` versus locally distinct names. Consequently the `0 streets under two canonical names` gate
  remains open rather than being satisfied by deleting distinctions.

Implemented, without changing the lazy shard schema:

- shared Python/JavaScript folding covers Croatian `đ` as well as decomposable diacritics, Croatian postcodes/city tail;
- `ul.` / `ulica` and other generic descriptors generate **search aliases only**; canonical street records and semantic
  `Ulica`/`Cesta` distinctions are not silently merged;
- exact street+number and number+street search works for ASCII-folded street names, plain/alphanumeric suffixes and
  lowercase or mixed-case stored suffixes;
- range/slash forms keep their source meaning; approximate matches are labelled near and never counted as exact
  examples. Exact results on split `Adamičeva` and `Adamičeva ulica` are checked in both search directions;
- plain queries can find both spelling families but a non-exact result on one spelling does not obscure an exact hit
  on its spelling alias. Unrelated streets remain rankable separately (e.g. `Hornsgatan` / `Hornsbruksgatan`).

## Evidence, privacy, and remaining gaps

`data/address_evidence.parquet` (local build output, not a public `web/data` file) stores source, source reference,
street identifier when supplied, match kind, candidate gids and matched distance (zero for actual coverage). It omits
owner/person fields. The public addresses and search schema remain only `gid`, `street`, `number` and the existing
privacy `withheld` flag. `source` and `withheld` are not alternatives: OSM/Grad Zagreb cadastral addresses coexist
under the same privacy/takedown merge. A new source can never un-withhold a building.

## Measured coverage, 2026-11-10 (whole city, real data)

`python -m pipeline.zagreb_addresses` over `engine/data/buildings.parquet` (298,675 footprints), the OSM address
points, the OSM street ways plus the PBF's `zg_osm_streets.parquet` (21,862 named ways for the whole city, where the
dense Overpass box misses the periphery), the 22 `addr:interpolation` ways, and the permitted Grad Zagreb
`RPJKucniBroj` extract (136,448 points). Denominators are the issue's. The source credit is **"Grad Zagreb"**.

| | before | after, house number | after, number or street reference |
|---|---|---|---|
| all 298,675 | 30,527, 10.22% | 117,345, **39.29%** | 282,995, **94.75%** |
| over 30 m²: 195,245 | 30,042, 15.39% | 115,803, **59.31%** | 187,325, **95.94%** |

- The 95% gate is met over 30 m² (187,325 of 195,245; 7,920 neither) and is not met city-wide (94.75%; 15,680
  neither). Those are real counts, not rounded up.
- RPJ matching: 136,448 points, 133,089 unique `inside` or `near` covers, 931 ambiguous covers, 2,428 outside every
  footprint, 114,744 distinct buildings matched. The remaining points are unmatched or duplicate addresses.
- The 80% house-number gate is **not reachable with this register**: 136,448 points cannot cover 195,245 footprints
  over 30 m², so the arithmetic ceiling is 69.9% even if every point were unique. The measured 59.31% is the real
  result; no number was invented and no near number was promoted to an exact one.
- Slash addresses are one identity (`102A/1` is not `102A` plus `1`); the parser and `findNumber` keep the whole form,
  so the exact row wins and a base-number row is marked `near` only when the exact form is absent.
- `e2e/address.spec.mjs` passed over 30 addresses sampled from this build with a fixed seed. The sample is stored in
  `e2e/fixtures/addresses.json`; each search flew to its own `gid` and opened the card. The About and search coverage
  sentences read `index.addressed` and `index.street_ref` from the same build.

