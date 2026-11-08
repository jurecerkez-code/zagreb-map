import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
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

test('generated dist resolves and executes the dynamic fflate fallback', async () => {
  const scratch = join(process.env.LOCALAPPDATA || tmpdir(), 'hermes', 'cache', 'scratch');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'issue29-dist-gzip-'));
  const web = join(root, 'web'), dist = join(web, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(web, 'index.html'), '<script type="module" src="app.js"></script>');
  await cp(fileURLToPath(new URL('../vendor', import.meta.url)), join(web, 'vendor'), { recursive: true });
  await build({ entryPoints: { app: fileURLToPath(new URL('../gz.js', import.meta.url)) }, bundle: true,
    format: 'esm', splitting: true, minify: true, outdir: dist, external: ['./vendor/*'], logLevel: 'silent' });
  const before = await readFile(join(dist, 'app.js'), 'utf8');
  assert.match(before, /import\(["']\.\/vendor\/fflate\.js["']\)/, 'this fixture must exercise the dynamic import');
  await rewriteDeployedPages(web);
  const emitted = await readFile(join(dist, 'app.js'), 'utf8');
  assert.match(emitted, /import\(["']\.\.\/vendor\/fflate\.js["']\)/);
  const native = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    const { gunzip } = await import(pathToFileURL(join(dist, 'app.js')).href);
    const decoded = await gunzip(gzipSync(Buffer.from('actual generated dist fallback')));
    assert.equal(Buffer.from(decoded).toString(), 'actual generated dist fallback');
  } finally {
    globalThis.DecompressionStream = native;
  }
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
