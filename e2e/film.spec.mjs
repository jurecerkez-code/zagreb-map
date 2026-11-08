import { test, expect } from '@playwright/test';

async function openFilm(page, seconds = 30) {
  await page.goto(`/?film=${seconds}`);
  await expect(page.locator('#loading')).toBeHidden({ timeout: 180_000 });
  await page.evaluate(() => {
    window.filmSamples = [];
    const read = () => {
      const state = window.__dbg?.playState?.();
      if (state) {
        const sample = { ...state, time: performance.now(), count: document.getElementById('count').textContent };
        window.filmSamples.push(sample);
      }
    };
    read();
    window.filmRecorder = setInterval(read, 200);
  });
}

async function record(page) {
  return page.evaluate(() => {
    clearInterval(window.filmRecorder);
    return window.filmSamples;
  });
}

function ascending(rows) {
  return rows.every((row, i) => i === 0 || row.year >= rows[i - 1].year);
}

test('Play runs the whole story, resumes a pause, and resets a moved handle', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await openFilm(page);
  const initialHandle = page.locator('.grip-to');
  await initialHandle.focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 12; i++) await page.keyboard.press('PageDown');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await expect(initialHandle).toHaveAttribute('aria-valuenow', '1900');
  const first = await page.evaluate(() => {
    window.filmPauseSnapshot = null;
    window.filmPauseTrigger = setInterval(() => {
      const state = window.__dbg.playState();
      if (window.filmPauseSnapshot === null && state.playing && state.year >= 1613) {
        document.getElementById('play').click();
        window.filmPauseSnapshot = window.__dbg.playState();
        clearInterval(window.filmPauseTrigger);
      }
    }, 200);
    document.getElementById('play').click();
    // Record the actual start here; a slow first animation frame must not move the sampled start forward.
    window.filmSamples.push({ ...window.__dbg.playState(), time: performance.now() });
    const note = document.getElementById('film-unknown-note');
    return { ...window.__dbg.playState(), count: document.getElementById('count').textContent,
      note: { hidden: note.hidden, text: note.textContent, visible: note.getClientRects().length > 0 } };
  });
  expect(first.playing).toBe(true);
  expect(first.year).toBeLessThanOrEqual(1205);
  expect(first.count).toMatch(/with a known year|s poznatom godinom/);
  expect(first.note.hidden).toBe(false);
  expect(first.note.visible).toBe(true);
  expect(first.note.text).toMatch(/no known year|bez poznate godine/);

  await expect.poll(() => page.evaluate(() => Boolean(window.filmPauseSnapshot)), { timeout: 90_000 }).toBe(true);
  const paused = await page.evaluate(() => window.filmPauseSnapshot);
  expect(paused.playing).toBe(false);
  expect(paused.year).not.toBe(2026);

  await page.locator('#play').click();
  const resumed = await page.evaluate(() => window.__dbg.playState());
  console.log('[film states]', JSON.stringify({ first, paused, resumed }));
  expect(resumed.playing).toBe(true);
  expect(resumed.year).toBeGreaterThanOrEqual(paused.year);

  await expect.poll(() => page.evaluate(() => !window.__dbg.playState().playing), { timeout: 90_000 }).toBe(true);
  const ended = await page.evaluate(() => ({
    ...window.__dbg.playState(),
    yearType: typeof window.__dbg.playState().year,
    count: document.getElementById('count').textContent,
  }));
  console.log('[film ended]', JSON.stringify(ended));
  expect(ended.playing).toBe(false);
  expect(ended.year).toBe(2026);
  expect(ended.yearType).toBe('number');
  await expect(page.locator('#film-unknown-note')).toContainText(/no known year|bez poznate godine/);
  const rows = await record(page);
  const filmRows = rows.slice(rows.findIndex(row => row.playing));
  const started = filmRows.filter(row => row.playing);
  expect(started.length).toBeGreaterThan(0);
  expect(started[0].year).toBeLessThanOrEqual(1205);
  expect(ascending(filmRows), JSON.stringify(filmRows)).toBe(true);
  const tally = await page.evaluate(async year => {
    const { version } = await (await fetch('/data/current.json')).json();
    const cfg = await (await fetch(`/data/${version}/zagreb.json`)).json();
    const { countDatedAt } = await import('/timeline.js');
    const lang = document.documentElement.lang.startsWith('hr') ? 'hr' : 'en';
    const strings = await (await fetch(`/i18n/${lang}.json`)).json();
    const count = countDatedAt(year, cfg.histogram, cfg.histogramEst);
    return { count,
      total: cfg.stats.buildings - cfg.unknown,
      text: strings['ui.film.known'].replace('{n}', new Intl.NumberFormat(lang).format(count)) };
  }, 2026);
  expect(tally.count).toBe(tally.total);
  expect(ended.count).toBe(tally.text);
  console.log('[film tally]', JSON.stringify(tally));
  console.log('[film] start, pause, resume, finish', JSON.stringify({ first: started[0], paused, resumed, end: rows.at(-1) }));

  const to = page.locator('.grip-to');
  await to.focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 12; i++) await page.keyboard.press('PageDown');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await expect(to).toHaveAttribute('aria-valuenow', '1900');
  await page.locator('#play').click({ modifiers: ['Shift'] });
  const powerUserStart = await page.evaluate(() => window.__dbg.playState());
  expect(powerUserStart.year).toBeGreaterThanOrEqual(1900);
  await page.locator('#play').click();
  expect(errors).toEqual([]);
  const tooltips = await page.evaluate(async () => {
    const expected = [];
    for (const lang of ['hr', 'en']) {
      const strings = await (await fetch(`/i18n/${lang}.json`)).json();
      expected.push(strings['ui.film.playHint']);
    }
    const actual = [];
    for (const lang of ['hr', 'en']) {
      document.querySelector(`.lang [data-lang="${lang}"]`).click();
      actual.push(document.getElementById('play').title);
    }
    return { actual, expected };
  });
  expect(tooltips.actual).toEqual(tooltips.expected);
});

test('a fractional pause resumes without rewinding or repeating camera orbit', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openFilm(page);
  const azimuth = () => page.evaluate(() => window.__dbg.controls.getAzimuthalAngle());
  const start = await azimuth();
  await page.locator('#play').click();
  await expect.poll(() => page.evaluate(() => window.__dbg.playState().year > 1201), { timeout: 90_000 }).toBe(true);
  const paused = await page.evaluate(() => {
    if (Number.isInteger(window.__dbg.uniforms.uYear.value)) window.__dbg.uniforms.uYear.value += 0.25;
    document.getElementById('play').click();
    return { state: window.__dbg.playState(), azimuth: window.__dbg.controls.getAzimuthalAngle() };
  });
  expect(paused.state.playing).toBe(false);
  expect(Math.abs(paused.state.year - Math.round(paused.state.year))).toBeGreaterThan(0);
  const resumed = await page.evaluate(() => {
    document.getElementById('play').click();
    return { state: window.__dbg.playState(), azimuth: window.__dbg.controls.getAzimuthalAngle() };
  });
  expect(resumed.state.playing).toBe(true);
  expect(resumed.state.year).toBeGreaterThanOrEqual(paused.state.year);
  expect(Math.abs(resumed.azimuth - paused.azimuth)).toBeLessThan(1e-9);
  await expect.poll(() => page.evaluate(() => !window.__dbg.playState().playing), { timeout: 90_000 }).toBe(true);
  const end = await azimuth();
  const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
  console.log('[orbit after pause]', { delta, paused: paused.state, resumed: resumed.state });
  expect(delta).toBeCloseTo(Math.PI / 9, 8);
  expect(errors).toEqual([]);
  await record(page);
});

test('the film makes one twenty-degree orbit, or none under reduced motion', async ({ page }) => {
  test.setTimeout(180_000);
  const angle = () => page.evaluate(() => window.__dbg.controls.getAzimuthalAngle());
  for (const reduced of [false, true]) {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await openFilm(page, 1);
    const start = await angle();
    await page.locator('#play').click();
    await expect.poll(() => page.evaluate(() => !window.__dbg.playState().playing), { timeout: 90_000 }).toBe(true);
    const end = await angle();
    const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
    console.log('[orbit] reduced=' + reduced, delta);
    expect(Math.abs(delta)).toBeCloseTo(reduced ? 0 : Math.PI / 9, 3);
    await record(page);
  }
});
