# Zagreb Lab worksheet

Issue: [zagreb-map #34](https://github.com/jurecerkez-code/zagreb-map/issues/34). The page chrome is deliberately separate from the map renderer, period gateway and elevation pipeline.

## Public references actually read

| Reference | Official source read through GitHub's public contents API | Content identity at inspection | What was used |
|---|---|---|---|
| PiEEG Home Lab | [`jurecerkez-code/pieeg-home-lab/page/assets/style.css`](https://github.com/jurecerkez-code/pieeg-home-lab/blob/main/page/assets/style.css) | Git blob `4e6f4ac8f3be85eb24840959ed4f682f3363645f` | `Lab theme` tokens (`navy`, `navy-lit`, `panel`, `ink`, `muted`, gold, lavender); Radix Inter variable-font usage; uppercase module labels; small fade; `framed` overlay; `--radius-chip` / `--radius-ctrl` |
| Calliope | [`jurecerkez-code/calliope/src/app.css`](https://github.com/jurecerkez-code/calliope/blob/main/src/app.css) | Git blob `833d4f526ec65ababe3ab701dba3a5babcefd284` | Paper ground/panel/ink/muted, red active/filed action, blue source, light ink, uppercase `Back`, counters, thin metadata overlay, translucent chips, fallback Sans/Mono families |

These hashes are GitHub **content-blob SHA-1s**, not claims of repository commit ancestry. The Lab is a new design application to Zagreb, not a claim that the references previously shared a layout. No reference JavaScript, symbols, names in chrome, telemetry or third-party layout package is copied into the map.

PiEEG's public repository does not declare a homepage in its GitHub metadata. Its local `page/` source is therefore the reference candidate for a later side-by-side screenshot, rather than an invented public deployment URL.

## Two chrome roots, one map

`web/zagreb-lab.js` exports the shared token objects and the `chromeKind()` decision:

- **Lab** (`data-ui="lab"`): the default Foto scene, the `lab` look, `blatimme`, and future looks not explicitly choosing Paper.
- **Paper** (`data-ui="paper"`): `arg` / Patina, `kalk` / Limewash and `paper` / Classic.

A remembered scene does not determine chrome independently: selecting a scene selects its declared chrome. Paper restores the previous control layout. Lab keeps the map period bands and uses a navy worksheet ground.

| Token | Lab | Paper |
|---|---|---|
| `--bg` | `#0b0d33` | `#F4EFE6` |
| `--panel` | `#11144a` | `#FAF7F1` |
| `--ink` | `#ecebf7` | `#171717` |
| `--muted` | `#9a9ccc` | `#77716A` |
| `--accent` | `#d8b55a` | `#FE2A00` |
| `--link` | `#8f96ff` | `#2F5FAE` |
| `--line` | `#2b3170` | `#E5DED2` |

`--card-bg`, `--card-ink` and `--card-ground` are also explicit in the shared objects. `--sky` always comes from the selected map look; the timeline, modes and legend use that variable rather than a late opaque theme block. `applySky()` also updates the CSS token when weather or sun changes the actual sky. `--surface-overlay` is the translucent chip layer; `--radius-chip` is `999px`, `--radius-ctrl` is `12px`, the issue's panel radius. The static spec row prints the real token values and Inter, not live or measured readings.

Paper adds `--muted-content:#665f58` and `--accent-content:#a82009` for small text. The exact reference `--muted:#77716A` is only 4.211:1 on the Paper ground and `--accent:#FE2A00` is 3.307:1 there, so using those accents indiscriminately for 10px labels would reduce accessibility. The derived text inks hold more than 4.5:1 on the ground and panel; the bright red remains available for graphic accents and active styling.

Inter uses a local optical-size cut and JetBrains Mono supplies the instrument values. Both are bundled in latin and latin-ext subsets, with local licences. The JetBrains Mono files come from `@fontsource-variable/jetbrains-mono` 5.2.8. There is no font CDN.

## Scene palette

`THEMES.lab` is a sibling of the existing looks in `web/themes.js`:

- Foto remains the default map under Lab chrome; `lab` is another offered map look in the existing Look dialog.
- Its violet-to-gold ramp is `#2d1b49`, `#583870`, `#4e3db9`, `#5c5cff`, `#8f96ff`, `#d8b55a`, chosen to meet the shared ordinary/CVD period and estimate checks.
- Unknown is `#2b3170` with a deliberate `#3d4791` hatch. The existing shared shape tests recognise Lab alongside Patina and Foto.
- Land is `#11144a`. The reference water `#161a78` needs only a small blue lift to clear slope checks; `#161a84` retains that navy identity. The tested `#4c4a4b` quay is preserved.
- Floors use `#536eaa`, `#849cc5`, `#bfc8df`, `#fff1cf`. Dates, data and the private-house policy are unchanged.

## Real component integration

- `web/index.html` adds the static spec, `Layers`, `More` and accessible dialog labels. Existing controls remain the app's real controls.
- `web/zagreb-lab.js` moves north, Stories, Postcard, About and language into the native `More` dialog. It retains their DOM nodes and event listeners. Comment placeholders restore the exact original layout for Paper rather than creating duplicate controls.
- The dock is Search · Layers · Look · Sun · More. The sun remains the existing sun-mode control created by `app.js`. Layers opens the existing legend and exposes its expanded state. Search continues through the existing combobox/focus code, presented as an inert-background worksheet in Lab. Look remains the existing native Look dialog. Stories stays in More so its list is reachable; About can close back into More; Postcard dismisses More for its full-page mode.
- On a phone, More becomes a bottom sheet with safe-area padding and a 76dvh limit. Native dialogs keep their semantics; the scoped `trapLabFocus()` adds wrapping for the pinned card and More, which otherwise have no custom focus operation to inherit.
- The same-document mount is cached so it cannot add duplicate controls or listeners. More restores its trigger. Layers forwards to the real sheet and exposes its expanded state. The pinned card still focuses its close control, uses its existing close path and restores its trigger or the map.
- `web/zagreb-lab.css` is scoped load-last material. Panels are bounded glass with solid text inserts; Paper is opaque and non-glass. White/gold frame accents are one pixel high and pointer-inert; the 12px/2px stepped radii and 8px-based gaps are explicit.
- `aboutHtml()` now includes a short translated manual without changing the established factual, sources or privacy sections. The English, Croatian and Swedish fixture dictionaries remain complete.
- Fade transitions and the small live-dot pulse exist only under `prefers-reduced-motion:no-preference`; the badge still reflects real transport state. Reduced motion removes those animations.

Both `web/i18n/en.json` and `web/i18n/hr.json` contain the new control/spec labels. Croatian controls read Traži, Slojevi, Izgled, Sunce, Više and Sjever. The legacy Swedish **test fixture** was extended only to satisfy the repository's existing old-field completeness check; production still ships exactly English and Croatian.

## Evidence boundaries

Static checks also cover bounded focus behavior, translated About output and the ordered card record hierarchy. A pure-white composite behind the prescribed .72 glass is used to challenge small-label contrast; those labels and links use opaque `--ui-surface` inserts, and photo-arrow glyphs receive a contrasting dark ink. These do not replace browser verification of image rendering, overflow or hit areas.

The browser check is the measured one: `glassContrast()` in `e2e/zagreb-lab.spec.mjs` hides a panel, photographs its rect, takes the brightest pixel behind it, composites each text leaf's own background chain over that pixel at .72 glass, and holds 4.5:1 (3:1 for large text). Measured on the whole city at 1440×900 in the Foto look, Chromium:

| Panel | Text leaves | Weakest | Brightest pixel behind |
|---|---|---|---|
| Legend `#panel` | 21 | 6.54:1 | `rgb(217,223,227)` |
| Record card `#card` | 13 | 6.52:1 | `rgb(192,190,184)` |
| About `#about` | 177 | 6.52:1 | `rgb(236,235,247)` |

That measurement found three real failures the token arithmetic had missed, all fixed here rather than argued away:

- the legend's "Hide the N estimated years" switch, the one text control on bare glass, read 3.38:1 over the pale sky — its label now carries `--ui-fg` (7.53:1 there);
- the card head inherited its period band's ink, which is black on the light bands: 2.06:1 on glass — the head keeps `--ui-fg`, and its 12px mono kicker plus "Why?"/"Something wrong?" take the opaque insert (6.52:1);
- the About tab strip read 3.18:1 — it takes the same insert (6.52:1).

`e2e/zagreb-lab.spec.mjs` is an independent Playwright file. It covers tokens and font resources, all five dock controls, Layers and Search behavior, More keyboard containment/focus restoration, Paper restoration, real Croatian labels, phone sizing/overflow, reduced motion, the measured contrast table above, serious/critical axe findings and captured browser/page/asset errors. It is tagged `@zagreb-lab` with accessibility runs also tagged `@design-a11y`. Its `open()` waits up to 180s for the city's 437 packs: the whole city on a software-GL runner is a 15-minute load by `scripts/perf.mjs`'s own note, and a 60s ceiling failed the suite on a loaded laptop for reasons that had nothing to do with the app.

Screenshots of the dressed map at 1440×900 and 390×844 are committed beside the picture-gate baselines in `e2e/__screenshots__/` (`lab-1440.png`, `lab-390.png`). They are evidence, not approval: no physical-device test, performance improvement, historical linkage or production status is claimed.
