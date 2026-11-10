import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labSpecification } from '../zagreb-lab.js';
import { makeT } from '../i18n.js';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const config = load(new URL('../data/v20261103-fix/zagreb.json', import.meta.url));
const dictionaries = Object.fromEntries(['en', 'hr', 'sv'].map(lang => [lang,
  load(new URL(lang === 'sv' ? './fixtures/sv.json' : `../i18n/${lang}.json`, import.meta.url))]));
const css = readFileSync(new URL('../zagreb-lab.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function rule(selector) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(escaped + '\\s*\\{([^}]*)\\}', 'g'))].map(match => match[1]).join('\n');
}

test('masthead specification is generated from shipped data in both production languages', () => {
  const hr = makeT(dictionaries, 'hr');
  assert.equal(labSpecification(config, hr), '298.675 ZGRADA · 1200–2026 · 17 GRADSKIH ČETVRTI');
  const en = makeT(dictionaries, 'en');
  assert.equal(labSpecification(config, en), '298,675 BUILDINGS · 1200–2026 · 17 CITY DISTRICTS');
  assert.equal(labSpecification({}, en), '', 'missing data is not presented as a fabricated 0');
  assert.match(html, /id="lab-code"/);
  assert.match(html, /id="lab-spec-summary"/);
  assert.match(app, /labSpecification\(config, T\)/);
});

test('the existing display face is lightweight Inter while numbered controls stay in local mono', () => {
  const hero = rule('[data-ui="lab"] .masthead h1');
  assert.match(hero, /font:\s*200 clamp\(40px, 6vw, 84px\)/);
  assert.match(hero, /var\(--display\)/);
  assert.match(hero, /background:\s*transparent/);
  const kicker = rule('[data-ui="lab"] #lab-code');
  assert.match(kicker, /font:\s*400 12px\/1\.4 var\(--mono\)/);
  assert.match(kicker, /letter-spacing:\s*0\.16em/);
  assert.match(rule('[data-ui="lab"] .about-nav'), /counter-reset:\s*section/);
  assert.match(rule('[data-ui="lab"] .about-nav a'), /counter-increment:\s*section/);
  assert.match(rule('[data-ui="lab"] .about-nav a::before'), /counter\(section, decimal-leading-zero\)/);
});

test('the pinned record receives the restrained eight-edge frame and readable gold numeral pill', () => {
  const card = rule('[data-ui="lab"] .card.pinned');
  assert.equal((card.match(/linear-gradient\(/g) || []).length, 8);
  assert.match(card, /var\(--ui-glass\)/);
  const year = rule('[data-ui="lab"] .card .y');
  assert.match(year, /border:\s*1px solid var\(--ui-line\)/);
  assert.match(year, /color:\s*var\(--ui-gold\)/);
  const pressed = rule('[data-ui="lab"] .panel .swatch[aria-pressed="true"]');
  assert.match(pressed, /border-color:\s*var\(--ui-gold\)/);
  assert.match(pressed, /color:\s*var\(--ui-fg\)/);
});

test('timeline playhead has a real data year and the existing close-address linkage is unchanged', () => {
  assert.match(app, /chromeKind\(THEME_NAME\)[\s\S]*fillText\(label,/);
  assert.match(app, /String\(Math\.floor\(Y\)\)/);
  const headBuilder = app.slice(app.indexOf('const head = `'), app.indexOf('if (!pinned) return'));
  assert.ok(headBuilder.indexOf('class="place"') < headBuilder.indexOf('id="card-title"'), 'address precedes a name');
  assert.match(headBuilder, /place \|\| \(pinned && !b\.private\)/, 'the established private-address branch remains');
  assert.match(app, /if \(!redraw\) close\.focus\(\{ preventScroll: true \}\)/);
});
