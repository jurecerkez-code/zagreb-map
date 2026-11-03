// Judge the Foto look's variants at the home view, one screenshot each.
//   node scripts/foto_variants.mjs <outDir> <url> [url ...]
// Example: node scripts/foto_variants.mjs C:/tmp/fv "http://127.0.0.1:8642/?theme=arg" \
//            "http://127.0.0.1:8642/?theme=foto" "http://127.0.0.1:8642/?theme=foto&fotoground=0"
// Writes <n>.png per url plus state.json (uniforms, draw calls, console errors, failed requests).
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const [outDir, ...urls] = process.argv.slice(2);
if (!outDir || !urls.length) { console.error('usage: foto_variants.mjs <outDir> <url> [url ...]'); process.exit(2); }
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const report = [];
for (const [i, url] of urls.entries()) {
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
    const u = window.__dbg.uniforms, s = window.__dbg.stats();
    return { theme: s.theme, uFoto: u.uFoto.value, uFotoGround: u.uFotoGround.value, calls: s.calls, triangles: s.triangles };
  });
  await page.screenshot({ path: `${outDir}/${i}.png` });
  report.push({ url, state, errors, failed });
  await page.close();
}
await browser.close();
writeFileSync(`${outDir}/state.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
