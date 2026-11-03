import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownAt, monumentsOnFrom, monumentCard, NOMINAL, FIGURE_AT, MATERIALS } from '../monuments.js';
import { THEMES } from '../themes.js';

const jelacic = { name: 'Ban Josip Jelačić', kind: 'equestrian', year: 1866, removed: [[1947, 1989]], mat: 'bronze', h: 9,
  by: ['Anton Dominik Fernkorn'], qid: 'Q121636557', wp: { hr: 'Kip bana Josipa Jelačića u Zagrebu' },
  ex: { hr: { t: 'Kip bana <Josipa> Jelačića.', r: 7131100 } } };

test('a monument shows from its year, not while it was removed, always at Today', () => {
  assert.equal(shownAt(jelacic, 1865, 2026), false);
  assert.equal(shownAt(jelacic, 1866, 2026), true);
  assert.equal(shownAt(jelacic, 1947, 2026), false);
  assert.equal(shownAt(jelacic, 1989, 2026), false);
  assert.equal(shownAt(jelacic, 1990, 2026), true);
  assert.equal(shownAt(jelacic, 2026, 2026), true);
  assert.equal(shownAt({ kind: 'bust' }, 1700, 2026), true);   // no year: always
});

test('the switch is on unless turned off', () => {
  assert.equal(monumentsOnFrom(null), true);
  assert.equal(monumentsOnFrom('off'), false);
});

test('every kind has a figure height and every look its materials', () => {
  for (const k of Object.keys(NOMINAL)) assert.ok(FIGURE_AT[k] >= 0 && FIGURE_AT[k] < NOMINAL[k], k);
  for (const look of Object.keys(THEMES)) assert.ok(MATERIALS[look], look);
});

test('the card escapes, names the sculptor, the removal and the Croatian excerpt', () => {
  const T = (id, v = {}) => `${id}${Object.values(v).length ? `(${Object.values(v).join(',')})` : ''}`;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = monumentCard(jelacic, { T, esc, link: (h, t) => `<a href="${esc(h)}">${esc(t)}</a>`, lang: 'en', photoHtml: '' });
  assert.match(html, /Anton Dominik Fernkorn/);
  assert.match(html, /monument\.removed\(1947,1990\)/);
  assert.match(html, /lang="hr"/);
  assert.match(html, /&lt;Josipa&gt;/);
  assert.match(html, /oldid=7131100/);
});
