import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const exists = path => existsSync(new URL(`../../${path}`, import.meta.url));

test('retired source-city assets and worker surfaces are gone, with no stale scripts', () => {
  const obsolete = [
    'src', 'e2e/worker', 'wrangler.jsonc', 'playwright.worker.config.mjs',
    'web/scenes/_stockholm', 'web/admin', 'scripts/contributions.mjs',
    'pipeline/city_stockholm.py.orig', 'pipeline/sources_stockholm.yml.orig',
    'pipeline/name_fixes_stockholm.csv.orig', 'pipeline/contributions_stockholm.csv.orig',
    '_probe', 'input',
  ];
  for (const path of obsolete) assert.equal(exists(path), false, `${path} should be retired`);
  for (const path of ['web/worker.js', 'scripts/scenes/build.mjs', 'pipeline/contributions.csv']) {
    assert.equal(exists(path), true, `${path} is still a real dependency`);
  }
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'zagreb-map');
  for (const script of ['preview:local', 'deploy:preview', 'test:worker', 'test:e2e:worker']) {
    assert.equal(pkg.scripts[script], undefined, `${script} must not point at a deleted worker`);
  }
  for (const dep of ['miniflare', 'wrangler']) assert.equal(pkg.devDependencies[dep], undefined);
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  for (const dep of ['miniflare', 'wrangler']) assert.equal(lock.packages[`node_modules/${dep}`], undefined);
});

test('retired asset references do not survive as dangling helper links', () => {
  for (const path of ['scripts/scenes/build.mjs', 'pipeline/contributions.py']) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /web\/admin|web\/scenes\/_stockholm/, path);
  }
  const description = readFileSync(new URL('../../pyproject.toml', import.meta.url), 'utf8')
    .match(/^description = "([^"]+)"/m)[1];
  assert.doesNotMatch(description, /Stockholm|husforhus|hus for hus/i);
});
