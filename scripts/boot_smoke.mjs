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

// The compass is the project's own ghost: three generations of "works on the first press, never again" reached the
// live site and kept coming back. Real clicks, a quarter-turn away from north between them, must land on azimuth 0
// every time; document-level capture lets the handler outlive the header's redraws (the first era's bug), and the
// instant-snap design has no turn state to stick (the second era's).
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
let northOk = true;
for (let i = 0; i < 3; i++) {
  if (i) {
    await page.evaluate(() => {
      const { camera, controls } = window.__dbg;
      const dx = camera.position.x - controls.target.x, dz = camera.position.z - controls.target.z;
      camera.position.set(controls.target.x - dz, camera.position.y, controls.target.z + dx);
      controls.update();
    });
    await page.waitForTimeout(300);
  }
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(600);
  const a = (await az() % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const off = Math.min(a, Math.PI * 2 - a);
  if (off > 0.03) { northOk = false; console.log(`  press ${i + 1}: azimuth ${off.toFixed(3)} from north`); }
}
report(northOk, 'compass: three presses, three norths, with real clicks');

await browser.close();
console.log(failed ? `boot smoke FAILED (${bad.length} bad responses, ${pageErrors.length} page errors)` : 'boot smoke passed');
process.exit(failed);
