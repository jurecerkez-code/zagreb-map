import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAB_UI } from '../zagreb-lab.js';
import { rgb, lin, hex } from '../tone.js';

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


test('Lab keeps small labels and links legible even when the backdrop is pure white', () => {
  const luminance = h => rgb(h).map(lin).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (fg, bg) => (Math.max(luminance(fg), luminance(bg)) + .05) / (Math.min(luminance(fg), luminance(bg)) + .05);
  const [red, green, blue, alpha] = LAB_UI['--ui-glass'].match(/[\d.]+/g).map(Number);
  const bright = [red, green, blue].map(v => Math.round(v * alpha + 255 * (1 - alpha))).map(v => v.toString(16).padStart(2, '0')).join('');
  assert.ok(contrast(LAB_UI['--ui-gold'], '#'+bright) < 4.5, 'the fixture detects the bright-background failure');
  for (const selector of [
    '[data-ui="lab"] #lab-code',
    '[data-ui="lab"] .tally [data-registration]::before',
    '[data-ui="lab"] .lab-spec',
    '[data-ui="lab"] .panel .back',
    '[data-ui="lab"] .about a',
  ]) {
    assert.match(rule(selector), /background(-color)?:\s*var\(--ui-surface\)/, `${selector}: opaque text insert`);
  }
  for (const selector of ['[data-ui="lab"] .look p', '[data-ui="lab"] .card .dating', '[data-ui="lab"] .about :is(.credit, .caveat, .note)'])
    assert.match(rule(selector), /color:\s*var\(--ui-fg\)/, selector);
  assert.match(rule('[data-ui="lab"] .modes::before'), /color:\s*var\(--ui-fg\)/);
  for (const selector of ['[data-ui="lab"] .card .photo .prev', '[data-ui="lab"] .card .photo .next'])
    assert.match(rule(selector), /color:\s*#171717/, selector);
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

// Measured in the browser (e2e/zagreb-lab.spec.mjs keeps the live check): the legend's "Hide the N
// estimated years" switch is the one text control left on bare glass. Its label takes --ui-fg; here the
// arithmetic is stated at the strictest ground — the .72 glass over pure white, brighter than any Foto pixel.
const wcag = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const [hi, lo] = [wcag(rgb(a)), wcag(rgb(b))].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('the legend switch clears 4.5:1 on bare glass at the palest possible ground', () => {
  const [alpha] = [...LAB_UI['--ui-glass'].matchAll(/[\d.]+/g)].slice(-1).map(m => Number(m[0]));
  const ground = hex(rgb(LAB_UI['--ui-bg']).map(v => v * alpha + (1 - alpha)));
  assert.ok(ratio(LAB_UI['--ui-fg'], ground) >= 4.5, `ink on glass over white: ${ratio(LAB_UI['--ui-fg'], ground).toFixed(2)}`);
  assert.ok(ratio(LAB_UI['--muted'], ground) < 4.5, 'muted is the token that does not clear it');
  assertProps('[data-ui="lab"] .panel .est-row .switch', 'color: var(--ui-fg)');
});
