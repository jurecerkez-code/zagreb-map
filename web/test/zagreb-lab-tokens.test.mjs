import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAB_UI, PAPER_UI, chromeKind, chromeTokens } from '../zagreb-lab.js';
import { DEFAULT_LOOK } from '../look.js';
import { rgb, lin } from '../tone.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const required = {
  '--ui-bg': '#0b0d33',
  '--ui-glass': 'rgba(11,13,51,.66)',
  '--ui-surface': '#161a78',
  '--ui-line': 'rgba(92,92,255,.16)',
  '--ui-line-strong': 'rgba(92,92,255,.24)',
  '--ui-fg': '#ecebf7',
  '--ui-muted': '#9a9ccc',
  '--ui-faint': '#6b6fa8',
  '--ui-gold': '#d8b55a',
  '--ui-gold-light': '#edd18f',
  '--ui-link': '#8f96ff',
  '--ui-ok': '#6ee7a8',
  '--ui-bad': '#ff6b81',
  '--paper': '#F4EFE6', '--red': '#FE2A00',
  '--step': '8px',
  '--display': '"Inter Display",sans-serif',
  '--mono': '"JetBrains Mono",ui-monospace,monospace',
};
const contrast = (a, b) => {
  const [hi, lo] = [a, b].map(hex => rgb(hex).map(lin).reduce((y, c, i) => y + c * [0.2126, 0.7152, 0.0722][i], 0)).sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('@zagreb-lab exact shared Lab tokens exist in JS and first-paint CSS', () => {
  for (const [key, value] of Object.entries(required)) assert.equal(LAB_UI[key], value, key);
  const root = styles.match(/:root\s*\{([^}]*)\}/)?.[1] || '';
  for (const [key, value] of Object.entries(required)) {
    assert.match(root, new RegExp(`${key}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;`), `first paint ${key}`);
  }
});

test('@zagreb-lab Paper is an accessible alternative, not a dark transparency composited over light geometry', () => {
  assert.equal(PAPER_UI['--ui-bg'], '#F4EFE6');
  assert.equal(PAPER_UI['--ui-fg'], '#171717');
  assert.equal(PAPER_UI['--ui-gold'], '#FE2A00');
  assert.equal(PAPER_UI['--ui-surface'], '#FAF7F1');
  for (const ground of [PAPER_UI['--ui-bg'], PAPER_UI['--ui-surface']]) {
    assert.ok(contrast(PAPER_UI['--ui-fg'], ground) >= 7);
    assert.ok(contrast(PAPER_UI['--ui-muted'], ground) >= 4.5);
    assert.ok(contrast(PAPER_UI['--ui-link'], ground) >= 4.5);
    assert.ok(contrast(PAPER_UI['--ui-gold'], ground) >= 3, 'red is a non-text accent');
  }
  assert.ok(!PAPER_UI['--ui-glass'].includes('11,13,51'));
});

test('@zagreb-lab default Foto scene uses Lab chrome; only Classic-family looks opt into Paper', () => {
  assert.equal(DEFAULT_LOOK, 'foto');
  assert.equal(chromeKind(DEFAULT_LOOK), 'lab');
  assert.equal(chromeTokens(DEFAULT_LOOK), LAB_UI);
  for (const look of ['arg', 'paper']) {
    assert.equal(chromeKind(look), 'paper', look);
    assert.equal(chromeTokens(look), PAPER_UI, look);
  }
  assert.equal(chromeKind('lab'), 'lab');
  assert.equal(chromeKind('blatimme'), 'lab');
});

test('@zagreb-lab app applies every returned token in one explicit loop', () => {
  assert.match(app, /const ui = chromeTokens\(name\);/);
  assert.match(app, /for \(const \[[^\]]+\] of Object\.entries\(ui\)\)\s*document\.documentElement\.style\.setProperty\(/);
  assert.match(app, /document\.documentElement\.dataset\.ui = chromeKind\(name\);/);
});
