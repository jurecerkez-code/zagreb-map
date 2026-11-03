// Zagreb port: open the cards of a few named landmarks in the served map and print what they show.
import { chromium } from '@playwright/test';
const NAMES = process.argv.slice(2).length ? process.argv.slice(2) : ['Zagreb Cathedral', 'Croatian National Theatre in Zagreb'];
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const bad = [], errs = [];
p.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
p.on('pageerror', e => errs.push(e.message));
await p.goto(process.env.HFH_BASE || 'http://127.0.0.1:8642/');   // HFH_BASE: another server (a build under check)
await p.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
const gids = await p.evaluate(async names => {
  const { version } = await (await fetch('data/current.json')).json();
  const shards = await Promise.all([...Array(64).keys()].map(async k => (await fetch(`data/${version}/cards/${String(k).padStart(2, '0')}.json`)).json()));
  const cards = Object.assign({}, ...shards);
  return names.map(n => [n, +(Object.entries(cards).find(([, c]) => c.en === n || c.name === n)?.[0] ?? -1)]);
}, NAMES);
const out = [];
for (const [name, g] of gids) {
  if (g < 0) { out.push({ name, found: false }); continue; }
  await p.evaluate(x => window.__dbg.pinCard(x, 400, 400), g);
  await p.locator('#card.pinned').waitFor({ timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(8000);
  out.push(await p.evaluate(([n, x]) => {
    const c = document.querySelector('#card'); const i = c?.querySelector('img');
    return { name: n, gid: x, photo: !!(i && i.complete && i.naturalWidth > 0), text: (c?.innerText || '').replace(/\n+/g, ' | ').slice(0, 260) };
  }, [name, g]));
}
console.log(JSON.stringify({ errs, bad, out }, null, 1));
await b.close();
