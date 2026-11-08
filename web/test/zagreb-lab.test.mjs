import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_LOOK, initialLook } from '../look.js';
import { THEMES } from '../themes.js';
import { LAB_UI, PAPER_UI, chromeKind, chromeTokens } from '../zagreb-lab.js';

const luminance = hex => {
  const channels = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('@zagreb-lab Lab is the first-run chrome while Foto stays the default map look', () => {
  assert.equal(DEFAULT_LOOK, 'foto');
  assert.equal(chromeKind(initialLook('', null)), 'lab');
  assert.deepEqual(Object.keys(THEMES)[0], 'lab');
  for (const [query, stored, expected] of [
    ['', null, 'foto'], ['', 'paper', 'paper'], ['', 'bogus', 'foto'],
    ['?theme=blatimme', 'paper', 'blatimme'], ['?theme=bogus', null, 'foto'],
  ]) assert.equal(initialLook(query, stored), expected);
});

test('@zagreb-lab map and chrome remain separate scene/paper decisions', () => {
  for (const look of ['arg', 'kalk', 'paper']) assert.equal(chromeKind(look), 'paper');
  for (const look of ['foto', 'lab', 'blatimme', 'unknown']) assert.equal(chromeKind(look), 'lab');
  assert.equal(chromeTokens('lab'), LAB_UI);
  assert.equal(chromeTokens('arg'), PAPER_UI);
  assert.equal(chromeKind('lab'), 'lab');
});

test('@zagreb-lab shared tokens match the public reference palettes', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(LAB_UI).filter(([key]) => [
    '--bg', '--panel', '--ink', '--muted', '--accent', '--link', '--line',
  ].includes(key))), {
    '--bg': '#0b0d33', '--panel': '#11144a', '--ink': '#ecebf7', '--muted': '#9a9ccc',
    '--accent': '#d8b55a', '--link': '#8f96ff', '--line': '#2b3170',
  });
  assert.deepEqual(Object.fromEntries(Object.entries(PAPER_UI).filter(([key]) => [
    '--bg', '--panel', '--ink', '--muted', '--accent', '--link', '--line',
  ].includes(key))), {
    '--bg': '#F4EFE6', '--panel': '#FAF7F1', '--ink': '#171717', '--muted': '#665f58',
    '--accent': '#FE2A00', '--link': '#2F5FAE', '--line': '#E5DED2',
  });
});

test('@zagreb-lab Lab text tokens meet WCAG AA for normal text', () => {
  for (const key of ['--ink', '--muted', '--accent', '--link']) {
    assert.ok(contrast(LAB_UI[key], LAB_UI['--bg']) >= 4.5, `${key} on ground`);
    assert.ok(contrast(LAB_UI[key], LAB_UI['--panel']) >= 4.5, `${key} on panel`);
  }
  assert.ok(contrast(LAB_UI['--bg'], LAB_UI['--ink']) >= 4.5, 'dark caption on light ink');
  assert.ok(contrast(PAPER_UI['--ink'], PAPER_UI['--bg']) >= 4.5);
  assert.ok(contrast(PAPER_UI['--link'], PAPER_UI['--bg']) >= 4.5);
  for (const key of ['--muted', '--muted-content', '--accent-content', '--link']) {
    assert.ok(contrast(PAPER_UI[key], PAPER_UI['--bg']) >= 4.5, `${key} on Paper ground`);
    assert.ok(contrast(PAPER_UI[key], PAPER_UI['--panel']) >= 4.5, `${key} on Paper panel`);
  }
});

test('@zagreb-lab new theme keeps the six period/gateway slot shape', () => {
  for (const slot of ['sky', 'land', 'water', 'maquette', 'unknown', 'quay', 'labelInk', 'waterInk', 'periods'])
    assert.ok(Object.hasOwn(THEMES.lab, slot), slot);
  assert.equal(THEMES.lab.sky, '#0b0d33');
  assert.equal(THEMES.lab.land, '#11144a');
  assert.equal(THEMES.lab.water, '#1f3f61');
  assert.equal(THEMES.lab.maquette, '#11144a');
  assert.equal(THEMES.lab.unknown, '#2b3170');
  assert.equal(THEMES.lab.unknownHatch, '#6272c0');
  assert.equal(THEMES.lab.quay, '#4c4a4b');
  assert.deepEqual(THEMES.lab.periods, ['#2d1b49', '#583870', '#4e3db9', '#655ac8', '#aba5e1', '#ddd1b2']);
  assert.deepEqual(THEMES.lab.floors, ['#536eaa', '#849cc5', '#bfc8df', '#fff1cf']);
  assert.notDeepEqual(THEMES.lab.periods, THEMES.foto.periods, 'Lab has an accessible violet-to-gold map identity');
  assert.notDeepEqual(THEMES.lab.floors, THEMES.foto.floors);
});

test('@zagreb-lab static integration is real, local, labelled, and bilingual', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = ['../styles.css', '../zagreb-lab.css'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  const en = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
  const hr = JSON.parse(readFileSync(new URL('../i18n/hr.json', import.meta.url), 'utf8'));
  for (const id of ['lab-layers', 'lab-more-button', 'lab-more', 'lab-spec']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-ui="lab"/);
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*["']?Inter["']?[^}]*src:\s*url\(["']?fonts\/inter\/inter-latin-ext-wght-normal\.woff2/s);
  assert.ok(!/(url\(|@import)[^;}]*https?:/i.test(css), 'no third-party font or layout dependencies');
  for (const key of ['ui.lab.layers', 'ui.lab.more', 'ui.lab.sun', 'ui.lab.north']) {
    assert.ok(en[key], `English ${key}`);
    assert.ok(hr[key], `Croatian ${key}`);
  }
  assert.match(css, /\[data-ui="lab"\][^{]*\.timeline[^\{]*\{[^}]*background:\s*var\(--bg\)/s);
  assert.match(css, /prefers-reduced-motion:\s*no-preference/);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const sky = app.slice(app.indexOf('function applySky()'), app.indexOf('\n}\n', app.indexOf('function applySky()')));
  assert.match(sky, /style\.setProperty\('--sky', sky\)/, 'the map exposes its live weather sky without changing Lab panel contrast');
});
