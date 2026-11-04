import { chromium } from '@playwright/test';
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errs = [];
pg.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
pg.on('pageerror', e => errs.push('PAGE: ' + String(e).slice(0, 160)));
try {
  await pg.goto('https://jurecerkez-code.github.io/zagreb-map/', { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) { console.log('goto err', String(e).slice(0, 120)); }
await pg.waitForTimeout(40000);
let info = null;
try {
  info = await pg.evaluate(() => ({
    inner: document.body.innerText.replace(/\n+/g, ' | ').slice(0, 300),
    buttons: [...document.querySelectorAll('button')].slice(0, 25).map(x => (x.textContent || '').trim()),
    canvases: document.querySelectorAll('canvas').length,
  }));
} catch (e) { info = { evalErr: String(e).slice(0, 160) }; }
console.log(JSON.stringify({ info, errs: errs.slice(0, 8) }, null, 1));
try {
  await pg.screenshot({ path: '_probe/live_overview.png', timeout: 90000 });
  console.log('shot->ok');
} catch (e) { console.log('shot->FAIL ' + String(e).slice(0, 120)); }
try {
  await pg.evaluate(() => { if (typeof startRide === 'function') startRide(); });
  await pg.waitForTimeout(6000);
  await pg.screenshot({ path: '_probe/live_ride.png', timeout: 90000 });
  console.log('ride->ok');
} catch (e) { console.log('ride->' + String(e).slice(0, 120)); }
await b.close();
