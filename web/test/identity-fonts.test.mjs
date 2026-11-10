import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const styles = readFileSync(join(root, 'web', 'styles.css'), 'utf8');
const families = ['Albert Sans', 'Familjen Grotesk', 'Inter', 'Schibsted Grotesk'];

function rangeFor(pkg, filename) {
  const rule = pkg.split(/@font-face\s*/).find(part => part.includes('./files/' + filename));
  assert.ok(rule, `package declaration missing: ${filename}`);
  return rule.match(/unicode-range:\s*([^;]+);/)[1];
}

test('every look has real latin-ext fonts and the exact package ranges', () => {
  const errors = [];
  for (const family of families) {
    const face = styles.split(/@font-face\s*/).find(part =>
      part.includes(`font-family: "${family}"`) && !part.includes('font-family: "Variable"')
    );
    if (!face) { errors.push(`${family}: no @font-face`); continue; }
    const [dir, currentFile] = /fonts\/([^/]+)\/([^")]+)\.woff2/.exec(face).slice(1);
    const filename = currentFile.replace('-latin-', '-latin-ext-') + '.woff2';
    const local = join(root, 'web', 'fonts', dir, filename);
    if (!existsSync(local)) { errors.push(`${family}: missing ${filename}`); continue; }
    if (readFileSync(local).subarray(0, 4).toString() !== 'wOF2') errors.push(`${family}: invalid WOFF2 bytes`);
    const pkg = readFileSync(join(root, 'node_modules', '@fontsource-variable', dir, 'wght.css'), 'utf8');
    const expected = rangeFor(pkg, filename);
    const matchingFaces = styles.split(/@font-face\s*/).filter(part =>
      part.includes(`font-family: "${family}"`) && part.includes(filename)
    );
    if (matchingFaces.length !== 1) errors.push(`${family}: expected one declaration for ${filename}, got ${matchingFaces.length}`);
    else if (!matchingFaces[0].includes(`unicode-range: ${expected};`)) errors.push(`${family}: wrong unicode range for ${filename}`);
    const license = join(root, 'web', 'fonts', dir, 'OFL.txt');
    if (!existsSync(license) || statSync(license).size < 100) errors.push(`${family}: OFL.txt is missing`);
  }
  assert.deepEqual(errors, []);
});

test('@zagreb-lab Inter and JetBrains Mono are real bundled latin/latin-ext variables', () => {
  const required = [
    ['Inter', 'inter', 'opsz', 'inter-latin-opsz-normal.woff2', 'inter-latin-ext-opsz-normal.woff2', '100 900'],
    ['JetBrains Mono', 'jetbrains-mono', 'wght', 'jetbrains-mono-latin-wght-normal.woff2', 'jetbrains-mono-latin-ext-wght-normal.woff2', '100 800'],
  ];
  for (const [family, dir, axis, latin, extended, weights] of required) {
    const pkg = readFileSync(join(root, 'node_modules', '@fontsource-variable', dir, `${axis}.css`), 'utf8');
    for (const filename of [latin, extended]) {
      const local = join(root, 'web', 'fonts', dir, filename);
      assert.ok(existsSync(local), `${family}: missing ${filename}`);
      if (!existsSync(local)) continue;
      assert.equal(readFileSync(local).subarray(0, 4).toString(), 'wOF2', `${filename}: WOFF2 magic bytes`);
      const face = styles.split(/@font-face\s*/).find(part => part.includes(`font-family: "${family}"`) && part.includes(filename));
      assert.ok(face, `${family}: ${filename} is declared`);
      if (!face) continue;
      assert.ok(face.includes(`font-weight: ${weights};`), `${filename}: full variable weight range`);
      assert.ok(face.includes('font-display: swap;'), `${filename}: readable fallback while loading`);
      assert.ok(face.includes(`unicode-range: ${rangeFor(pkg, filename)};`), `${filename}: exact package glyph range`);
      if (filename.includes('-ext-')) assert.match(face, /U\+0100-(?:024F|02BA)/i, `${filename}: Croatian diacritics`);
    }
    const license = join(root, 'web', 'fonts', dir, 'OFL.txt');
    assert.ok(existsSync(license) && statSync(license).size > 100, `${family}: OFL.txt`);
  }
});
