import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../zagreb-lab.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const ride = readFileSync(new URL('../ride-hud.js', import.meta.url), 'utf8');
const selectorList = source => {
  const parts = []; let depth = 0, start = 0;
  const push = end => { const part = source.slice(start, end).trim(); if (part) parts.push(part); start = end + 1; };
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    else if (source[i] === ',' && depth === 0) push(i);
  }
  push(source.length);
  return parts;
};
function rule(selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(block => selectorList(block[1]).includes(selector))
    .map(block => block[2]).join('\n');
}
const assertProps = (selector, ...props) => { const body = rule(selector); for (const p of props) assert.ok(body.includes(p), `${selector}: ${p}`); };

test('Lab panels use one bounded glass recipe, with solid text-bearing inserts', () => {
  for (const selector of ['[data-ui="lab"] .panel', '[data-ui="lab"] .timeline', '[data-ui="lab"] .lab-more', '[data-ui="lab"] .about', '[data-ui="lab"] .look']) {
    const body = rule(selector);
    assert.match(body, /border:\s*1px solid var\(--ui-line\)/, `${selector}: physical frame`);
    assert.match(body, /background:\s*var\(--ui-glass\)/, `${selector}: glass ground`);
    assert.match(body, /backdrop-filter:\s*blur\(14px\) saturate\(140%\)/, `${selector}: bounded blur`);
  }
  assertProps('[data-ui="lab"] .panel .sheet-handle', 'background: var(--ui-surface)');
  assertProps('[data-ui="lab"] .panel .swatch', 'background: var(--ui-surface)', 'border-radius: 2px');
  assertProps('[data-ui="lab"] .hist-wrap', 'background: var(--ui-surface)');
});

test('The counter is framed by quiet white/gold one-pixel details, not a second DOM HUD', () => {
  const before = rule('[data-ui="lab"] .corner .tally::before');
  const after = rule('[data-ui="lab"] .corner .tally::after');
  for (const body of [before, after]) {
    assert.match(body, /content:\s*""/);
    assert.match(body, /position:\s*absolute/);
    assert.match(body, /height:\s*1px/);
    assert.match(body, /pointer-events:\s*none/);
  }
  assert.match(before, /top:\s*0/);
  assert.match(after, /bottom:\s*0/);
  assert.match(after, /var\(--ui-gold\)/);
  assertProps(':root', '--radius-small: 2px', '--radius: 12px');
});

test('Card record types, facts and sources read without legacy light panels or Courier', () => {
  assert.doesNotMatch(css, /Courier New/);
  assertProps('[data-ui="lab"] .card .y', 'font-family: var(--mono)', 'font-weight: 200');
  assertProps('[data-ui="lab"] .card dd', 'font-family: var(--mono)', 'font-size: 12px');
  assertProps('[data-ui="lab"] .card :is(.extract .credit, .sources a, .dating a)', 'color: var(--ui-link)');
  assertProps('[data-ui="lab"] .card .fact', 'background: var(--ui-surface)', 'color: var(--ui-fg)');
  assertProps('[data-ui="lab"] .card-head h3', 'font-family: var(--display)');
  assertProps('[data-ui="lab"] .card .lab-kicker', 'font-family: var(--mono)', 'font-size: 12px');
  assert.match(app, /class="lab-kicker" /);
  assertProps('[data-ui="lab"] .timeline canvas', 'height: 76px');
  assert.match(app, /chromeKind\(THEME_NAME\).*JetBrains Mono/s);
});

test('Paper is a quiet, non-translucent alternative and the live truth comes from feed state', () => {
  assertProps(':root[data-ui="paper"]', '--color-scheme: light');
  const paper = rule('[data-ui="paper"] :is(.timeline, .panel, .lab-more, .about, .look)');
  assert.match(paper, /background:\s*var\(--ui-surface\)/);
  assert.doesNotMatch(paper, /backdrop-filter:\s*blur|linear-gradient/);
  const pulse = css.match(/@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\.ride-live-on::before\s*\{[^}]*animation:\s*([^;}]+)/);
  assert.ok(pulse, 'only the real live indicator may pulse with motion allowed');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ride-live-on::before\s*\{[^}]*animation:\s*none\s*!important/);
  assert.match(ride, /liveEl\.textContent = live \? 'LIVE' : T\('ui\.ride\.tt'\)/);
  assert.match(ride, /liveEl\.classList\.toggle\('ride-live-on', !!live\)/);
});
