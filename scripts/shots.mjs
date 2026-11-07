#!/usr/bin/env node
// Screenshots the map at three views (home, near at 400 m over Trg bana Jelačića, far at 20 km) in the foto theme by
// day, and measures each picture's luminance (mean and std-dev, Rec. 709 on the sRGB bytes) into a JSON file.
//   node scripts/shots.mjs [url] --out shots.json            # shots to ./shots/, numbers to shots.json
//   node scripts/shots.mjs [url] --baseline                  # the baseline: e2e/__screenshots__/ + baseline.json
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const url = process.argv[2] || 'http://127.0.0.1:8643/';
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const baseline = process.argv.includes('--baseline');
const out = arg('--out');
const dir = baseline ? 'e2e/__screenshots__' : 'shots';
const jsonPath = baseline ? 'e2e/__screenshots__/baseline.json' : (out || 'shots.json');
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}?theme=foto&sunmode=day&date=2026-06-21&veg=1`);
await page.waitForFunction(() => document.getElementById('loading')?.hidden, null, { timeout: 180000 });
await page.waitForFunction(() => { const s = window.__dbg?.stats(); return s && s.tiles >= s.tilesTotal && s.terrain === 'ready'; },
  null, { timeout: 300000 });
await page.waitForTimeout(8000);

// The headless swiftshader draws about a frame a second, so after any camera move the wait is generous: the flight
// (1.4 s) and a few drawn frames must both fit inside it before the screenshot.
const views = [
  ['home', () => window.__dbg.goHome(), 6000],
  ['near', () => window.__dbg.flyTo(0, 0, null, 400), 9000],
  ['far', () => { window.__dbg.goHome(); window.__dbg.viewAt(20000); }, 6000],
];
const result = {};
const lum = async file => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, c = info.channels;
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * data[i * c] + 0.7152 * data[i * c + 1] + 0.0722 * data[i * c + 2];
    sum += l; sq += l * l;
  }
  const mean = sum / n;
  return { mean: Math.round(mean * 100) / 100, stddev: Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean)) * 100) / 100 };
};
// A view change re-streams packs, and on a slow runner the fixed wait ends mid-load: CI shot the far view as a
// uniform 222/0 blank. Before judging a view, wait for its loads to drain (capped, so a stuck asset cannot hang
// the gate), and if the frame still comes out uniform, settle once more and re-shoot it.
const settle = () => page.waitForFunction(() => {
  const s = window.__dbg?.stats();
  return s && s.assets === 0 && window.__dbg.animDone !== false;
}, null, { timeout: 120000, polling: 1000 }).catch(() => {});
const shoot = async name => {
  const file = join(dir, `${name}.png`);
  // Not page.screenshot: the software compositor never finishes a page capture at this draw cost. One explicit
  // software render into the canvas and a read of its pixels in the same task is a bounded wait instead.
  const dataUrl = await page.evaluate(() => {
    const { renderer, scene, camera } = window.__dbg;
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  });
  await sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
    // Committed and uploaded, so tiny: a quality-targeted palette keeps a 720p shot well under the 500 KB line
    // (a fixed colour count does not: the far view's speckle sits at ~525 KB whether it gets 64 or 256 colours),
    // and both the baseline and every later gate run go through the same encoder, so the numbers stay comparable.
    .png({ compressionLevel: 9, palette: true, quality: 85, dither: 0, effort: 10 })
    .toFile(file);
  return lum(file);
};
for (const [name, go, wait] of views) {
  await page.evaluate(go);
  await page.waitForTimeout(wait);
  await settle();
  let shot = await shoot(name);
  if (shot.stddev < 1) {
    console.log(name, 'frame uniform, settling before a re-shoot');
    await settle();
    await page.waitForTimeout(5000);
    shot = await shoot(name);
  }
  result[name] = { ...shot, png: baseline ? `${name}.png` : join(dir, `${name}.png`) };
  console.log(name, JSON.stringify(result[name]));
}
writeFileSync(jsonPath, JSON.stringify(result, null, 1));
console.log('wrote', jsonPath);
// SwiftShader can keep the browser's close promise pending after every shot and the JSON are safely on disk.
// Bound it so a successful measurement also becomes a successful CI/background exit, not a silent orphan.
await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 10000))]);
process.exit(0);
