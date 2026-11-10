import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A `}` with nothing open starts a qualified rule's prelude (CSS Syntax), which swallows the next rule: that is how
// the prefers-reduced-motion rule after the phone block was lost. Comments are blanked first, keeping line numbers.
test('styles.css closes only braces it opened', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  let depth = 0;
  css.split('\n').forEach((line, i) => {
    for (const ch of line) {
      depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      assert.ok(depth >= 0, `stray } on line ${i + 1}`);
    }
  });
  assert.equal(depth, 0, 'every { is closed');
});

// First paint follows the default UI chrome, not the separate default map look (Foto).
test("styles.css's :root is the default UI chrome", async () => {
  const { THEMES } = await import('../themes.js');
  const { DEFAULT_LOOK } = await import('../look.js');
  const { chromeKind, chromeTokens } = await import('../zagreb-lab.js');
  const { luma, rgb } = await import('../tone.js');
  const ui = chromeTokens(DEFAULT_LOOK), font = THEMES[chromeKind(DEFAULT_LOOK)].font;
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const root = css.match(/:root\s*\{([^}]*)\}/)[1];
  const decl = Object.fromEntries([...root.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  for (const [k, v] of Object.entries(ui)) assert.equal(decl[k], v, k);
  assert.equal(decl['--font'], `"${font}"`);
  assert.equal(decl['color-scheme'], luma(rgb(ui['--bg'])) < 0.5 ? 'dark' : 'light');
});
