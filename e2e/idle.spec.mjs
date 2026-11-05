// Issue #23: a settled map with nothing moving draws nothing — renderer.info.render.frame parks, __dbg.rate()
// reads one of 60/30/20/0, and 0 while the city stands still. The animation loop itself keeps ticking (a drag, a
// rescale, an invalidate wakes the map to 60 at once), so the benchmark rides real vsync. Measured in frames, not
// wall time: time-frozen runs would see them shrink, so the freeze comes AFTER the rates settle.
import { test, expect } from '@playwright/test';
import { settled } from './settled.mjs';

// The window the page counts drawn frames over: the low tiers top out at 20 fps, so any second with ≤5 rafs is a
// rest, and an invalidate must show at least one new drawn frame inside its own window.
const rafCount = (page, ms = 800) => page.evaluate(ms => new Promise(done => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(n); };
  requestAnimationFrame(tick);
}), ms);

const drawn = page => page.evaluate(() => window.__dbg.rendered());
const rate = page => page.evaluate(() => window.__dbg.rate());

// Steady tile arrivals hold the map at 60 fps for as long as they stream (each drop invalidates 1.3 s). "Settled"
// means the stream is done: meshes.length unchanged for a couple of seconds.
async function tilesCalm(page, timeout = 480_000) {
  const t0 = Date.now();
  let last = await page.evaluate(() => window.__dbg.meshes.length);
  let unchanged = 0;
  while (Date.now() - t0 < timeout) {
    await page.waitForTimeout(1500);
    const n = await page.evaluate(() => window.__dbg.meshes.length);
    unchanged = n === last ? unchanged + 1 : 0;
    last = n;
    if (unchanged >= 2) return;
  }
  throw new Error(`tiles never calmed down (last count ${last})`);
}

test('the idle tiers: a still map parks at 0 fps, an invalidate draws again', async ({ page }) => {
  test.setTimeout(540_000);
  await page.goto('/?lang=en', { waitUntil: 'domcontentloaded' });
  await settled(page);
  await tilesCalm(page);

  // Rest: let every tier's timer run out (tile drops, the relief rise, the boot's own invalidations). Weather can
  // hold 30 and a tram in frame 20; nothing here forces a tear-down — the assertion below takes the tier as read.
  await expect.poll(async () => Math.max(await rate(page), 0), { timeout: 15_000 }).toBeLessThanOrEqual(30);

  // An idle city parks at 0 fps (a tram in frame would hold 20, falling weather 30; the settled fixture has
  // neither). A burst of tile drops may still be in flight on a slow helper — park until the tiers drain.
  await expect.poll(() => rate(page), { timeout: 20_000, message: 'the still map parks at 0 fps once its tiers drain' }).toBe(0);

  // Frames stop dead while parked: count the drawn frames over a settled window, not the vsyncs (those still tick).
  const before = await drawn();
  await rafCount(page);
  expect(await drawn()).toBe(before);

  // An invalidate draws at least one fresh frame inside its window...
  await page.evaluate(() => window.__dbg.invalidate(700));
  await expect.poll(async () => (await drawn()) - before, { timeout: 3_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => rate(page), { timeout: 700 }).toBe(60);
  // ... and the map falls back asleep behind it.
  await expect.poll(() => rate(page), { timeout: 10_000 }).toBe(0);
});
