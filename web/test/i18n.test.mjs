// web/i18n: both languages hold the same ids, no empty string, the same placeholders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeT, fill, LEGACY, legacy, pickLang } from '../i18n.js';

const load = name => JSON.parse(readFileSync(new URL(name === 'sv' ? './fixtures/sv.json' : `../i18n/${name}.json`, import.meta.url), 'utf8'));
const EN = load('en'), SV = load('sv'), HR = load('hr');
const holes = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('English and Swedish hold the same ids, none empty, with the same placeholders', () => {
  assert.deepEqual(Object.keys(SV).sort(), Object.keys(EN).sort());
  for (const [id, en] of Object.entries(EN)) {
    assert.ok(en.trim() && SV[id].trim(), id);
    assert.deepEqual(holes(SV[id]), holes(en), id);
  }
});

test('T fills placeholders, falls back to English and then to the id, and formats numbers per language', () => {
  const T = makeT({ en: { a: 'A {n}', b: 'only English' }, sv: { a: 'Ä {n}' } }, 'sv');
  assert.equal(T('a', { n: 3 }), 'Ä 3');
  assert.equal(T('b'), 'only English');
  assert.equal(T('nope'), 'nope');
  assert.equal(T.lang, 'sv');
  assert.equal(T.num(77743), '77 743');
  assert.equal(T.num(18.44, 1), '18,4');
  assert.equal(makeT({}, 'en').num(77743), '77,743');
  assert.equal(fill('{a} and {b}', { a: 1 }), '1 and {b}');      // a missing value shows, never "undefined"
});

test('every English text the pure modules hand over has an id whose English is that text', () => {
  for (const [text, id] of Object.entries(LEGACY)) {
    assert.equal(EN[id], text, id);
    assert.ok(SV[id] && SV[id] !== text, id);
  }
  const t = legacy(makeT({ en: EN, sv: SV }, 'sv'));
  assert.equal(t('Today'), 'I dag');
  assert.equal(t('until {year}').replace('{year}', 1610), 'fram till 1610');   // count.js fills it itself
  assert.equal(t('Play again'), 'Spela igen');                                   // the quests speak Swedish since 2026-10-18
  assert.equal(t('No such text'), 'No such text');                               // a text without an id stays as it is
});

test('the page opens in ?lang=, else the saved choice, else a Croatian or English browser, else English', () => {
  assert.equal(pickLang({ param: 'hr', saved: 'en', languages: ['en-GB'] }), 'hr');
  assert.equal(pickLang({ param: 'en', saved: 'hr', languages: ['hr-HR'] }), 'en');
  assert.equal(pickLang({ languages: ['hr-HR', 'en-GB'] }), 'hr');                   // a Croatian browser, nothing stored
  assert.equal(pickLang({ param: 'de', saved: 'en', languages: ['hr-HR'] }), 'en');   // an unknown ?lang= is ignored
  assert.equal(pickLang({ saved: 'sv', languages: ['en-US'] }), 'hr');                // a pre-Croatian choice: Croatian
  assert.equal(pickLang({ languages: ['sv-SE', 'hr-HR'] }), 'hr');                    // Swedish is no longer a language
  assert.equal(pickLang({ languages: ['de-DE', 'en-GB'] }), 'en');                    // the first Croatian or English
  assert.equal(pickLang({ languages: ['nb-NO', 'en-US', 'hr'] }), 'en');
  assert.equal(pickLang({ languages: ['hrx'] }), 'en');
  assert.equal(pickLang({ languages: ['hr-HR'], fromBrowser: false }), 'en');         // the browser-language choice off
  assert.equal(pickLang({ param: 'hr', languages: ['hr-HR'], enabled: false }), 'en'); // the switch off: English
  assert.equal(pickLang({ param: 'sv', languages: ['sv-SE'] }), 'en');                // ?lang=sv is not a language here
  assert.equal(pickLang(), 'en');
});
test('the page ships two languages and only two: English and Croatian', () => {
  const served = readdirSync(new URL('../i18n/', import.meta.url)).filter(f => f.endsWith('.json')).sort();
  assert.deepEqual(served, ['en.json', 'hr.json'], 'web/i18n holds the two languages the page offers');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /i18n\/sv\.json/, 'the page must not load a Swedish table');
});

test('every text index.html marks for translation has its id in both languages, and app.js keeps no string table', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/data-i18n(?:-aria)?="([\w.]+)"/g)].map(m => m[1]);
  assert.ok(ids.length >= 9);
  for (const id of ids) assert.ok(EN[id] && SV[id] && HR[id], id);
  // Croatian is the map's own second language: it holds every id English has, placeholders included
  for (const id of Object.keys(EN)) {
    assert.ok(HR[id], `hr is missing ${id}`);
    assert.deepEqual(holes(HR[id]), holes(EN[id]), id);
  }
  assert.doesNotMatch(app, /SV_UI/);
});
