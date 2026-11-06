#!/usr/bin/env node
// #24: authored colours must survive the renderer. Two pixel probes against the same recipe as the picture gate:
//
//   1. roof: in the Foto look, render straight down over a roof and compare that pixel with the authored byte in
//      roof_rgb.bin: the photographed roof stays the photograph (not washed out by the renderer, not darkened by
//      the file's own encoding),
//   2. asphalt: in the paper look, render straight down a residential road and compare the road's dominant pixel
//      with its authored palette (#4f5450 in web/roads-layer.js).
//
// Both through the full pipe: GPU (SwiftShader in CI), AgX, exposure, encode. DeltaE 76 on sRGB (as themes.test.mjs
// does it, 100 x OKLab distance). Exits 1 when a probe reads further off than its floor.
//   node scripts/colour_probe.mjs [url]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { oklabLin, lin, rgb } from '../web/tone.js';

const url = process.argv[2] || 'http://127.0.0.1:8643/';
const DE_MAX_ROOF = 10;    // pinned by the measured values of 2026-11 (see docs/plan.md round 6)
const DE_MAX_ROAD = 12;

const dE = (a, b) => {
  const p = oklabLin(rgb(a).map(lin)), q = oklabLin(rgb(b).map(lin));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};
// Median of a 13 x 13 patch: the road shader dithers a kerb's distance and the noise guard on the edges.
const medianPatch = (data, info, x, y, w = 13) => {
  const c = info.channels, sums = [0, 0, 0], rows = [];
  for (let dy = -w / 2 | 0; dy <= w / 2; dy++) for (let dx = -w / 2 | 0; dx <= w / 2; dx++) {
    const i = ((y + dy) * info.width + x + dx) * c;
    rows.push([data[i], data[i + 1], data[i + 2]]);
  }
  for (let k = 0; k < 3; k++) sums[k] = rows.map(r => r[k]).sort((a, b) => a - b)[(rows.length / 2) | 0];
  return '#' + sums.map(v => v.toString(16).padStart(2, '0')).join('');
};

const version = JSON.parse(readFileSync(new URL('../web/data/current.json', import.meta.url), 'utf8')).version;
const DATA = `data/${version}/`;
// The authored roof bytes: 8-byte little-endian header (w, h), then RGBA per gid at (gid % 512, gid / 512).
const roofBuf = readFileSync(new URL(`../web/${DATA}roof_rgb.bin`, import.meta.url));
const roofRgb = gid => {
  const w = new DataView(roofBuf.buffer, roofBuf.byteOffset, 8).getUint32(0, true);
  const o = 8 + ((gid / 512 | 0) * w + (gid % 512)) * 4;
  return { hex: '#' + [0, 1, 2].map(k => roofBuf[o + k].toString(16).padStart(2, '0')).join(''), a: roofBuf[o + 3] };
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => { if (m.type() === 'error' && /Shader|WebGL/.test(m.text())) console.error(`[page] ${m.text()}`); });
const ready = async q => {
  await page.goto(`${url}${q}`);
  await page.waitForFunction(() => document.getElementById('loading')?.hidden, null, { timeout: 180000 });
  await page.waitForFunction(() => { const s = window.__dbg?.stats(); return s && s.tiles >= s.tilesTotal && s.terrain === 'ready'; },
    null, { timeout: 300000 });
  await page.waitForTimeout(2500);
};
const frame = async () => {
  const dataUrl = await page.evaluate(() => {
    const { renderer, scene, camera } = window.__dbg;
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  });
  return await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
};
const settle = () => page.waitForFunction(() => {
  const s = window.__dbg?.stats();
  return s && s.assets === 0 && window.__dbg.animDone !== false;
}, null, { timeout: 120000, polling: 500 }).catch(() => {});

const report = [];
let worst = 0;

// ---- Roof: foto look, camera straight down over the hero view, any roof the pick pass owns.
await ready('?theme=foto&sunmode=golden&weather=none&veg=1');
await page.evaluate(() => window.__dbg.flyTo(0, 0, null, 300, 0.95));
await page.waitForTimeout(7000);
await settle();
{
  const { data, info } = await frame();
  const tried = [], good = [];
  outer: for (const fy of [0.34, 0.42, 0.5, 0.58, 0.66, 0.74]) {
    for (const fx of [0.2, 0.36, 0.52, 0.68, 0.84]) {
      const x = Math.round(info.width * fx), y = Math.round(info.height * fy);
      const gid = await page.evaluate(([a, b]) => window.__dbg.pick(a, b), [x, y]);
      if (gid < 0) continue;
      const exp = roofRgb(gid);
      if (!exp.a) continue;                    // no photographed byte: the period colour stays, not this probe
      const got = medianPatch(data, info, x, y);
      const e = dE(got, exp.hex);
      tried.push({ gid, x, y, exp: exp.hex, got, dE: +e.toFixed(1) });
      if (e <= DE_MAX_ROOF) good.push(tried[tried.length - 1]);
      if (good.length >= 2) break outer;       // two clean reads are the probe
    }
  }
  report.push({ probe: 'roof', floor: DE_MAX_ROOF, tried: tried.slice(0, 8), good: good.length });
  if (!good.length) worst = Math.max(worst, ...tried.map(t => t.dE));
}

// ---- Asphalt: paper look, the residential ribbon nearest the centre, read under the same fall.
const meta = JSON.parse(readFileSync(new URL(`../web/${DATA}roads.json`, import.meta.url), 'utf8'));
const ptsRaw = new Uint8Array(readFileSync(new URL(`../web/${DATA}roads.bin.gz`, import.meta.url)));
const pts = new Float32Array((await new Response(new Blob([ptsRaw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()));
// Find a residential (or secondary/tertiary) ribbon midpoint close to the hero view, on a straight run.
let spot = null;
for (const w of meta.ways.sort((a, b) => b.c - a.c || b.w - a.w)) {
  if (!['residential', 'unclassified', 'tertiary', 'secondary'].includes(w.cls) || w.c < 3) continue;
  const [x, z] = [pts[2 * (w.o + (w.c >> 1))], pts[2 * (w.o + (w.c >> 1)) + 1]];
  if (Math.hypot(x, z) < 1500 && Math.hypot(x, z) > 60) { spot = { x, z, cls: w.cls }; break; }
}
if (!spot) throw new Error('colour_probe: no quiet residential ribbon near the centre found');
await ready(`?theme=paper&sunmode=golden&weather=none`);
await page.evaluate(([a, b]) => window.__dbg.flyTo(a, b, null, 260, 0.92), [spot.x, spot.z]);
await page.waitForTimeout(7000);
await settle();
{
  const { data, info } = await frame();
  const x = info.width >> 1, y = info.height >> 1;
  // The road's own band dominates the centre patch; its dominant colour is the answer (kerbs and edges are minora).
  const c = data[0]*0, got = medianPatch(data, info, x, y, 27);
  const e = dE(got, '#4f5450');
  report.push({ probe: 'asphalt', floor: DE_MAX_ROAD, spot, exp: '#4f5450', got, dE: +e.toFixed(1) });
  if (e > DE_MAX_ROAD) worst = Math.max(worst, e);
}

await browser.close();
console.log(JSON.stringify(report, null, 1));
if (worst) {
  console.error(`colour probe over its floor: worst ΔE ${worst.toFixed(1)}`);
  process.exit(1);
}
console.log('colour probe: authored colours survive the renderer');
