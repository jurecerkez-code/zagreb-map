import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const engine = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(engine, 'scripts', 'shots-compare.mjs');

function directory(name = 'strict-picture-') {
  return mkdtempSync(join(tmpdir(), name));
}
function inputs(mean, stddev) {
  const dir = directory();
  const baseline = join(dir, 'base.json');
  const current = join(dir, 'current.json');
  writeFileSync(baseline, JSON.stringify({ home: { mean: 80, stddev: 40 } }));
  writeFileSync(current, JSON.stringify({ home: { mean, stddev } }));
  return { baseline, current };
}
function run(files, strict) {
  return spawnSync(process.execPath, [cli, files.current, files.baseline, ...(strict ? ['--strict'] : [])], {
    cwd: engine, encoding: 'utf8',
  });
}

test('strict picture gate refuses a loss beyond renderer noise', () => {
  const files = inputs(80, 40 * 0.989);
  const legacy = run(files, false);
  assert.equal(legacy.status, 0, legacy.stderr);
  const strict = run(files, true);
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stdout + strict.stderr, /picture gate FAILED/);
  assert.equal(run(inputs(80, 40 * 0.995), true).status, 0, '0.5% is SwiftShader noise, not a regression');
});

test('strict picture gate permits equal baseline and its 1.25 mean ceiling, not 1.251', () => {
  assert.equal(run(inputs(80, 40), true).status, 0);
  assert.equal(run(inputs(80 * 1.25, 40), true).status, 0);
  assert.equal(run(inputs(80 * 1.251, 40), true).status, 1);
});

test('strict picture gate allows half a percent of mean noise, not a one-and-a-half percent drop', () => {
  assert.equal(run(inputs(80 * 0.995, 40), true).status, 0, '0.5% mean is SwiftShader noise');
  assert.equal(run(inputs(80 * 0.985, 40), true).status, 1, '1.5% mean is a regression, not noise');
});

test('strict picture gate does not permit the older five-percent mean drop', () => {
  assert.equal(run(inputs(80 * 0.97, 40), false).status, 0);
  assert.equal(run(inputs(80 * 0.97, 40), true).status, 1);
});

test('a per-platform baseline wins over the shared one', () => {
  const files = inputs(80, 40);
  const platform = files.baseline.replace(/\.json$/, `.${process.platform}.json`);
  writeFileSync(platform, JSON.stringify({ home: { mean: 100, stddev: 40 } }));
  assert.equal(run(files, true).status, 1, 'the platform mean must replace the shared 80');
  writeFileSync(platform, JSON.stringify({ home: { mean: 80, stddev: 40 } }));
  assert.equal(run(files, true).status, 0, 'the same reading passes the platform baseline');
});

test('CI invokes the picture comparison with the strict gate, not just support for it', () => {
  const workflow = readFileSync(join(engine, '.github', 'workflows', 'ci.yml'), 'utf8');
  const command = workflow.split(/\r?\n/).find(line => line.includes('node scripts/shots-compare.mjs'));
  assert.ok(command, 'the workflow must include a picture comparison step');
  assert.match(command, /node\s+scripts\/shots-compare\.mjs\s+.*\s--strict(?:\s|$)/,
    'the CI command must opt into the 1% noise floor and the 0.99x to 1.25x mean bounds');
});
