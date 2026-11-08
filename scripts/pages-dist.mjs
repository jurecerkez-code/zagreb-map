// Post-process only the Pages bundle. Source modules stay directly servable with no build step.
// esbuild deliberately preserves external specifiers: dist/app.js must reach the existing ../vendor files,
// not an imaginary dist/vendor directory (and the modulepreload URLs must not fetch a second copy).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export async function rewriteDeployedPages(webRoot) {
  const indexPath = join(webRoot, 'index.html');
  const module = '<script type="module" src="app.js"></script>';
  let index = await readFile(indexPath, 'utf8');
  if (!index.includes(module)) throw new Error('web/index.html has no source app.js entry to rewrite');
  index = index.replace(module, '<script type="module" src="dist/app.js"></script>');
  await writeFile(indexPath, index);

  const dist = join(webRoot, 'dist');
  for (const name of await readdir(dist)) {
    if (!name.endsWith('.js')) continue;
    const path = join(dist, name), source = await readFile(path, 'utf8');
    const rewritten = source.replace(/(from\s*|import\s*)(["'])\.\/vendor\//g, '$1$2../vendor/');
    await writeFile(path, rewritten);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await rewriteDeployedPages(resolve('web'));
}
