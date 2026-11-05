// Issue #27 acceptance: at reliefs 0, 1 and 2.5, random road vertices sit within 0.3 m above surfaceAt.
// The streets lift in the vertex shader now (aT * uRelief - aCut * uCutK); this reads the worker-baked pair back
// and compares the shader's math against the page's own surfaceAt — so the e2e needs no WebGL, just the built tiles.
import { test, expect } from '@playwright/test';
import { settled } from './settled.mjs';

const SAMPLES = 50;

test('road vertices lie on the terrain at every relief, within 0.3 m', async ({ page }) => {
  await page.goto('/?lang=en&weather=none', { waitUntil: 'domcontentloaded' });
  await settled(page);
  // Wait until the streets' tiles exist on the page, then take 50 random vertices with their baked ground pair.
  await expect.poll(() => page.evaluate(() => {
    const r = window.__roads?.();
    return r && r.group && r.group.children.length > 1 ? r.group.children.filter(c => c.isMesh).length : 0;
  }), { timeout: 120_000, message: 'the streets came up textured' }).toBeGreaterThan(0);

  const bundles = await page.evaluate(sampleCount => {
    const r = window.__roads();
    const meshes = r.group.children.filter(c => c.isMesh && c.geometry.attributes.aT);
    const picks = [];
    for (const m of meshes) {
      const a = m.geometry.attributes;
      // Vertices come in pairs across the ribbon (way point ± half-normal): the way point itself is their mean —
      // that's where the ground pair was sampled. Taking one lane's coordinate instead compares against a point
      // half a ribbon away, which is just noise on a slope.
      for (let i = 0; i + 1 < a.position.count && picks.length < sampleCount * 2; i += Math.max(2, 2 * Math.floor(a.position.count / 12))) {
        picks.push({
          x: (a.position.array[i * 3] + a.position.array[(i + 1) * 3]) / 2,
          z: (a.position.array[i * 3 + 2] + a.position.array[(i + 1) * 3 + 2]) / 2,
          t: a.aT.array[i],
          cut: a.aCut.array[i],
        });
      }
    }
    return picks.slice(0, sampleCount);
  }, SAMPLES);
  expect(bundles.length).toBe(SAMPLES);

  for (const relief of [0, 1, 2.5]) {
    await page.evaluate(r => window.__dbg.chooseRelief(r), relief);
    // The rise tween owns the uniforms for its 600–1200 ms: compare only once uRelief has landed on the slider.
    await expect.poll(() => page.evaluate(() => window.__dbg.uniforms.uRelief.value), { timeout: 10_000 }).toBeCloseTo(relief, 4);
    const misses = await page.evaluate(({ points, relief }) => {
      const R = relief, K = window.__dbg.uniforms.uCutK.value;
      const misses = [];
      for (const p of points) {
        const ground = window.__dbg.surfaceAt(p.x, p.z);
        const lifted = p.t * R - p.cut * K;
        if (Math.abs(lifted - ground) > 0.3) misses.push({ x: p.x, z: p.z, lifted, ground });
      }
      return misses;
    }, { points: bundles, relief });
    expect(misses, `relief ${relief}: ${misses.length}/${SAMPLES} off the ground (first: ${JSON.stringify(misses[0])})`).toEqual([]);
  }
  // Put the relief back where the page wanted it: a clean exit for whoever runs the suite after.
  await page.evaluate(() => window.__dbg.chooseRelief(window.__dbg.relief));
});
