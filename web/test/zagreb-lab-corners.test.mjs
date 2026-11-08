import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../zagreb-lab.css', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const rule = (selector) => {
  const match = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  return match?.[1] || '';
};

test('count and year keep their existing DOM, with four decorative corner edges', () => {
  const tally = html.match(/<div class="tally"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(tally, /id="year"/);
  assert.match(tally, /id="count"/);
  assert.doesNotMatch(html, /id="lab-(?:hud|corner|header)"/, 'no wrapper collides with count/timeline handlers');
  assert.doesNotMatch(tally, /<button|<input|<select/, 'frame is not an undisclosed control');
  const frame = rule('[data-ui="lab"] .corner .tally');
  for (const property of ['position: relative', 'pointer-events: none', 'isolation: isolate', 'border-radius: var(--radius-ctrl)'])
    assert.ok(frame.includes(property), property);
  assert.match(frame, /backdrop-filter:\s*blur\(14px\)\s*saturate\(140%\)/);
  assert.match(frame, /background:[^;]*var\(--ui-glass\)/);
  assert.equal((frame.match(/linear-gradient\(/g) || []).length, 8, 'two short edges at each corner');
  for (const position of ['left top', 'right top', 'left bottom', 'right bottom'])
    assert.ok(frame.includes(position), position);
  assert.ok(rule('[data-ui="lab"] .corner').includes('z-index: 12'));
  assert.match(baseCss, /\.corner \{ position: fixed;/);
});

test('header instruments use their explicit display/mono families and lightweight numeric settings', () => {
  assert.match(rule('[data-ui="lab"] .corner .tally-year'), /font: 200 [^;]*var\(--display\), system-ui, sans-serif/);
  assert.match(rule('[data-ui="lab"] .corner .tally-year'), /color: var\(--ui-gold\)/);
  assert.match(rule('[data-ui="lab"] #count'), /font:[^;]*var\(--mono\)/);
  assert.match(rule('[data-ui="lab"] #count'), /font-feature-settings: var\(--tablk\)/);
  assert.match(rule('[data-ui="lab"] .tally [data-registration]::before'), /font:[^;]*var\(--mono\)/);
  assert.match(rule('[data-ui="lab"] .tally [data-registration]::before'), /letter-spacing: 0\.16em/);
});

test('Paper removes Lab glass and corner decoration from the existing instruments', () => {
  const frame = rule('[data-ui="paper"] .corner .tally');
  assert.ok(frame.includes('background: var(--ui-surface)'));
  assert.ok(frame.includes('backdrop-filter: none'));
  assert.ok(rule('[data-ui="paper"] .tally [data-registration]::before').includes('display: none'));
  assert.ok(rule('[data-ui="paper"] .corner .tally-year').includes('color: var(--ui-fg)'));
});
