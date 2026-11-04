// The boot smoke: the page must actually open. The unit tests never load app.js end to end, so a crash inside it –
// a const read before its declaration, a data file that answers 404 and gets parsed as JSON – shipped to the live
// site once already. Three assertions, all cheap:
//
//   1. no pageerror fires while the page boots (a crashed module boot is page error number one),
//   2. no data asset the page asks for comes back 404 (the gitignored-data class of bug),
//   3. the header count names real buildings, not the hardcoded 0 from index.html.
//
// Run by .github/workflows/ci.yml against web/ served statically. Locally: serve web/ on 8643 first.
import { chromium } from '@playwright/test';

const BASE = process.env.BOOT_BASE || 'http://127.0.0.1:8643/';

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage();

const pageErrors = [];
const bad = [];
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));
page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
// The config lands before the heavy packs: the count's seed and any boot crash are visible within seconds; give the
// software renderer a real minute anyway.
await page.waitForTimeout(60000);

const countText = await page.evaluate(() => document.getElementById('count')?.textContent ?? '?');
const count = parseInt(countText.replace(/\D/g, ''), 10);

let failed = 0;
const report = (ok, what, detail) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed = 1; };

report(pageErrors.length === 0, 'page boots without a pageerror', pageErrors.slice(0, 3).join(' | '));
const badData = bad.filter(u => /\/data\//.test(u));
report(badData.length === 0, 'every fetched data asset answers < 400', badData.slice(0, 5).join(' | '));
if (bad.length) console.log(`  (${bad.length} non-data or non-critical bad response(s): ${bad.slice(0, 6).join(' | ')})`);
report(Number.isFinite(count) && count > 100000, 'header counts the city', countText);

await browser.close();
console.log(failed ? `boot smoke FAILED (${bad.length} bad responses, ${pageErrors.length} page errors)` : 'boot smoke passed');
process.exit(failed);
