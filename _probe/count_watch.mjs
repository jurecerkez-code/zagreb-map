import { chromium } from '@playwright/test';
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1440, height: 810 } })).newPage();
await pg.goto('https://jurecerkez-code.github.io/zagreb-map/', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (const t of [30, 90, 160]) {
  await pg.waitForTimeout(t === 30 ? 30000 : t === 90 ? 60000 : 70000);
  const r = await pg.evaluate(() => ({
    count: (document.body.innerText.match(/\d[\d.\s]*?\s*zgrada/i) || ['?'])[0],
    dbg: window.__dbg?.stats ? window.__dbg.stats() : null,
  }));
  console.log('t=' + t + 's', JSON.stringify(r).slice(0, 400));
}
await b.close();
