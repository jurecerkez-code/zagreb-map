// #24: real rendered-scene contract for golden and the two night paths. No debug lighting overrides.
// Launch after the sun and layers have loaded from a live 23:00 request, so later roads/trams must inherit night.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:8643/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {
  if (m.type() === 'error' && /Shader|WebGL/i.test(m.text())) errors.push(m.text());
});

try {
  await page.goto(`${base}?theme=foto&sunmode=live&date=2026-06-21&sun=23:00&weather=none`);
  await page.waitForFunction(() => document.getElementById('loading')?.hidden, null, { timeout: 180000 });
  await page.waitForFunction(() => {
    const s = window.__dbg?.stats();
    return s && s.tiles >= s.tilesTotal && s.terrain === 'ready';
  }, null, { timeout: 300000 });
  // In particular, the lamps must arrive AFTER live night has already been selected.
  await page.waitForFunction(() => {
    const veg = window.__dbg?.veg;
    return veg?.group.children.some(m => m.material?.uniforms?.uTint)
      && (window.__roads?.().drawn.tiles ?? 0) > 0;
  }, null, { timeout: 300000 });

  const frames = await page.evaluate(() => {
    const d = window.__dbg;
    const read = mode => {
      if (mode) d.applySunMode(mode);
      const trees = d.veg.group.children.find(m => m.material?.uniforms?.uTint);
      return {
        mode: d.sunMode,
        night: d.uniforms.uNight.value,
        vector: d.uniforms.uSun.value.toArray(),
        lamps: d.scene.getObjectByName('streetlamps')?.visible ?? null,
        treeTint: trees.material.uniforms.uTint.value.toArray(),
        exposure: d.renderer.toneMappingExposure,
      };
    };
    return {
      initialLive: read(), explicitNight: read('night'), liveNight: read('live'),
      day: read('day'), golden: read('golden'),
    };
  });
  mkdirSync('shots', { recursive: true });
  writeFileSync('shots/night-contract.json', JSON.stringify(frames, null, 1));
  const close = (a, b, eps = 1e-6) => { for (let i = 0; i < b.length; i++) assert.ok(Math.abs(a[i] - b[i]) < eps, `${a} != ${b}`); };
  const expectedNight = new Float64Array(3);
  const l = Math.hypot(0, 0.62, -0.78);
  expectedNight.set([0, 0.62 / l, -0.78 / l]);
  assert.equal(frames.initialLive.night, 1, 'boot under a low live sun');
  assert.equal(frames.initialLive.lamps, true, 'lamps arrived after live night and must still turn on');
  assert.equal(frames.initialLive.exposure, 1.3);
  close(frames.initialLive.vector, expectedNight);
  for (const mode of ['initialLive', 'liveNight']) {
    close(frames[mode].vector, frames.explicitNight.vector);
    close(frames[mode].treeTint, frames.explicitNight.treeTint);
    assert.equal(frames[mode].lamps, frames.explicitNight.lamps);
    assert.equal(frames[mode].exposure, frames.explicitNight.exposure);
    assert.ok(frames[mode].treeTint[0] < frames.day.treeTint[0], `${mode}: darker tree cover than day`);
  }
  assert.equal(frames.day.night, 0);
  assert.equal(frames.day.lamps, false);
  assert.equal(frames.golden.night, 0);
  close(frames.golden.vector, [-0.557208, 0.615661, 0.557208]);
  assert.equal(frames.golden.exposure, 1.15);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(frames, null, 1));
  console.log('night mode contract: PASS');
  process.exitCode = 0;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 10000))]);
}
process.exit(process.exitCode);
