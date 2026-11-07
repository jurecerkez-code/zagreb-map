import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const canonical = 'https://jurecerkez-code.github.io/zagreb-map/';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const robots = readFileSync(new URL('../robots.txt', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../sitemap.xml', import.meta.url), 'utf8');

test('public metadata points at the Zagreb mirror and explicit language locales', () => {
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
  assert.ok(html.includes(`<link rel="icon" href="favicon.svg" type="image/svg+xml">`));
  assert.ok(html.includes('name="theme-color" content="#d9dfe3"'));
  assert.ok(html.includes(`property="og:image" content="${canonical}og.png"`));
  assert.ok(html.includes('property="og:locale" content="hr_HR"'));
  assert.ok(html.includes('property="og:locale:alternate" content="en_GB"'));
  assert.ok(html.includes('https://github.com/jurecerkez-code/zagreb-map'));
  assert.ok(robots.includes(`Sitemap: ${canonical}sitemap.xml`));
  assert.ok(sitemap.includes(`<loc>${canonical}</loc>`));
  assert.ok(!robots.includes('husforhus.se') && !sitemap.includes('husforhus.se'));
});

test('public wording does not imply that every building has a verified year', () => {
  assert.match(html, /known and unknown years/i);
  assert.doesNotMatch(html, /coloured by the year it was built/i);
  const structured = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
  assert.equal(structured.url, canonical);
  assert.equal(structured.image, `${canonical}og.png`);
  assert.match(structured.description, /known and unknown years/i);
  assert.deepEqual(structured.inLanguage, ['en', 'hr']);
});

test('the share image is a real bounded PNG, not a stale named artifact', () => {
  const image = readFileSync(new URL('../og.png', import.meta.url));
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
  assert.ok(statSync(new URL('../og.png', import.meta.url)).size <= 300 * 1024);
});
