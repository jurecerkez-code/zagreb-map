// Zagreb port: a headless smoke check of the served viewer (scripts/serve.py must be running).
//   node scripts/zagreb_check.mjs [baseUrl] [screenshot.png] [card.png]
// Prints JSON: console/page errors, failed requests, building counts, and the text of a dated building's card.
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:8642/';
const shot = process.argv[3] || 'screenshot.png';
const cardShot = process.argv[4] || 'card.png';
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [], failed = [], warnings = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); else if (m.type() === 'warning') warnings.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
await page.goto(base);
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
await page.waitForFunction(() => { const t = window.__dbg?.terrain?.(); return !t || !t.source || t.state === 'ready' || t.state === 'failed'; }, null, { timeout: 60_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: shot });
const info = await page.evaluate(async () => {
  const { version } = await (await fetch('data/current.json')).json();
  const cfg = await (await fetch(`data/${version}/zagreb.json`)).json();
  const n = cfg.stats.buildings;
  let dated = -1, named = -1;
  const shards = await Promise.all([...Array(64).keys()].map(async k => (await fetch(`data/${version}/cards/${String(k).padStart(2, '0')}.json`)).json()));
  const cards = Object.assign({}, ...shards);
  for (let g = 0; g < n; g++) {
    const b = window.__dbg.building(g);
    if (b.ysrc === 9 && dated < 0) dated = g;
    if (b.ysrc === 9 && cards[g]?.name && cards[g]?.architects && named < 0) named = g;
  }
  return { version, n, title: document.title, h1: document.querySelector('h1')?.textContent, dek: document.querySelector('.dek')?.textContent,
    legend: [...document.querySelectorAll('.legend li, .legend button')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 12),
    terrain: window.__dbg.terrain(), dated, named, building: window.__dbg.building(named >= 0 ? named : dated), card: cards[named >= 0 ? named : dated] };
});
const gid = info.named >= 0 ? info.named : info.dated;
await page.evaluate(g => window.__dbg.pinCard(g, 300, 300), gid);
await page.locator('#card.pinned').waitFor({ timeout: 10_000 });
await page.waitForTimeout(800);
info.cardText = (await page.locator('#card').innerText()).split('\n').map(s => s.trim()).filter(Boolean);
await page.screenshot({ path: cardShot });
console.log(JSON.stringify({ errors, failed, warnings: warnings.slice(0, 10), ...info }, null, 1));
await browser.close();
