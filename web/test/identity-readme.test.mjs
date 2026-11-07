import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../data/current.json', import.meta.url), 'utf8')).version;
const config = JSON.parse(readFileSync(new URL(`../data/${version}/zagreb.json`, import.meta.url), 'utf8'));
const knownYears = Object.entries(config.stats.byFlag)
  .filter(([key]) => key !== 'unknown')
  .reduce((total, [, value]) => total + value, 0);

test('README matches the shipped build commands, dataset facts and fork identity', () => {
  assert.ok(readme.startsWith('# Zagreb, building by building'));
  assert.ok(readme.includes('https://jurecerkez-code.github.io/zagreb-map/'));
  assert.ok(readme.includes('https://github.com/jurecerkez-code/zagreb-map'));
  // Upstream lineage and the legacy-test inventory are facts, not stale site branding.
  assert.doesNotMatch(readme, /husforhus\.se|every building in Stockholm/i);
  assert.ok(readme.includes(`web/data/${version}/`));
  assert.ok(readme.includes(`${config.stats.buildings.toLocaleString('en-US')}`));
  assert.ok(readme.includes(`${knownYears.toLocaleString('en-US')}`));
  assert.ok(readme.includes(`${config.stats.byFlag.unknown.toLocaleString('en-US')}`));
  for (const step of ['s01_zagreb', 's02_lod2', 's02_zagreb_curated', 's03_tiles', 's14_search', 's99_validate']) {
    assert.ok(readme.includes(step), `README must document ${step} before s99_validate`);
  }
  assert.ok(readme.includes('HFH_NO_CURRENT=1'));
  assert.ok(readme.includes('node scripts/web-tests.mjs'));
  assert.ok(readme.includes('npx playwright test e2e/fonts.spec.mjs'));
  for (const file of ['web/og.png', 'scripts/serve.py', 'pipeline/sources.yml', 'e2e/fonts.spec.mjs']) {
    assert.ok(readme.includes(file), `README must link ${file}`);
    assert.ok(existsSync(new URL(`../../${file}`, import.meta.url)), `${file} must exist`);
  }
});
