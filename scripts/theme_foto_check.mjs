// The Foto look (themes.js foto): the real photographed roof and ground colours must load and be applied.
//   node scripts/theme_foto_check.mjs [baseUrl] [outDir]
// Loads ?theme=foto and the default look at the home view, screenshots both, prints uniform state, texture sizes,
// draw calls, console errors and failed requests. The pixel comparison is done by the caller (PIL).
import { chromium } from '@playwright/test';

const base = (process.argv[2] || 'http://127.0.0.1:8642/').replace(/\/$/, '');
const out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });

async function shot(url, file) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [], failed = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.goto(url);
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180000 });
  await page.waitForFunction(() => { const t = window.__dbg?.terrain?.(); return !t || !t.source || t.state === 'ready' || t.state === 'failed'; }, null, { timeout: 60000 });
  await page.waitForTimeout(4000);
  const state = await page.evaluate(() => {
    const u = window.__dbg.uniforms;
    const s = window.__dbg.stats();
    return { uFoto: u.uFoto.value, roof: !!u.uRoof.value, ground: !!u.uGround.value,
      roofSize: u.uRoof.value ? [u.uRoof.value.image.width, u.uRoof.value.image.height] : null,
      groundSize: u.uGround.value ? [u.uGround.value.image.width, u.uGround.value.image.height] : null,
      calls: s.calls, triangles: s.triangles, theme: window.__dbg.stats().theme };
  });
  await page.screenshot({ path: file });
  await page.close();
  return { state, errors, failed };
}

const foto = await shot(`${base}/?theme=foto`, `${out}/foto.png`);
const arg = await shot(`${base}/?theme=arg`, `${out}/arg.png`);
await browser.close();
console.log(JSON.stringify({ foto, arg }, null, 1));
