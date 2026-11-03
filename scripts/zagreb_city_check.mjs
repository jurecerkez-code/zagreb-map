// Zagreb port, whole city: headless check of the served viewer (scripts/serve_version.py or serve.py running).
//   node scripts/zagreb_city_check.mjs [baseUrl] [outDir]
// Prints JSON: console/page errors, failed requests, load time, transferred bytes, the HOME screenshot path, and the
// pinned card text of named landmarks (found by name in the card shards).
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:8643/';
const outDir = process.argv[3] || '.';
const FAMOUS = [/narodno kazali/i, /katedral/i, /uznesenja blažene djevice marije/i, /sv\. marka/i, /zagrebtower|zagreb tower/i, /mimara/i];
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [], failed = [], warnings = [];
let bytes = 0, requests = 0;
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); else if (m.type() === 'warning') warnings.push(m.text()); });
page.on('requestfailed', r => failed.push(`FAILED ${r.failure()?.errorText}: ${r.url()}`));
page.on('response', async r => {
  requests++;
  if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`);
  const len = +(r.headers()['content-length'] || 0);
  bytes += len;
});
const t0 = Date.now();
await page.goto(base);
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
const loadedMs = Date.now() - t0;
await page.waitForFunction(() => { const t = window.__dbg?.terrain?.(); return !t || !t.source || t.state === 'ready' || t.state === 'failed'; }, null, { timeout: 120_000 });
await page.waitForTimeout(6000);
const settledMs = Date.now() - t0;
await page.screenshot({ path: `${outDir}/city_home.png` });
const info = await page.evaluate(async (famous) => {
  const { version } = await (await fetch('data/current.json')).json();
  const cfg = await (await fetch(`data/${version}/zagreb.json`)).json();
  const shards = [];
  for (let k = 0; k < 64; k++) {
    const r = await fetch(`data/${version}/cards/${String(k).padStart(2, '0')}.json`);
    if (!r.ok) break;
    shards.push(await r.json());
  }
  const cards = Object.assign({}, ...shards);
  const hits = famous.map(src => {
    const re = new RegExp(src[0], src[1]);
    const gs = Object.keys(cards).filter(g => re.test(cards[g]?.name || '') || re.test(cards[g]?.name_en || cards[g]?.en || ''));
    gs.sort((a, b) => (window.__dbg.building(+b).year > 0) - (window.__dbg.building(+a).year > 0));
    return gs.slice(0, 2).map(g => ({ gid: +g, name: cards[g].name, b: window.__dbg.building(+g) }));
  });
  return { version, n: cfg.stats.buildings, title: document.title, h1: document.querySelector('h1')?.textContent,
    legend: [...document.querySelectorAll('.legend li, .legend button')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 12),
    terrain: window.__dbg.terrain(), hits };
}, FAMOUS.map(r => [r.source, r.flags]));
const cardsOut = [];
for (const list of info.hits) {
  for (const h of list) {
    await page.evaluate(g => window.__dbg.pinCard(g, 300, 300), h.gid);
    await page.locator('#card.pinned').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    const text = (await page.locator('#card').innerText()).split('\n').map(s => s.trim()).filter(Boolean);
    cardsOut.push({ gid: h.gid, year: h.b.year, ysrc: h.b.ysrc, text });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}
if (cardsOut.length) {
  await page.evaluate(g => window.__dbg.pinCard(g, 300, 300), cardsOut[0].gid);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${outDir}/city_card.png` });
}
delete info.hits;
console.log(JSON.stringify({ errors, failed, warnings: warnings.slice(0, 10), loadedMs, settledMs, requests,
  transferredBytes: bytes, ...info, cards: cardsOut }, null, 1));
await browser.close();
