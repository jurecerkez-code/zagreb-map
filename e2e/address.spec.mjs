// Address coverage: 30 addresses sampled from this build's own index must each fly to their
// building and open its card. The sample is seeded, so a failure names the same addresses on a rerun.
// Runs on whatever web/data/current.json names.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { settled } from './settled.mjs';

test.setTimeout(300_000);
const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/addresses.json', import.meta.url), 'utf8'));

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  return errors;
}

async function open(page) {
  await page.goto('/');
  await settled(page);
}

test('30 sampled addresses each fly to their building and open its card', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  expect(SAMPLE).toHaveLength(30);
  const input = page.getByRole('combobox');
  for (const a of SAMPLE) {
    if (!(await input.isVisible().catch(() => false))) await page.locator('.search-open').click();
    await expect(input).toBeVisible();
    await input.fill(`${a.street} ${a.number}`);
    await expect(page.getByRole('option').first()).toContainText(a.street, { timeout: 10_000 });
    await page.getByRole('option').first().click();
    await expect.poll(() => page.evaluate(() => window.__dbg.pinned), { timeout: 10_000 }).toBe(a.gid);
    await expect(page.locator('#card.pinned')).toBeVisible();
    await expect(page.locator('#card.pinned')).toContainText(a.street);
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});
