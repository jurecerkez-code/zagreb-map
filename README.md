# Zagreb, building by building

[Open the map](https://jurecerkez-code.github.io/zagreb-map/) · [Source on GitHub](https://github.com/jurecerkez-code/zagreb-map)

![Zagreb, building by building](web/og.png)

An interactive 3D map of Zagreb: buildings, streets, terrain and trams. Built from public data and served as a static page on GitHub Pages.

## Use it

- Move through **1200 to 2026** on the timeline, with **six construction-period classes**. Unknown stays explicitly unknown.
- Click a building for its recorded year or period, source, height, floors and available address details.
- Search streets, addresses, districts and known buildings.
- Switch between English and Croatian, or use `?lang=en` and `?lang=hr`.
- Open history scenes and monuments, follow live trams, and download a postcard.
- Move with drag, turn with Ctrl-drag or right-drag, zoom with the wheel or `+` and `−`, and use arrow keys to pan.

No account or application server is required for normal map use. The viewer is `web/` plus data packs. No frontend build step or bundler is needed.

## Current data

The checked-in build is `web/data/v20261110-roofs2/`: the whole city with 3,824 buildings bounded by the cadastre's two registers (before 1968 and before 2007), plus the compact road, tree and gzip layout. It is ~55 MB on disk.

| Measure | Count |
|---|---:|
| Buildings | 298,675 |
| Records with a year, range, period or bound | 8,195 |
| Bounded before 1968 | 2,769 |
| Bounded 1968 to 2007 | 1,055 |
| Explicitly unknown construction years | 290,480 |
| With a house number | 117,345 (39.3%) |
| With a number or a street reference | 282,995 (94.75%) |

A period is not an exact construction year. Where reliable records are absent, the building is marked **Unknown** instead of inventing one. The city does not record exact construction years for most buildings.

Heights come from the city's 3D model and OSM attributes. The project uses real roof geometry rather than estimating every building as a box of a single height.

## Run the current build locally

```bash
python scripts/serve.py 8643
```

Then open [http://localhost:8643](http://localhost:8643).

The server script serves the static viewer and optional live-vehicle data. If the live endpoint is unavailable, the app uses its stored snapshot and timetable data.

## Rebuild the data packs

Install [uv](https://docs.astral.sh/uv/) first. `uv` installs the project's Python version and dependencies.

```bash
uv sync
uv run python -m pipeline.run --list
HFH_NO_CURRENT=1 uv run python -m pipeline.run s01_zagreb s02_lod2 s02_zagreb_curated s03_tiles s05_zagreb_monuments s04_base s07_labels s14_search s99_validate -- --version vYYYYMMDD-x
```

The pipeline reads source files under `data/`, joins official city geometry with OSM, Wikidata and curated landmark sources, and writes compressed geometry, road, vegetation, terrain, monument and search datasets under `web/data/`.

`HFH_NO_CURRENT=1` keeps the current preview version untouched. After the validation steps pass, review the generated version before selecting it in `web/data/current.json`. Never run `s01_zagreb` alone and skip the following steps when you want a working city: it renumbers building IDs that later sources must join against.

Every fetched file needed by the app must be included in the deployment. `uv run python scripts/checks/site_fetches.py` reports missing resources before that becomes a public 404.

## Verify changes

```bash
uv run pytest -m "not legacy" -q
npm ci
node scripts/web-tests.mjs
```

The web runner uses the repository's explicit upstream-inventory list. Tests written for Stockholm remain marked separately from Zagreb regressions rather than being counted as Zagreb failures.

Real-browser checks require Playwright's Chromium download once:

```bash
npx playwright install chromium
npx playwright test
```

For example, Croatian font coverage has a dedicated self-hosting test:

```bash
npx playwright test e2e/fonts.spec.mjs
```

`node scripts/boot_smoke.mjs` checks a running map for startup errors, missing data packages, counts and basic navigation.

## Sources and licences

The canonical source and licence inventory is [`pipeline/sources.yml`](pipeline/sources.yml). Keep the required attribution with the data. Code has its own MIT licence in [`LICENSE`](LICENSE); datasets do not automatically inherit it.

The rendering lineage is [Amsterdam, building by building](https://github.com/alexbarakov/amsterdam-by-building) and [Hus för hus](https://github.com/amirelion/husforhus), with Three.js. The application data includes **Grad Zagreb**, **OpenStreetMap contributors**, and the other sources listed in the canonical inventory.

Self-hosted font files and their SIL Open Font Licence texts live under [`web/fonts/`](web/fonts/). Croatian diagnostics verify the actual Latin-extended font downloads, not merely the ability to draw those letters with a system fallback.

## Contribute

Use this fork's [issue tracker and pull requests](https://github.com/jurecerkez-code/zagreb-map/issues). Do not add a year by guessing it or present a period as an exact year. New records need a source, a licence and a working join to existing IDs. Run the validators and browser checks before proposing a merge.

For performance, rendering, deployment, geometry and data limitations, see the issue plan in `docs/plan.md` and the active repository branches.
