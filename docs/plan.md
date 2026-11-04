# The plan

Written 4.11.2026, for the night's work and the rounds after it. Read this first, then the PR that carries it.

## What you asked for, taken apart

Your message is one paragraph with about fifteen different jobs in it. Separated, they are these, with where the map
stands on each:

| The ask | What it means in code | Today |
|---|---|---|
| 1/1 layout, true building size | footprints and heights from the city model, nothing rescaled | works. 298,675 buildings. Not yet checked against the orthophoto at a few landmarks |
| Roads visible | OSM ways drawn as ribbons with a kerb | **fixed tonight.** The triangles were wound clockwise and three.js culled every one of them |
| Pavements and green areas | a kerb band either side, the vegetation layer for parks | pavement bands work. Parks are a flat colour, not a surface |
| A skin on the buildings | window grid, floor bands, plinth, roof tone, in metres | works at street level. No photographic texture: that needs a licence |
| Ride a tram | camera behind a live tram, following its own shape | works. No night version, no sound, no next stop on screen |
| Buildings fall from the sky on play | `uPlaying` drops each building in as the film passes its year | exists. Not verified on the live site since the port |
| Fast, monolithic, usable | one static page, one data folder per version, no server | no measured budget. The byte-budget check points at a script that does not exist |
| Truthful | every claim and colour has a source | every colour in the streets is measured now, with the crop it came from |
| Fun | film, looks, poster, quests, walks, ride | all exist. Most are unknown to a first visitor |
| CI/CD | lint, tests, deploy on main, PRs | **green tonight** for the first time since the port |
| PRs, not pushes | every change through a review, merged when green | #3 merged tonight, this plan rides in #4 |

## Why it can win, and what the others do

The city digital twins that look best online are heavy: VU.CITY ships models built for planning departments, Cesium
based twins (xD Twin, the Colombo portfolio project) stream tiles from a server and need a backend, TwinCity3000 reads
CityGML district by district. Their strength is georeferenced truth and analysis; their cost is a 100 MB tab and a
licence.

The thing this map can do that they cannot: one static page, no server, no login, 298,675 real buildings, a film that
plays the city into existence and a tram you can ride. What to steal from them: Cesium's honesty about the projection
(EPSG:3765 here, and say so), VU.CITY's what-if readability, CityGML's semantics, which we already carry as year, use
and storeys per building.

## The principles I am holding to

1. The city is the data; the page is a camera on it. Nothing decorative that is not also true.
2. Every number in a claim is measured, and the command that measures it is in `features/`.
3. A broken thing fails in CI, not silently in the page. That is what tonight's gherkin fix was for.
4. The lazy fix that works beats the clever one that needs a paragraph to explain.
5. Nothing ships unverified. If it was not seen, it is not done.

## The rounds, in the order I would do them

**R0, tonight.** CI green, streets visible in Zagreb's own colour, the gherkin harness telling the truth, a plan.
Done, see below.

**R1, speed.** You asked for fast and for numbers, so first measure and write the budget down: first paint, the moment
the city is complete, the byte count, the frame time on this laptop and on a phone. Then cut what the measurement
blames. The lever is almost never the buildings, it is what is fetched before the first frame and what is drawn every
frame. Ends with `features/load.feature` passing on real numbers instead of pointing at a missing script.

**R2, the ride.** The camera smoothing, night with the lamps the streets layer already builds, the rails' sound, the
next stop on screen, and the line and direction of the tram you are on. Ends with a scenario that rides ten trams in a
row without a stall or a lost camera.

**R3, the film.** The drop-in exists; make the timeline scrub as good as the play, add the two and a half minute
version, and make the first visit start the film instead of showing a static city.

**R4, a truth pass.** Ten landmarks against the orthophoto: St Mark's, the cathedral, the Croatian National Theatre,
Zagrepčanka, Mamutica, the Faculty of Philosophy, the Railway station, Mirogoj, the Arena, the Botanical garden. Height,
footprint, roof. Any that disagree get fixed or the data page says why.

**R5, reach.** Keyboard, screen reader, phone held sideways, a 2019 phone on 4G. The map is a public good for the city
it draws, so it has to open on the phone of a student on a tram.

## What changed tonight, and how it was verified

* The street layer draws. `ribbon()` emitted `(a, a+1, a+2)` and `(a+1, a+3, a+2)`, which is clockwise seen from
  above, so every triangle was culled: 0 to 500 changed pixels in a 540,000 pixel frame for weeks. Wound the other way,
  the same frame changes by 69,165 pixels, that is 7.5%. Verified in a tram ride on the local build: asphalt with the
  rails set into it, kerbs, pavements, the tree line, windows on the walls.
* Streets in measured colour: asphalt #4f5450, kerb side pavement #8d908e, plaza granite #7d817b, from free imagery
  of Donji grad, Ilica and Jelačić square (Esri 0.21 m/px, DGU orthophoto 0.5 m/px, Croatian Open Data Licence). The
  crops and every measurement are in `reference/zagreb_ref/` on the laptop, not in the repo.
* CI green. Lint had 23 errors and the job stopped there, so no test had run in CI since the port. Now: lint clean,
  963 Python tests pass, 465 web tests pass. 387 Python tests and 40 web tests still assert Stockholm and are listed
  and counted on every run instead of quietly skipped.
* The gherkin harness was running the first word of every check command (`node`, `grep`) and nothing else, so checks
  that needed arguments failed for the wrong reason and two inverted grep checks passed without testing anything. It
  now runs the whole command, treats `@check:manual:<what>` as manual, and reports 0 failing with every scenario either
  passing or visibly pending.

## What is not done, said plainly

* No load numbers yet. R1 is the next round for a reason: everything else is guesswork until it is measured.
* 387 Python and 40 web tests are listed as not ported. That list is the debt, not a solution.
* No night ride, no sound, no next stop on screen.
* Parks are a flat colour.
* The reference imagery is on the laptop only. It cannot be committed (30 MB, and most of it is licensed for viewing,
  not redistribution) and it must not be, but the numbers measured from it are in the code with a comment each.
