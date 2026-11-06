// Issue #26's ride: the camera rides ON the trip's own shape, smoothly, at tram speed; a dwell of 8+ s reads as a
// stop; a live feed that jumps never makes the drawn position step.
//
// Sampling: the acceptance asks for 100 ms reads. Polling them from outside starved on a software box (each
// evaluate queues behind seconds of frame work), so the clock that reads is the page's own cadence: a hook on
// trams.step records one row per rendered frame, and this side reads the rows once at the end of the window.
import { test, expect } from '@playwright/test';
import { settled } from './settled.mjs';

// A background tab throttles rAF to about a frame a second, which is how a five-minute spec read four samples of
// the page before: bring the page forward so frames and the idle tiers run at the page's own cadence.
const boot = async page => {
  await page.bringToFront();
  await page.goto('/?lang=en&weather=none&tram=1&date=2026-11-05&sun=08:00', { waitUntil: 'domcontentloaded' });
};

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
  // the suite happened to run at. The stop must NOT be the terminus: a trip ends at its last stop's arrival, the
  // ride ejects there, and the stand that follows belongs to nobody's window.
  const picked = await page.evaluate(() => {
    const trams = window.__dbg.trams;
    const now = new Date();
    const secNow = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    let best = null, wait = Infinity;
    for (const e of trams.list) {
      if (e.live) continue;   // a live tram jitters with the feed's own noise even at a stand; the timetable twin stands bit-still
      if (!e.next?.sec) continue;
      if (!trams.net.nextStopAt(e.trip, e.next.d + 1)) continue;   // a stop AFTER the next stop, or there is no ride
      const w = e.next.sec - secNow;
      if (w < 8 || w > 660) continue;                        // too soon to hitch a ride, or past the test's budget
      // and the trip must still be on the move a breath after the stop's arrival — a ride that ends in 30 s
      // samples a departure, never a stand (measured: 26 rows, fastest 13.7 km/h, no dwell, twice)
      if (!trams.net.positionAt(e.trip, secNow + w + 45)) continue;
      if (w < wait) { best = e.trip; wait = w; }
    }
    return { trip: best ?? trams.list[0]?.trip, wait: Number.isFinite(wait) ? wait : 30 };
  });
  expect(picked.trip).toBeTruthy();
  await page.evaluate(t => window.__dbg.startRide({ trip: t }), picked.trip);
  const ridingNow = () => page.evaluate(() => window.__dbg.riding);
  for (let i = 0; i < 50 && (await ridingNow()) === null; i++) await page.waitForTimeout(100);
  expect(await ridingNow()).not.toBe(null);

  // One hook inside the page records a row per rendered frame — camera, HUD state and the ridden tram's own place.
  // Sampling from outside starved on a software box before: every evaluate queued behind seconds of frame work and
  // a 35-second ride once read as four rows. The page's own frames are the honest clock anyway.
  await page.evaluate(() => {
    const t = window.__dbg;
    window.__rows = [];
    const orig = t.trams.step.bind(t.trams);
    t.trams.step = v => {
      orig(v);
      const id = window.__dbg.riding;   // a trip id number or null (reading dbg.state.riding threw here before)
      const e = id != null ? (t.trams.list.find(x => x.trip === id) || null) : null;
      // The riding marker rides along: frames after the trip ends belong to the homeward flight, not the ride —
      // a camera easing kilometres back to the home view otherwise reads as a speeding offence.
      window.__rows.push([performance.now(), ...t.camera.position.toArray(),
        document.querySelector('.ride-hud')?.textContent || '',
        !!document.querySelector('.ride-frame') && !document.querySelector('.ride-frame').hidden,
        e ? e.x : null, e ? e.z : null, id != null]);
    };
  });
  const budgetMs = Math.min(540, Math.max(35, picked.wait + 45)) * 1000;
  const deadline = Date.now() + budgetMs;
  // Wall-side invalidations keep the due frames flowing on a software box (same medicine the swap test takes):
  // without them an idle page renders one frame a second at best and an eight-second stop reads as two samples.
  while (Date.now() < deadline) {
    await page.evaluate(() => window.__dbg.invalidate(1300));
    await page.waitForTimeout(1100);
  }
  const [plan, rec0] = await Promise.all([shapeOf(page, picked.trip), page.evaluate(() => window.__rows)]);
  const rec = rec0.slice(0, rec0.findIndex(r => !r[8]) < 0 ? rec0.length : rec0.findIndex(r => !r[8]));
  const t0 = rec.length ? rec[0][0] : 0;
  // Samples older than the entry-lens window: after the 0.35 s ease the camera has parked, and the meters that
  // matter happen there (the home camera may sit hundreds of metres away when the ride starts — by design).
  const steady = rec.filter(r => r[0] - t0 >= 4_000);
  const m = measures(steady, plan);
  // The dwell of the model itself, on the tram entity's drawn place (camera measures would blur it): same window.
  const stand = measures(rec.filter(r => r[6] !== null).map(r => [r[0], r[6], r[7], 0]), null).maxDwell;
  console.log(`[ride] samples=${m.n} maxOff=${m.maxOff.toFixed(2)} m maxKmh=${m.maxKmh.toFixed(1)} maxDwell=${m.maxDwell.toFixed(1)} s stand=${stand.toFixed(1)} s`);
  expect(m.maxOff, `furthest from the shape: ${m.maxOff.toFixed(2)} m`).toBeLessThanOrEqual(4);
  expect(m.maxKmh, `fastest sampled speed: ${m.maxKmh.toFixed(1)} km/h`).toBeLessThanOrEqual(70);
  // 8 s stands read as stops — on a software box the frame beat (~1.5 s) eats the beginning and end of a stand:
  // an honest timetable stand of 8 lands at ≥ 5 measured. The budget says less than that and nobody stood.
  expect(Math.max(m.maxDwell, stand), `longest stop inside the window: max(camera ${m.maxDwell.toFixed(1)}s, model ${stand.toFixed(1)}s)`).toBeGreaterThanOrEqual(5);
  expect(m.hudOn, 'the HUD reads the line and the minute').toBe(true);
  expect(m.frameOn, 'the cab frame draws').toBe(true);

  await page.keyboard.press('Escape');
  for (let i = 0; i < 50 && (await ridingNow()) !== null; i++) await page.waitForTimeout(100);
  expect(await ridingNow()).toBe(null);
});

test('a live feed that jumps 150 m never steps the drawn position', async ({ page }) => {
  test.setTimeout(600_000);
  // Every answer this page ever gets for its live feed is the fixture's: registered before the boot, so polls see
  // only it. Its clock starts on the first fulfill (poll cadence is its own, and the swap is exactly one five-
  // minute jump later).
  let fixture = null;
  const fulfill = route => {
    const now = Math.floor(Date.now() / 1000);
    if (!fixture) { route.fulfill({ json: { ts: now, vehicles: [] } }); return; }
    fixture.t0 = fixture.t0 ?? now;
    const swap = now - fixture.t0 > 20;
    route.fulfill({ json: { ts: fixture.t0 + (swap ? 300 : 0), vehicles: [{ kind: 'tram', trip: fixture.id,
      x: (swap ? fixture.p1.x : fixture.p0.x), z: (swap ? fixture.p1.z : fixture.p0.z), d: swap ? fixture.p1.d : fixture.p0.d, heading: 0 }] } });
  };
  await page.route(url => url.pathname === '/rt' || url.pathname.endsWith('/rt.json'), fulfill);
  await boot(page);
  await settled(page);
  await expect.poll(() => page.evaluate(() => (window.__dbg?.trams?.list?.length || 0) > 0), { timeout: 180_000 }).toBe(true);

  // The jump must stay on its own tracks: pick a scheduled draw whose own next stop lies ≥ 300 m ahead, so both
  // snapshot points are inside the trip's own running section and the timetable's expectation is never null.
    fixture = await page.evaluate(() => {
    const n = window.__dbg.trams.net;
    const nowSec = (new Date()).getHours() * 3600 + (new Date()).getMinutes() * 60 + (new Date()).getSeconds();
    // "Stays in schedule" is the real question: a drawn expectation must exist through the whole test window —
    // ask positionAt 300 s ahead. (trips[t*5+2] is the shape's length in METRES; subtracting seconds from it once
    // made this check select by shape length instead of time.)
    let run = window.__dbg.trams.list.find(e => !e.live && Number.isFinite(e.d) && e.next?.d && e.next.d - e.d > 300
      && n.positionAt(e.trip, nowSec + 300));
    if (!run) run = window.__dbg.trams.list.find(e => !e.live && Number.isFinite(e.d)
      && n.positionAt(e.trip, nowSec + 300)
      && n.pointAt(n.trips[e.trip * 5], e.d - 150 + 100, undefined));   // running with room for both snapshot points
    // Something to fall back on when the city just ended its rush: trip 0, safely early in its shape.
    const t = run ? run.trip : 0;
    const d0 = run ? run.d - 150 : 10;
    // p1 must land before the trip's own last call: the delay model renders through the timetable's expectations,
    // and out-of-window readings are never eased.
    const endsSec = run ? Math.min(run.d + 150, run.next.d - 30) : 160;
    const d1 = run ? Math.max(d0 + 1, endsSec) : 160;
    const p0 = n.pointAt(n.trips[t * 5], d0, undefined);
    const p1 = n.pointAt(n.trips[t * 5], d1, undefined);
    return { trip: t, id: n.trams.tripIds[t], p0: { x: p0.x, z: p0.z, d: d0 },
      p1: { x: p1.x, z: p1.z, d: d1 } };
  });
  expect(fixture.id).toBeTruthy();

  // Per-frame sampling on the strictest clock the page owns: hook the layer's own step(). Every due frame re-enters
  // it ("between frames" in the acceptance is these, not wall-clock beats), and a parked map gets none of them.
  await page.evaluate(tid => {
    const t = window.__dbg.trams;
    window.__liveTrail = [];
    const orig = t.step.bind(t);
    t.step = v => {
      orig(v);
      const e = t.list.find(x => x.trip === tid && x.live);
      if (e) window.__liveTrail.push([performance.now(), e.x, e.z]);
    };
  }, fixture.trip);
  console.log('[live-dbg] hook installed on trams.step; waiting through two poll cycles');
  // Wall-side invalidations keep the due frames flowing on a software box, so frames land whether or not the idle
  // tier would reach 20 fps on its own.
  for (let i = 0; i < 40; i++) { await page.evaluate(() => window.__dbg.invalidate(1500)); await page.waitForTimeout(1500); }
  const trail = await page.evaluate(() => window.__liveTrail);
  const real = trail.map(([t, x, z]) => [t, x, z]);
  console.log(`[live-dbg] trail=${trail.length} frames; drawn=`, JSON.stringify(await page.evaluate(() => window.__dbg.trams.drawn)));
  expect(trail.length, `steps recorded across two poll cycles (${trail.length})`).toBeGreaterThan(150);
  let maxStep = 0, maxOver = 0;
  for (let i = 1; i < real.length; i++) {
    const dt = (real[i][0] - real[i - 1][0]) / 1000;
    const step = Math.hypot(real[i][1] - real[i - 1][1], real[i][2] - real[i - 1][2]);
    maxStep = Math.max(maxStep, step);
    // The honest ceiling between two rendered frames: the bar holds at a second's cadence, and past it a tram's
    // own drawn pace (14 m/s) legitimately carries metres per beat. A snap already fails the bar at any dt.
    maxOver = Math.max(maxOver, step - (3 + 14 * dt));
  }
  const drift = Math.hypot(real.at(-1)[1] - real[0][1], real.at(-1)[2] - real[0][2]);
  console.log(`[live] frames=${real.length} maxStep=${maxStep.toFixed(2)} m maxOver=${maxOver.toFixed(2)} m drift=${drift.toFixed(2)} m`,
    'drawn:', JSON.stringify(await page.evaluate(() => window.__dbg.trams.drawn)));
  expect(maxOver, `most-any beat-to-beat step over its dt budget: ${maxOver.toFixed(2)} m`).toBeLessThanOrEqual(0);
  expect(drift, `total drift across the swap: ${drift.toFixed(2)} m`).toBeGreaterThan(5);
});
