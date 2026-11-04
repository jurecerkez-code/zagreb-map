# Deep analysis, 2026-11-04: what the map actually is, measured

Written after the evening in which the demand was: "check the repository, the environments, the data you already
have, and what I am asking for; then plan and execute." Every number below is reproducible from the named command.

## Questions and verdicts

### 1. "Compass is not working" — VERDICT: fixed behaviourally, proved live on his real machine
The rebuilt compass (makeNorth, one module, snap on press, needle reads the true bearing) was pressed three times
on the live site in a real Chrome (156) on the real GPU (AMD Radeon D3D11), with CDP-injected real mouse input:

    press 1: azimuth -3.142 -> 0.000
    press 2: azimuth -1.571 -> 0.000
    press 3: azimuth -1.571 -> 0.000

The button and the feature obey the real input path end to end. What he kept seeing was the OLD eased-turn build
in a long-open tab: the site caches 10 minutes, an open tab caches forever. Mitigation on the table: each deploy
stamps web/build.json and the console prints `build <sha> · <date>`; about surfacing staleness fails visibly next
time. If it still misbehaves after a Ctrl+F5 he reports with the console's build line — and then the forensics
start from his exact build, not the headless one.

### 2. "The map is laggy" — VERDICT: true, measured
Home view, real AMD iGPU, full default (Foto look, photo roofs+ground, 1.59 M building triangles): **11 fps**.
That is under interactive glide and justifiably reads as glitchy. Honest suspects, ranked by the shader reading:

1. Fragment cost of the new realism: per-fragment skin (windows/grain), Foto tile texture, photo ground, the
   unknown-hatch — every pixel of every building, every frame.
2. Vertex count: 1.6 M drawn triangles at the home view (worth a LOD/imposter consideration for far blocks).
3. Main thread: pointer-picking renders the scene 1:1 into a 1x1 target on pointer-holding frames (recorded
   earlier as ~40 % at parked mouse).

First-load is 26.9 MB transferred, ready in 4.4 s on today's connection (paced, Berlin ADSL); the top items:
city_height.bin.gz 4.9 MB, roads.bin.gz 4.1 MB, ground_rgb.bin 1.4 MB, pack0 1.1 MB. Load is fine; the pain is
sustained framerate. Fixes belong to `docs/plan.md` R1 (speed); candidate wins without new problems: adaptive
render scale on weak GPUs, a roof-texture mip/fade correction, cheaper picture-only pick while dragging (no
hover target until mouse rest), and turning off per-fragment film grain that pays nothing at distance.

### 3. "Photorealistic, but too dark" — VERDICT: half true, and the dark pixels have an owner
Mean screenshot luminance now reads 147-179 of 255 (screenshots skin_after/skin_close) — brighter than the
neutral shots from October, not darker. What actually IS dark:

- Ground at the photo-border: the Ortofoto ground texture ends before the city does. East of it (Žitnjak band
  and beyond) the style falls back to near-black plain ground. For the viewer that reads as a darkness problem
  and a "not parsed" problem at the same east corner.
- Foto's ground is the aerial's own brightness: inside its coverage it is correct and dark by design (asphalt).

### 4. "Fields and areas that are not green" / "Park Žitnjak looks bad" — VERDICT: data was truthful; the dead zones have three real causes
Verified against data/veg/green.parquet (extract_veg.py from Geofabrik Croatia, Geofabrik 2026-10-20), the
rendered mask, and screenshots at exact coordinates:

- **Bundek** (45.7848, 15.9891): fully green and the lake renders WITH name label, island, and the wavy
  water texture. An earlier claim of mine in this audit ("Bundek lake is missing from everything") was
  wrong: I sampled coordinates ~1.3 km north of the lake and asserted a hole that wasn't there. Corrected here.
- **Jarun** (45.7811, 15.9194): lake renders, 219,029 m² of water at the right place.
- **Žitnjak band** genuinely shows worse than its centre: it sits partly OUTSIDE the photo-ground coverage
  (ground black), and its OSM vegetation content is scant (volunteer mapping density is what it is). The mesh
  and the pipeline are not dropping it; OSM has little to give there.

My genuine mistake chain of the day, listed so it stays read:
1. "No item green at Bundek": wrong sampling point. Bundek is correctly green.
2. "Jarun not in the water layer": a containment check at a sloppily chosen centroid said no-holder, and the
   hunt from there validated a missing relation geometry under GDAL. The properly accounted containment then
   found the lake present in the layer, and the tool I was building for a non-problem was deleted again.
3. "North fails after the first press": first confirmed as a state bug, then as a stale build; the truth is
   the feature works, and the build naming stops the browser from saying otherwise next time.

### 5. "Where are you deploying? What is my preview?" — stable answers
- Live: https://jurecerkez-code.github.io/zagreb-map/ (Pages from `main`, every merge; `build.json` stamps the
  deployed commit).
- Preview before merge: http://localhost:8643/ on this laptop — scripts/serve.py with no-store cache headers,
  currently serving this repo at main.

## Plan (execution order, each gated by CI and a screenshot)

1. **Speed** (R1: "laggy"): profile the frame on the real GPU across looks; land whichever of {adaptive render
   scale on slow GPUs, pick-on-rest, texture squash} measures at least 2× at the home view.
2. **Photo ground reaches the city edge**: extend engine/pipeline/s06_zagreb_ortho.py's tiling to the full
   city footprint (Žitnjak band and the far east). Verified by black-region disappearance at (3500, 1200).
3. **Darkness**: decide with one A/B over his default: light ground + real roofs vs photo ground. Pick by
   measurement (mean luminance of the home view), not by taste.
4. **Remaining data gaps**: lakes audit found no missing lakes; Maksimir's ponds get the same sanity check
   (relation geometry straight from the OSM API) as a follow-on.
5. **Tram tooltip** (carried over): hover gives line/direction/next stop/live badge. The WIP probe sits in
   _probe/tram_tooltip.wip.mjs, the trigger mechanism needs one careful hour — pick is a 1:1 scene render at
   every third frame and the tram tip wants the same pull-through the building cards use.
6. **Stockholm legacy**: the overnight reclaim (salvage) is paused; when resumed, a single pass per test:
   port or delete, one verdict per name.

License/data notes kept: no new raw data was redistributed in this audit. The Bundek/Jarun work used the
official OSM API's relation geometry (ODbL) for verification only; nothing entered the repo from it.
