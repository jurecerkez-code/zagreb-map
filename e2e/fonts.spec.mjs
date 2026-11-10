import { test, expect } from '@playwright/test';

const families = ['Albert Sans', 'Familjen Grotesk', 'Inter', 'JetBrains Mono', 'Schibsted Grotesk'];
const croatian = 'čćđšžČĆĐŠŽ';

test('every look renders Croatian letters from the self-hosted latin-ext font', async ({ page }) => {
  const failures = [];
  page.on('response', response => {
    if (response.url().endsWith('.woff2') && response.status() >= 400) failures.push(response.url());
  });
  const loadedFiles = new Set();
  page.on('response', response => {
    if (response.url().endsWith('.woff2')) loadedFiles.add(new URL(response.url()).pathname.split('/').pop());
  });
  await page.goto('/test/font-fixture.html');
  const results = await page.evaluate(async ({ families, croatian }) => {
    await Promise.all(families.map(family => document.fonts.load(`600 16px "${family}"`, croatian)));
    await document.fonts.ready;
    return families.map(family => ({ family, valid: document.fonts.check(`600 16px "${family}"`, croatian) }));
  }, { families, croatian });
  const expectedFiles = ['albert-sans', 'familjen-grotesk', 'inter', 'jetbrains-mono', 'schibsted-grotesk']
    .map(family => `${family}-latin-ext-wght-normal.woff2`).sort();
  expect([...loadedFiles].filter(file => file.includes('-latin-ext-')).sort()).toEqual(expectedFiles);
  expect(results).toEqual(families.map(family => ({ family, valid: true })));
  expect(failures).toEqual([]);
});
