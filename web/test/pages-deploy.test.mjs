import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteDeployedPages } from '../../scripts/pages-dist.mjs';

test('deployed rewrite fixes only the deployed entry and external vendor paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'issue29-pages-'));
  const web = join(root, 'web');
  await mkdir(join(web, 'dist'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<script src="boot.js"></script>\n<script type="module" src="app.js"></script>\n');
  await writeFile(join(web, 'dist', 'app.js'), 'import*as T from"./vendor/three.module.js";import"./vendor/three.core.js";');
  await rewriteDeployedPages(web);
  const index = await readFile(join(web, 'index.html'), 'utf8');
  assert.match(index, /<script type="module" src="dist\/app\.js"><\/script>/);
  assert.match(index, /<script src="boot\.js"><\/script>/);
  assert.ok(!index.includes('src="app.js"'));
  const app = await readFile(join(web, 'dist', 'app.js'), 'utf8');
  assert.ok(!app.includes('"./vendor/'));
  assert.ok(app.includes('"../vendor/three.module.js"'));
  assert.ok(app.includes('"../vendor/three.core.js"'));
});

test('local module paths and every Pages bundle entry are explicit', async () => {
  const [index, app, roads, workflow] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../roads-layer.js', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(index, /<script type="module" src="app\.js"><\/script>/);
  for (const [source, name] of [[app, 'worker.js'], [app, 'terrain-worker.js'], [roads, 'roads-worker.js']]) {
    assert.ok(source.includes(`new Worker(new URL('${name}', import.meta.url)`), `${name} must resolve beside its module in source and dist layouts`);
  }
  for (const name of ['web/app.js', 'web/worker.js', 'web/terrain-worker.js', 'web/roads-worker.js']) assert.ok(workflow.includes(name), `${name} is not bundled by Pages`);
  assert.ok(workflow.includes('node scripts/pages-dist.mjs'));
});
