import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';

// This file runs against the whole city, not a fixture: perf.mjs budgets 180s for that load alone, and axe over the
// result takes tens of seconds more on a software-GL runner. 240s is the load budget plus the assertions.
test.describe.configure({ timeout: 240_000 });

// Deliberately separate from e2e/a11y.spec.mjs so this issue remains independent
// of the parent's current fixture and browser work. Run with scripts/serve.mjs.
const errorsByPage = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  errorsByPage.set(page, errors);
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()} (${msg.location().url})`); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`http: ${response.status()} ${response.url()}`); });
  // ERR_ABORTED is Chromium's client-side cancellation during fixture teardown, not a failed HTTP asset.
  // Successful map completion is asserted below; all HTTP errors and non-abort request failures still fail.
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText || '';
    if (reason !== 'net::ERR_ABORTED') errors.push(`requestfailed: ${request.url()} ${reason}`);
  });
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
});
test.afterEach(async ({ page }) => {
  // Two optional local routes, both known to 404 on a static server and both named by scripts/boot_smoke.mjs:
  // build.json is deploy metadata, and /rt is the live-tram feed scripts/serve.py injects (the page falls back to
  // the timetable and to the published snapshot when it answers 404). Every other asset must answer below 400.
  const errors = (errorsByPage.get(page) || []).filter(error => !/\/(?:build\.json|rt)(?:\s|\)|$)/.test(error));
  expect(errors, 'no browser JavaScript or required-resource errors').toEqual([]);
});

async function open(page, query = '?lang=en&try=scenes,search,walks') {
  await page.goto('/' + query);
  await expect(page.locator('#loading')).toBeHidden({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  // The live tram feed prevents a network-idle wait. Wait for every map pack instead,
  // so teardown cannot abort an in-flight city stream and masquerade as an app failure.
  // 180s: the whole city is 437 packs, and a software-GL runner (perf.mjs's comment says 15 min
  // for the same load) needs far more than the 60s a fixture does; CI's own load budget is 180s.
  await expect.poll(() => page.evaluate(() => {
    const stats = window.__dbg.stats();
    return stats.tiles > 0 && stats.tiles === stats.tilesTotal;
  }), { timeout: 180_000 }).toBe(true);
}
async function serious(page) {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }));
}

// Panels are glass, so what a label reads against is the photograph behind the panel at 72% opacity, not a
// token. Hide the panel, photograph its rect, take the brightest pixel behind it, composite the label's own
// background chain over that pixel, and hold the WCAG line: 4.5:1, or 3:1 for large text (24px, 18.66px bold).
const numbers = css => (css.match(/[\d.]+/g) || [0, 0, 0, 1]).map(Number);
const linear = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const over = (top, under) => {
  const a = top.length > 3 ? top[3] : 1;
  return [0, 1, 2].map(i => Math.round(top[i] * a + under[i] * (1 - a)));
};

async function glassContrast(page, selector) {
  const panel = page.locator(selector).first();
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  const leaves = await page.evaluate(sel => {
    const panel = document.querySelector(sel);
    return [...panel.querySelectorAll('*')].filter(node => {
      const own = [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim());
      const rect = node.getBoundingClientRect();
      return own && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    }).map(node => {
      const chain = [];
      for (let a = node; a; a = a.parentElement) {
        const bg = getComputedStyle(a).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(bg)) chain.push(bg);
        if (a === panel) break;
      }
      const style = getComputedStyle(node);
      return { text: node.textContent.trim().slice(0, 32), color: style.color, size: parseFloat(style.fontSize), weight: Number(style.fontWeight), chain };
    });
  }, selector);
  await page.evaluate(sel => { document.querySelector(sel).style.visibility = 'hidden'; }, selector);
  const png = await page.screenshot({ clip, timeout: 180_000 });
  await page.evaluate(sel => { document.querySelector(sel).style.visibility = ''; }, selector);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let behind = [0, 0, 0], brightest = -1;
  for (let i = 0; i < data.length; i += info.channels) {
    const pixel = [data[i], data[i + 1], data[i + 2]];
    const lit = luminance(pixel);
    if (lit > brightest) { brightest = lit; behind = pixel; }
  }
  return leaves.map(leaf => {
    let ground = behind;
    for (let i = leaf.chain.length - 1; i >= 0; i--) ground = over(numbers(leaf.chain[i]), ground);
    const large = leaf.size >= 24 || (leaf.size >= 18.66 && leaf.weight >= 700);
    return { ...leaf, ratio: contrast(numbers(leaf.color), ground), need: large ? 3 : 4.5, ground };
  });
}
const offenders = rows => rows.filter(row => row.ratio < row.need)
  .map(row => `"${row.text}" ${row.ratio.toFixed(2)}:1 < ${row.need}:1 (${row.size}px/${row.weight} on rgb(${row.ground.join(',')}))`);

test('@zagreb-lab @design-a11y desktop first-run tokens, local fonts and every Look application', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'foto');
  expect(await page.evaluate(() => window.__dbg.stats().theme)).toBe('foto');
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'lab');
  const tokens = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const sky = css.getPropertyValue('--sky').trim();
    return {
      bg: css.getPropertyValue('--bg').trim(), sky,
      timeline: getComputedStyle(document.querySelector('.timeline')).backgroundColor,
      panel: getComputedStyle(document.querySelector('#panel')).backgroundColor,
      font: css.getPropertyValue('--font').trim(), overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(tokens.bg).toBe('#0b0d33');
  // Panels are glass (the issue's system): the legend and the timeline share one translucent ground over the
  // map, --ui-glass, and not an opaque navy that would hide the photograph behind them.
  expect(tokens.timeline).toBe(tokens.panel);
  const [r, g, b, a] = numbers(tokens.panel);
  expect([r, g, b]).toEqual([11, 13, 51]);
  expect(a).toBeCloseTo(0.72, 2);
  expect(tokens.font).toContain('Inter');
  expect(tokens.overflow).toBe(false);
  const fonts = await page.evaluate(async () => {
    await document.fonts.load('500 16px Inter', 'Zagreb Č Ć Ž Š Đ č ć ž š đ');
    return {
      check: document.fonts.check('500 16px Inter', 'Zagreb'),
      loaded: performance.getEntriesByType('resource').filter(r => /inter\/inter-latin(?:-ext)?-wght-normal\.woff2$/.test(r.name)).map(r => r.name),
    };
  });
  expect(fonts.check).toBe(true);
  expect(fonts.loaded.length).toBeGreaterThan(0);

  const dock = page.locator('.corner .buttons > button:visible');
  await expect(dock).toHaveCount(5);
  await expect(page.locator('#lab-layers')).toBeVisible();
  await expect(page.locator('.search-open')).toBeVisible();
  await expect(page.locator('.sun-mode')).toBeVisible();
  await expect(page.locator('#lab-more-button')).toBeVisible();
  await page.locator('.look-open').click();
  await expect(page.locator('#look')).toBeVisible();
  await expect(page.locator('#look')).toContainText('Zagreb Lab');
  await expect(page.locator('#look')).toContainText('Foto');
  await expect(page.locator('#look')).toContainText('Classic');
  await page.keyboard.press('Escape');
  await expect(page.locator('.look-open')).toBeFocused();
  expect(await serious(page)).toEqual([]);
});

test('@zagreb-lab @design-a11y text on glass clears 4.5:1 over the brightest Foto ground behind each panel', async ({ page }) => {
  // Three panels, each measured from a real screenshot of the ground behind it: the load is the whole city,
  // and a software-GL runner photographs slowly, so this one is budgeted, not retried.
  test.setTimeout(600_000);
  await open(page);
  expect(offenders(await glassContrast(page, '#panel')), 'legend').toEqual([]);
  await page.evaluate(() => window.__dbg.pinCard(window.__dbg.photoGids[0], innerWidth / 2, innerHeight / 2));
  await expect(page.locator('#card')).toBeVisible();
  expect(offenders(await glassContrast(page, '#card')), 'record card').toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('#lab-more-button').click();
  await page.locator('.about-open').click();
  await expect(page.locator('#about')).toBeVisible();
  expect(offenders(await glassContrast(page, '#about')), 'about').toEqual([]);
});

test('@zagreb-lab More uses the real secondary controls and returns keyboard focus', async ({ page }) => {
  await open(page);
  const trigger = page.locator('#lab-more-button');
  await trigger.click();
  const dialog = page.locator('#lab-more');
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.locator('.north-open')).toBeVisible();
  await expect(dialog.locator('.stories-open')).toBeVisible();
  await expect(dialog.locator('.postcard-open')).toBeVisible();
  await expect(dialog.locator('.about-open')).toBeVisible();
  await expect(dialog.locator('[data-lang="en"]')).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
    expect(await page.evaluate(() => document.querySelector('#lab-more').contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

});

test('@zagreb-lab Paper restores the original controls and exact Calliope ground', async ({ page }) => {
  await open(page, '?lang=en&theme=arg&try=scenes,search,walks');
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'paper');
  await expect(page.locator('.corner .buttons > .north-open')).toBeVisible();
  await expect(page.locator('.about-open')).toBeVisible(); // upstream keeps About beside the language buttons
  await expect(page.locator('#lab-more-button')).toBeHidden();
  await expect(page.locator('#lab-layers')).toBeHidden();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  expect(bg).toBe('#F4EFE6');
});

test('@zagreb-lab Layers and Search preserve the current map behavior', async ({ page }) => {
  await open(page);
  const layers = page.locator('#lab-layers');
  const panel = page.locator('#panel');
  await layers.click();
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(layers).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.search-open').click();
  await expect(page.locator('.search')).toHaveClass(/open/);
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.locator('.search-cancel').click();
  await expect(page.locator('.search')).not.toHaveClass(/open/);
  await expect(page.locator('.search-open')).toBeFocused();
});

test('@zagreb-lab Croatian is real translated chrome, not an English mockup', async ({ page }) => {
  await open(page, '?lang=hr&try=scenes,search,walks');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hr');
  await expect(page.locator('#lab-layers')).toContainText('Slojevi');
  await expect(page.locator('.sun-mode')).toContainText('Sunce');
  await expect(page.locator('.look-open')).toContainText('Izgled');
  await page.locator('#lab-more-button').click();
  await expect(page.locator('#lab-more-title')).toHaveText('Više');
  await expect(page.locator('#lab-more-items .north-open')).toContainText('Sjever');
  await expect(page.locator('#lab-spec')).toContainText('Podloga');
});

test.describe('@zagreb-lab phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('bottom sheet, legend and dock fit without horizontal overflow @design-a11y', async ({ page }) => {
    await open(page, '?lang=hr&try=scenes,search,walks');
    await page.locator('#lab-more-button').click();
    const dialog = page.locator('#lab-more');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.width).toBeGreaterThanOrEqual(389);
    expect(box.y + box.height).toBeLessThanOrEqual(845);
    const touches = dialog.locator('#lab-more-items > button:visible, .lang > button:visible');
    for (const el of await touches.all()) expect((await el.boundingBox()).height).toBeGreaterThanOrEqual(43);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await serious(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.locator('#lab-layers').click();
    await expect(page.locator('#panel')).not.toHaveClass(/collapsed/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('reduced motion leaves no Lab fade animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await page.locator('#lab-more-button').click();
    const name = await page.locator('#lab-more').evaluate(el => getComputedStyle(el).animationName);
    expect(name).toBe('none');
  });
});
