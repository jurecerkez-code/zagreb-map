import { chromium } from '@playwright/test';
const b = await chromium.launch();
const pg = await (await b.newContext()).newPage();
const fails = [], pages = [];
pg.on('requestfailed', r => fails.push(r.failure()?.errorText + ' ' + r.url()));
pg.on('pageerror', e => pages.push(String(e).slice(0, 300)));
const cons = [];
pg.on('console', m => cons.push(m.type() + ': ' + m.text().slice(0, 180)));
await pg.goto('https://jurecerkez-code.github.io/zagreb-map/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await pg.waitForTimeout(45000);
const probe = await pg.evaluate(() => ({
  txt: (document.body.innerText.match(/\d[\d.\s]*?\s*zgrada/i) || ['?'])[0],
  roads: window.roads ? 'layer present' : 'no roads global',
  canvases: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height),
}));
console.log(JSON.stringify({ probe, fails, pages, interestingLog: cons.filter(c => /data|bin|gz|decode|worker|type|count|zagreb|road/i.test(c)).slice(0, 15) }, null, 1));
await b.close();
