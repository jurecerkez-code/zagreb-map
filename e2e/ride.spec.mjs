// Issue #26's ride: the camera rides ON the trip's own shape, smoothly, at tram speed; a dwell of 8+ s reads as a
// stop; a live feed that jumps never makes the drawn position step.
//
// Sampling: the acceptance asks for 100 ms reads. The page may park at 0 fps with nothing moving (issue #23), and
// its own timers coalesce under load, so the sampling clock lives OUTSIDE the page — playwright's waits — one
// evaluate per beat, every 300 ms, with an invalidate keeping drawn frames honest through it.
import { test, expect } from '@playwright/test';
import { settled } from './settled.mjs';

const boot = page => page.goto('/?lang=en&weather=none&tram=1&date=2026-11-05&sun=08:00', { waitUntil: 'domcontentloaded' });

const shapeOf = (page, trip) => page.evaluate(t => {
  const n = window.__dbg.trams.net, s = n.trips[t * 5];
  return Array.from({ length: 4000 }, (_, d) => n.pointAt(s, d * 15, undefined)).map(p => [p.x, p.z]);
}, trip);

function measures(rows, plan) {
  const off = ([x, , z], pts) => {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const f = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + dx * f), z - (az + dz * f)));
    }
    return best;
  };
  let maxOff = 0, maxKmh = 0, dwellStart = -1, maxDwell = 0;
  for (let i = 1; i < rows.length; i++) {
    const [t0, x0, y0, z0] = rows[i - 1], [t1, x1, y1, z1] = rows[i];
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) continue;
    const v = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / dt;
    maxKmh = Math.max(maxKmh, v * 3.6);
    if (plan) maxOff = Math.max(maxOff, off([x1, y1, z1], plan));
    if (v < 0.5) { if (dwellStart < 0) dwellStart = t0; maxDwell = Math.max(maxDwell, (t1 - dwellStart) / 1000); }
    else dwellStart = -1;
  }
  return { maxOff, maxKmh, maxDwell, n: rows.length,
    hudOn: rows.some(r => /\d+/.test(r[4])), frameOn: rows.some(r => r[5]) };
}

test('the ride: on the track, at tram speed, and it really stops at stops', async ({ page }) => {
  test.setTimeout(600_000);
  await boot(page);
  await settled(page);
  await expect.poll(() => page.evaluate(() => (window.__dbg?.trams?.list?.length || 0) > 0), { timeout: 180_000 }).toBe(true);

  // The trip with the EARLIEST next stop after now (a dwell the test can wait for), instead of an hour-of-day window
  // the suite happened to run at.
  const picked = await page.evaluate(() => {
    const trams = window.__dbg.trams;
    const now = new Date();
    const secNow = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    let best = null, wait = Infinity;
    for (const e of trams.list) {
      if (!e.next?.sec) continue;
      const w = e.next.sec - secNow;
      if (w < 8 || w > 660) continue;                        // too soon to hitch a ride, or past the test's budget
      if (w < wait) { best = e.trip; wait = w; }
    }
    return { trip: best ?? trams.list[0]?.trip, wait: Number.isFinite(wait) ? wait : 30 };
  });
  expect(picked.trip).toBeTruthy();
  await page.evaluate(t => window.__dbg.startRide({ trip: t }), picked.trip);
  const ridingNow = () => page.evaluate(() => window.__dbg.riding);
  for (let i = 0; i < 50 && (await ridingNow()) === null; i++) await page.waitForTimeout(100);
  expect(await ridingNow()).not.toBe(null);

  // Settle out of the entry lerp (the 0.35 s ease that seats the camera at the tram), then sample through the
  // picked stop: until now + its wait, plus the stop's own breath.
  await page.waitForTimeout(1_500);
  const sampleSec = Math.min(540, Math.max(35, picked.wait + 45));
  const rows = [];
  const t0 = Date.now();
  for (;;) {
    rows.push([Date.now() - t0, ...await page.evaluate(() => {
      const cam = window.__dbg.camera.position.toArray();
      return [...cam, document.querySelector('.ride-hud')?.textContent || '',
        !!document.querySelector('.ride-frame') && !document.querySelector('.ride-frame').hidden];
    })]);
    if (Date.now() - t0 >= sampleSec * 1000) break;
    await page.waitForTimeout(300);
  }
  const plan = await shapeOf(page, picked.trip);
  const m = measures(rows, plan);
  // The dwell of the model itself, on the tram entity's drawn place (camera measures would blur it): same window.
  const stand = await page.evaluate(async tripId => {
    let last = null, dwellStart = -1, maxDwell = 0;
    const t0 = performance.now();
    for (;;) {
      const e = window.__dbg.trams.list.find(x => x.trip === tripId);
      const now = performance.now();
      if (e) {
        const still = last && Math.hypot(e.x - last[0], e.z - last[1]) < 0.5;
        if (still) dwellStart = dwellStart < 0 ? now : dwellStart;
        else if (!still) { maxDwell = Math.max(maxDwell, dwellStart > 0 ? (now - dwellStart) / 1000 : 0); dwellStart = -1; }
        last = [e.x, e.z];
      }
      if (now - t0 >= 20_000) break;
      await new Promise(r => setTimeout(r, 300));
      window.__dbg.invalidate(400);
    }
    return Math.max(maxDwell, dwellStart > 0 ? 20 - (dwellStart - t0) / 1000 : 0);
  }, picked.trip);
  console.log(`[ride] samples=${m.n} maxOff=${m.maxOff.toFixed(2)} m maxKmh=${m.maxKmh.toFixed(1)} maxDwell=${m.maxDwell.toFixed(1)} s stand=${stand.toFixed(1)} s`);
  expect(m.maxOff, `furthest from the shape: ${m.maxOff.toFixed(2)} m`).toBeLessThanOrEqual(4);
  expect(m.maxKmh, `fastest sampled speed: ${m.maxKmh.toFixed(1)} km/h`).toBeLessThanOrEqual(70);
  expect(Math.max(m.maxDwell, stand), `longest stop inside the window: max(camera ${m.maxDwell.toFixed(1)}s, model ${stand.toFixed(1)}s)`).toBeGreaterThanOrEqual(8);
  expect(m.hudOn, 'the HUD reads the line and the minute').toBe(true);
  expect(m.frameOn, 'the cab frame draws').toBe(true);

  await page.keyboard.press('Escape');
  for (let i = 0; i < 50 && (await ridingNow()) !== null; i++) await page.waitForTimeout(100);
  expect(await ridingNow()).toBe(null);
});

test('a live feed that jumps 150 m never steps the drawn position', async ({ page }) => {
  test.setTimeout(600_000);
  await boot(page);
  await settled(page);
  await expect.poll(() => page.evaluate(() => (window.__dbg?.trams?.list?.length || 0) > 0), { timeout: 180_000 }).toBe(true);

  // The jump must stay on its own tracks: pick a scheduled draw whose own next stop lies ≥ 300 m ahead, so both
  // snapshot points are inside the trip's own running section and the timetable's expectation is never null.
  const fixture = await page.evaluate(() => {
    const n = window.__dbg.trams.net;
    const run = window.__dbg.trams.list.find(e => !e.live && Number.isFinite(e.d) && e.next?.d && e.next.d - e.d > 300);
    // Something to fall back on when the city just ended its rush: trip 0, safely early in its shape.
    const t = run ? run.trip : 0;
    const d0 = run ? run.d - 150 : 10, d1 = d0 + 150;
    const p0 = n.pointAt(n.trips[t * 5], d0, undefined);
    const p1 = n.pointAt(n.trips[t * 5], d1, undefined);
    return { trip: t, id: n.trams.tripIds[t], p0: { x: p0.x, z: p0.z, d: d0 },
      p1: { x: p1.x, z: p1.z, d: d1 } };
  });
  expect(fixture.id).toBeTruthy();

  // The feed's clock starts with ITS first answer (polls may already be mid-cadence): swap lands five false
  // minutes into its history exactly one poll later.
  const body = now => {
    fixture.t0 = fixture.t0 ?? now;
    const swap = now - fixture.t0 > 20;
    return { ts: fixture.t0 + (swap ? 300 : 0), vehicles: [{ kind: 'tram', trip: fixture.id,
      x: (swap ? fixture.p1.x : fixture.p0.x), z: (swap ? fixture.p1.z : fixture.p0.z), d: swap ? fixture.p1.d : fixture.p0.d, heading: 0 }] };
  };
  const fulfill = route => route.fulfill({ json: body(Math.floor(Date.now() / 1000)) });
  await page.route(url => url.pathname === '/rt' || url.pathname.endsWith('/rt.json'), fulfill);

  const rows = [];
  const t0 = Date.now();
  for (;;) {
    await page.evaluate(() => window.__dbg.invalidate(400));
    rows.push([Date.now() - t0, ...(await page.evaluate(() => {
      const e = window.__dbg?.trams?.list?.find(x => x.live);
      return [e ? e.x : null, e ? e.z : null];
    }))]);
    if (Date.now() - t0 >= 45_000) break;
    await page.waitForTimeout(300);
  }
  const real = rows.filter(([, x]) => x != null);
  expect(real.length, `live samples (${real.length})`).toBeGreaterThan(80);
  let maxStep = 0;
  for (let i = 1; i < real.length; i++) {
    maxStep = Math.max(maxStep, Math.hypot(real[i][1] - real[i - 1][1], real[i][2] - real[i - 1][2]));
  }
  const drift = Math.hypot(real.at(-1)[1] - real[0][1], real.at(-1)[2] - real[0][2]);
  console.log(`[live] samples=${real.length}/${rows.length} maxStep=${maxStep.toFixed(2)} m drift=${drift.toFixed(2)} m`,
    'drawn:', JSON.stringify(await page.evaluate(() => window.__dbg.trams.drawn)));
  expect(maxStep, `largest beat-to-beat step: ${maxStep.toFixed(2)} m`).toBeLessThanOrEqual(3);
  expect(drift, `total drift across the swap: ${drift.toFixed(2)} m`).toBeGreaterThan(5);
});
