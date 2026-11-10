// A cadastre-before building (BOUND, issue #35): its card names the bound instead of a year, it offers the
// evidence form, and the legend counts it under its own heading, not as an exactly dated 1968/2007 building.
// Runs on whatever web/data/current.json names; the committed build predates BOUND, so it skips there.
import { test, expect } from '@playwright/test';

test('a bounded building says before 1968/2007 and is counted apart from dated buildings', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hfh-legend', 'open'));
  await page.goto('/?lang=en');
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });

  const found = await page.evaluate(async () => {
    const { version } = await (await fetch('data/current.json')).json();
    const config = await (await fetch(`data/${version}/zagreb.json`)).json();
    const bounds = config.bounds || {};
    if (!bounds.pre1968 && !bounds['1968_2007']) return { empty: true };
    for (let gid = 0; gid < config.stats.buildings; gid++) {
      const b = window.__dbg.building(gid);
      if (b.yflag === 8) return { gid, bounds, year: b.year, yearFrom: b.yearFrom, yearTo: b.yearTo, ysrc: b.ysrc };
    }
    return { empty: true };
  });
  test.skip(found.empty === true, 'this build has no cadastre-before (BOUND) buildings');
  expect([1968, 2007]).toContain(found.year);
  expect(found.yearFrom).toBe(0);
  expect(found.yearTo).toBe(found.year);
  expect(found.ysrc).toBe(9);

  await page.evaluate(gid => window.__dbg.pinCard(gid, 300, 300), found.gid);
  const card = page.locator('#card.pinned');
  await expect(card.locator('.card-head .y')).toHaveText(
    found.year === 1968 ? 'Built before 1968 (ZBSM)' : 'Built before the 2007 cadastre (ZBSM)');
  await expect(card.locator('.dating')).toContainText(/cadastral bound|upper bound/);
  await expect(card.locator('.year-cta a')).toHaveAttribute('href', new RegExp(`gid=${found.gid}(?:&|$)`));

  // The legend's headed counts are the build's BOUND totals; the ordinary histogram also holds exactly dated
  // 1968/2007 buildings, which must not inflate them.
  const rows = page.locator('.bound-legend .bound-row');
  await expect(rows).toHaveCount(2);
  const shown = await rows.evaluateAll(els => Object.fromEntries(els.map(el =>
    [el.dataset.bound, Number(el.querySelector('.bound-count').textContent.replace(/\D/g, ''))])));
  expect(shown).toEqual(found.bounds);
});
