// The Zagreb stories (web/scenes/*.json, web/scene-player.js): headless check of the served viewer.
//   node scripts/scenes_check.mjs [baseUrl] [outDir]      e.g. after `python scripts/serve_version.py 8647 <version>`
// Opens each ready story with ?scene=<id> under reduced motion (no autoplay; the camera and captions jump straight to a
// beat), steps through every beat with the Next button and records what the player shows (caption, year, beat), and
// the map's timeline year. Screenshots one beat per story (scene_<id>.png) after the tiles there have loaded. Then plays
// one story with motion for a few seconds (autoplay on, the beat advances). Prints JSON; exits 1 on any console error,
// failed request, missing caption or wrong year.
import { chromium } from '@playwright/test';

const base = process.argv[2] || 'http://127.0.0.1:8647/';
const outDir = process.argv[3] || '../docs/screens';
const HERO = { 'two-hills': 6, 'earthquake-1880': 5, 'green-horseshoe': 4, 'interwar-estates': 7, 'across-the-sava': 5 };   // 1-based

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const errors = [], failed = [];
const watch = page => {
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', r => failed.push(`FAILED ${r.failure()?.errorText}: ${r.url()}`));
  page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
};
const ready = async page => {
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
  await page.waitForFunction(() => { const t = window.__dbg?.terrain?.(); return !t || !t.source || t.state === 'ready' || t.state === 'failed'; }, null, { timeout: 120_000 });
};
// DOM clicks: the player's history.replaceState makes Playwright's click wait for a navigation that never comes, and
// swiftshader draws about a frame a second.
const press = (page, sel) => page.evaluate(sel => document.querySelector(sel).click(), sel);
const frames = (page, n = 3) => page.evaluate(n => new Promise(ok => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : ok()); f(); }), n);

const index = await (await fetch(new URL('scenes/index.json', base))).json();
const ids = index.scenes.filter(s => s.ready).map(s => s.id);
const report = { base, scenes: [], problems: [] };

const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
for (const id of ids) {
  const scene = await (await fetch(new URL(`scenes/${id}.json`, base))).json();
  const page = await ctx.newPage();
  watch(page);
  await page.goto(new URL(`?scene=${id}`, base).href);
  await ready(page);
  await page.locator('.sp-cinema').waitFor({ state: 'visible', timeout: 60_000 });
  const beats = [];
  for (let i = 0; i < scene.beats.length; i++) {
    if (i) await press(page, '.sp-next');
    await frames(page, 2);
    const got = await page.evaluate(() => ({ state: window.__dbg.scenePlayer.state, caption: document.querySelector('.sp-caption').textContent,
      year: document.querySelector('.sp-year').textContent, source: document.querySelector('.sp-source').textContent,
      photo: !document.querySelector('.sp-photo').hidden, timeline: Math.round(window.__dbg.uniforms.uYear.value),
      pins: [...document.querySelectorAll('.sp-pin:not([hidden]) .sp-pin-label')].map(e => e.textContent) }));
    const want = scene.beats[i], wantYear = want.year ?? scene.year;
    if (got.state?.beat !== i) report.problems.push(`${id} beat ${i + 1}: player is on beat ${got.state?.beat}`);
    if (got.caption !== want.caption.en) report.problems.push(`${id} beat ${i + 1}: caption "${got.caption}"`);
    if (+got.year !== wantYear || got.timeline !== wantYear) report.problems.push(`${id} beat ${i + 1}: year ${got.year}, timeline ${got.timeline}, want ${wantYear}`);
    if (!!want.photo !== got.photo) report.problems.push(`${id} beat ${i + 1}: photo shown ${got.photo}`);
    beats.push({ n: i + 1, year: got.year, timeline: got.timeline, caption: got.caption, source: got.source, photo: got.photo, pins: got.pins });
  }
  // the story's picture: back to its hero beat, then time for the tiles there to load and draw
  const hero = HERO[id] || 1;
  await press(page, `.sp-tick[data-i="${hero - 1}"]`);
  await page.waitForTimeout(12_000);
  await frames(page, 4);
  const shot = `${outDir}/scene_${id}.png`;
  await page.screenshot({ path: shot });
  await press(page, '.sp-exit');
  await frames(page, 2);
  const after = await page.evaluate(() => ({ state: window.__dbg.scenePlayer.state, url: location.search, sceneOn: document.body.classList.contains('scene-on') }));
  if (after.state || after.sceneOn || after.url.includes('scene=')) report.problems.push(`${id}: exit left the scene up ${JSON.stringify(after)}`);
  report.scenes.push({ id, title: scene.title.en, beats, screenshot: shot, heroBeat: hero });
  await page.close();
}
await ctx.close();

// One story with motion: autoplay starts and the first beat gives way to the second.
const moving = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await moving.newPage();
watch(page);
await page.goto(new URL(`?scene=${ids[0]}`, base).href);
await ready(page);
await page.locator('.sp-cinema').waitFor({ state: 'visible', timeout: 60_000 });
const first = await page.evaluate(() => window.__dbg.scenePlayer.state);
await page.waitForFunction(() => window.__dbg.scenePlayer.state?.beat >= 1, null, { timeout: 60_000 }).catch(() => {});
const later = await page.evaluate(() => window.__dbg.scenePlayer.state);
report.autoplay = { first, later };
if (!first?.playing || !(later?.beat >= 1)) report.problems.push(`autoplay: ${JSON.stringify(report.autoplay)}`);
// The Stories list: one card per ready story.
await page.keyboard.press('Escape');
await press(page, '.stories-open');
await page.waitForFunction(n => document.querySelectorAll('#stories li').length === n, ids.length, { timeout: 10_000 }).catch(() => {});
report.list = await page.evaluate(() => [...document.querySelectorAll('#stories .sp-card-title')].map(e => e.textContent));
if (report.list.length !== ids.length) report.problems.push(`Stories list shows ${report.list.length} of ${ids.length}`);
await moving.close();
await browser.close();

report.errors = errors;
report.failed = failed;
console.log(JSON.stringify(report, null, 2));
process.exit(errors.length || failed.length || report.problems.length ? 1 : 0);
