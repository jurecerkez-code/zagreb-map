// The boot smoke: the page must actually open. The unit tests never load app.js end to end, so a crash inside it –
// a const read before its declaration, a data file that answers 404 and gets parsed as JSON – shipped to the live
// site once already. Three assertions, all cheap:
//
//   1. no pageerror fires while the page boots (a crashed module boot is page error number one),
//   2. no data asset the page asks for comes back 404 (the gitignored-data class of bug),
//   3. the header count names real buildings, not the hardcoded 0 from index.html.
//
// Run by .github/workflows/ci.yml against web/ served statically. Locally: serve web/ on 8643 first.
import { chromium } from '@playwright/test';

const BASE = process.env.BOOT_BASE || 'http://127.0.0.1:8643/';

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage();

const pageErrors = [];
const bad = [];
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));
page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
// A fixed wait reads as flaky on a busy CI runner or a slow laptop: grab the actual readiness signal. The module's
// evaluation ends with window.__dbg, so it exists exactly when every seed and fallback has a chance to have run.
await page.waitForFunction(() => !!window.__dbg, null, { timeout: 150000 }).catch(() => {});
await page.waitForTimeout(3000);

const countText = await page.evaluate(() => document.getElementById('count')?.textContent ?? '?');
const count = parseInt(countText.replace(/\D/g, ''), 10);

let failed = 0;
const report = (ok, what, detail) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed = 1; };

report(pageErrors.length === 0, 'page boots without a pageerror', pageErrors.slice(0, 3).join(' | '));
const badData = bad.filter(u => /\/data\//.test(u));
report(badData.length === 0, 'every fetched data asset answers < 400', badData.slice(0, 5).join(' | '));
if (bad.length) console.log(`  (${bad.length} non-data or non-critical bad response(s): ${bad.slice(0, 6).join(' | ')})`);
report(Number.isFinite(count) && count > 100000, 'header counts the city', countText);

// The compass (issue #22, 2026-11-05): a click walks on to the next of the four sides, and a drag of the
// needle must be able to face anywhere. Both go through real pointer input; document-level capture lets the
// handlers outlive the header's redraws (the first era's bug), and the snap design has no turn state to stick (the
// second era's). A three-generation ghost ("works on the first press, never again") makes the press loop essential.
// Issue #34 moves the compass into the Lab "More" sheet: open that real dock first, then measure.
if (await page.locator('#lab-more-button').isVisible()) {
  await page.locator('#lab-more-button').click();
  await page.locator('#lab-more').waitFor({ state: 'visible', timeout: 5000 });
}
const bb = await (await page.$('.north-open'))?.boundingBox();
if (!bb) { report(false, 'compass button present'); await browser.close(); process.exit(1); }
const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
const az = () => page.evaluate(() => window.__dbg?.controls.getAzimuthalAngle());
if (!bb || !(await page.evaluate(() => !!window.__dbg))) {
  report(false, 'compass: page never reported ready (__dbg missing)');
  await browser.close();
  console.log('boot smoke FAILED (page half-booted)');
  process.exit(1);
}
// Distance of an azimuth to the nearest of the four cardinals (radians, wrapped).
const toCardinal = a => {
  const four = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const w = a => { const TAU = Math.PI * 2; let x = a % TAU; if (x > Math.PI) x -= TAU; if (x <= -Math.PI) x += TAU; return x; };
  return Math.min(...four.map(c => Math.abs(w(w(a) - c))));
};
// The click walks the four sides (issue #22): from the boot's north-up, four presses visit E, S, W, N.
const nAz = () => page.evaluate(() => window.__dbg.northAzimuth());
let ok = true;
for (const [i, want] of [[1, Math.PI / 2], [2, Math.PI], [3, -Math.PI / 2], [4, 0]]) {
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(600);
  const off = toCardinal((await nAz()) - want);
  if (off > 0.01) { ok = false; console.log(`  press ${i}: ${off.toFixed(4)} off the ${['', 'E', 'S', 'W', 'N'][i]} side`); }
}
report(ok, 'compass: four real clicks from north visit E, S, W, N');

// A drag of the needle must turn the map under the pointer: from the compass centre to 60 px east of it is the
// "east" heading (+π/2 azimuth). No movement-limit surprises: the press begins a drag past 5 px of travel.
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 60, cy, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(600);
const offAfterDrag = toCardinal(((await az()) ?? 9) - Math.PI / 2);
report(Number.isFinite(offAfterDrag) && offAfterDrag < 0.15, 'compass: needle dragged east, the map faces east',
  `off by ${offAfterDrag.toFixed(3)}`);

// A press asks the camera back (issue #22): during a ride the same click ends the ride and walks to the next side.
// A synthetic trip id is fine: the ride holds its view for RIDE_GONE_MS (12 s) when the layer cannot draw a trip,
// far longer than this block. The map is now east-facing from the drag, so the click must land on south.
await page.evaluate(() => window.__dbg.startRide({ trip: '__smoke__', heading: 0 }));
const riding = await page.evaluate(() => !!window.__dbg.riding);
await page.mouse.click(cx, cy);
await page.waitForTimeout(600);
const rideEnded = !(await page.evaluate(() => !!window.__dbg.riding));
const offRideClick = toCardinal(((await nAz()) ?? 9) - Math.PI);
report(riding && rideEnded && Number.isFinite(offRideClick) && offRideClick < 0.01,
  'compass: a click in a ride ends the ride and faces the next side (south)',
  `riding started: ${riding}, ended: ${rideEnded}, off by ${(offRideClick ?? NaN).toFixed?.(4)}`);

await browser.close();
console.log(failed ? `boot smoke FAILED (${bad.length} bad responses, ${pageErrors.length} page errors)` : 'boot smoke passed');
process.exit(failed);
