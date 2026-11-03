// Zagreb port: pin one building's card and print its text.  node scripts/zagreb_card.mjs <baseUrl> <gid> [shot.png]
import { chromium } from '@playwright/test';
const [base, gid, shot] = [process.argv[2], +process.argv[3], process.argv[4]];
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base);
await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
await page.evaluate(g => window.__dbg.pinCard(g, 300, 300), gid);
await page.locator('#card.pinned').waitFor({ timeout: 10_000 });
await page.waitForTimeout(800);
if (shot) await page.screenshot({ path: shot });
console.log(JSON.stringify({ errors, gid, building: await page.evaluate(g => window.__dbg.building(g), gid),
  text: (await page.locator('#card').innerText()).split('\n').map(s => s.trim()).filter(Boolean) }));
await browser.close();
