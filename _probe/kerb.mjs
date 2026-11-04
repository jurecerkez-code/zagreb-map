import { chromium } from '@playwright/test';
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errs = [];
pg.on('pageerror', e => errs.push(String(e).slice(0, 120)));
await pg.goto('http://127.0.0.1:8643/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await pg.waitForTimeout(60000);
await pg.screenshot({ path: '_probe/kerb_home.png' });
const ok = await pg.evaluate(() => {
  const T = window.__dbg; if (!T || !T.camera || !T.controls) return 'no dbg: ' + Object.keys(window.__dbg || {});
  T.controls.target.set(706, 0, -1400);
  T.camera.position.set(746, 8, -1394);
  T.controls.update();
  return 'moved';
});
await pg.waitForTimeout(4000);
await pg.screenshot({ path: '_probe/kerb_street.png' });
console.log(JSON.stringify({ ok, errs }));
await b.close();
