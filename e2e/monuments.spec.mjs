import { test, expect } from '@playwright/test';
import { settled } from './settled.mjs';

// A fixed, representative acceptance set: dated and undated records, with and
// without photographs, statues, busts and the St George column.
const FIXED_MONUMENTS = [
  { id: 'way/587745586', name: 'Ban Josip Jelačić 1801-1859' },
  { id: 'node/2781030166', name: 'Sveti Juraj ubija zmaja' },
  { id: 'way/580200893', name: 'Kralj Tomislav' },
  { id: 'way/753634242', name: 'August Šenoa' },
  { id: 'way/581658851', name: 'Nikola Tesla 1856-1943' },
  { id: 'way/580203365', name: 'Josip Juraj Strossmayer 1815-1905' },
  { id: 'way/753689305', name: 'Marija Jurić Zagorka 1873-1957' },
  { id: 'node/419216716', name: 'Marko Marulić' },
  { id: 'way/587746675', name: 'Petar Preradović 1818-1872' },
  { id: 'node/11088926293', name: 'Juraj Habdelić' },
];

const MIN_CANVAS_VARIANCE = 100;

async function loadSelection(page, selection) {
  await page.goto('?lang=hr');
  await expect(page.locator('#loading')).toBeHidden({ timeout: 90000 });
  // The cards draw their own 512×384 render; the ground rising (minutes under software GL) changes nothing they
  // assert, so this spec does not wait for the heights.
  await settled(page, { terrain: false });
  await expect.poll(() => page.evaluate(() => window.__dbg.monuments?.list.length || 0), { timeout: 60_000 }).toBeGreaterThan(0);

  const records = await page.evaluate(requested => requested.map(item => {
    const m = window.__dbg.monuments.list.find(monument => monument.id === item.id);
    return m ? {
      id: m.id,
      name: m.name,
      year: m.year ?? null,
      yearSource: m.ysrc || null,
      photoKey: m.photo?.key || null,
    } : null;
  }), selection);
  expect(records.map(record => record && { id: record.id, name: record.name })).toEqual(selection);
  return records;
}

async function pinMonument(page, id) {
  await page.evaluate(monumentId => {
    const m = window.__dbg.monuments.list.find(monument => monument.id === monumentId);
    if (!m) throw new Error(`Monument not loaded: ${monumentId}`);
    const p = window.__dbg.monuments.screenAt(m);
    const clipped = p.x < 24 || p.y < 100 || p.x > innerWidth - 100 || p.y > innerHeight - 100;
    window.__dbg.pinMonument(m,
      clipped ? innerWidth * 0.55 : p.x,
      clipped ? innerHeight * 0.45 : p.y);
  }, id);
  const card = page.locator('#card.monument.pinned');
  await expect(card).toBeVisible();
  return card;
}

async function showMapRender(card, record) {
  const canvas = card.locator('.monument-render-canvas');
  if (record.photoKey) {
    await expect(canvas).toBeHidden();
    const mapTab = card.getByRole('tab', { name: 'Prikaz na karti', exact: true });
    await mapTab.click();
    await expect(mapTab).toHaveAttribute('aria-selected', 'true');
  } else {
    // Photo-less records deliberately have no tabs: the render is visible at once.
    await expect(card.locator('.photo')).toHaveCount(0);
    await expect(card.getByRole('tab', { name: 'Prikaz na karti', exact: true })).toHaveCount(0);
  }
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-monument-id', record.id);
  return canvas;
}

async function expectNonblankCanvas(canvas) {
  expect(await canvas.evaluate(el => [el.width, el.height])).toEqual([512, 384]);
  const variance = await canvas.evaluate(el => {
    const { data } = el.getContext('2d').getImageData(0, 0, el.width, el.height);
    let sum = 0, squares = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luminance;
      squares += luminance * luminance;
      count++;
    }
    return squares / count - (sum / count) ** 2;
  });
  expect(variance).toBeGreaterThan(MIN_CANVAS_VARIANCE);
}

async function verifyMonument(page, record, { cachedReopen = false } = {}) {
  let card = await pinMonument(page, record.id);
  await expect(card.locator('#card-title')).toHaveText(record.name);

  const dating = card.locator('.dating');
  if (record.year === null) {
    await expect(dating).toContainText('Godina otkrivanja nije poznata');
    await expect(card.locator('.monument-year-source')).toHaveCount(0);
  } else {
    expect(record.yearSource, `${record.name} has a source for its year`).toBeTruthy();
    await expect(dating).toContainText(String(record.year));
    await expect(card.locator('.monument-year-source')).toBeVisible();
    await expect(card.locator('.monument-year-source')).toHaveText(record.yearSource);
  }

  if (record.photoKey) {
    const photo = card.locator('.photo img');
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute('src', `data/photos/${record.photoKey}`);
    await expect.poll(() => photo.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  }

  const canvas = await showMapRender(card, record);
  await expectNonblankCanvas(canvas);

  if (cachedReopen) {
    await page.evaluate(() => {
      window.__issue31OriginalCanvas = document.querySelector('#card .monument-render-canvas');
    });
    await card.locator('.card-close').click();
    await expect(page.locator('#card.pinned')).toHaveCount(0);

    card = await pinMonument(page, record.id);
    const reopenedCanvas = await showMapRender(card, record);
    expect(await reopenedCanvas.evaluate(el => el === window.__issue31OriginalCanvas)).toBe(true);
    await expectNonblankCanvas(reopenedCanvas);
    await page.evaluate(() => { delete window.__issue31OriginalCanvas; });
  }

  await card.locator('.card-close').click();
  await expect(page.locator('#card.pinned')).toHaveCount(0);
}

test('issue #31: ten fixed monuments have evidence, media and a nonblank render', async ({ page }) => {
  const records = await loadSelection(page, FIXED_MONUMENTS);
  for (const [index, record] of records.entries()) {
    await test.step(`${index + 1}/10 ${FIXED_MONUMENTS[index].name}`, async () => {
      await verifyMonument(page, record, { cachedReopen: index === 0 });
    });
  }
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a photo-less card opens and reuses its visible map render', async ({ page }) => {
    // Juraj Habdelić has neither a photo nor a year, so the card shows the render alone, with no tabs at all.
    const [record] = await loadSelection(page, [FIXED_MONUMENTS[9]]);
    expect(record.photoKey).toBeNull();
    await verifyMonument(page, record, { cachedReopen: true });
  });
});
