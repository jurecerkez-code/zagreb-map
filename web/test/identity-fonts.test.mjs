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
