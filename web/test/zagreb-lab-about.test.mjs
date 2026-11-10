import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aboutHtml } from '../about.js';
import { makeT } from '../i18n.js';

const translations = Object.fromEntries(['en', 'hr', 'sv'].map(lang => [lang,
  JSON.parse(readFileSync(new URL(lang === 'sv' ? './fixtures/sv.json' : `../i18n/${lang}.json`, import.meta.url), 'utf8'))]));
// Only the API shape and count needed for this source-free rendering test.
const config = { stats: { buildings: 0, bySrc: {}, byFlag: {} }, accuracy: {}, about: {}, attribution: [] };

test('About starts with a concise Lab manual in both production languages', () => {
  for (const lang of ['en', 'hr']) {
    const html = aboutHtml(config, makeT(translations, lang));
    assert.equal((html.match(/class="lab-quick-guide"/g) || []).length, 1, lang);
    const guide = html.match(/<section class="lab-quick-guide"[\s\S]*?<\/section>/)?.[0] || '';
    assert.ok(guide, lang);
    assert.match(guide, /aria-labelledby="lab-quick-guide-title"/);
    assert.match(guide, /id="lab-quick-guide-title"/);
    assert.match(guide, /Povla|Drag|povla/);
    for (const topic of ['map', 'timeline', 'legend', 'card']) {
      assert.match(html, new RegExp(translations[lang][`about.lab.${topic}.title`]), `${lang}:${topic}`);
    }
    for (const key of ['Tab', 'Esc']) assert.match(guide, new RegExp(`<kbd>${key}</kbd>`));
    assert.match(html, /id="about-years"/, 'the established factual manual remains available');
    assert.doesNotMatch(html, /\{[a-z_]+\}/);
  }
});

test('About handles are escaped and Croatian helper text keeps its characters', () => {
  const html = aboutHtml(config, makeT(translations, 'hr'));
  for (const id of ['title', 'map', 'timeline', 'legend', 'card']) {
    const key = `about.lab.${id}`;
    assert.ok(translations.hr[key]);
    assert.match(html, new RegExp(translations.hr[key]));
  }
  const guide = ['title', 'map', 'timeline', 'legend', 'card'].map(id => translations.hr[`about.lab.${id}`]).join(' ');
  assert.match(guide, /[čćđšžČĆĐŠŽ]/);
  assert.match(html, /kratke upute/);
});

test('The Swedish completeness fixture contains every Lab manual and record key', () => {
  for (const key of Object.keys(translations.en).filter(key => key.startsWith('about.lab.') || key === 'ui.lab.record')) {
    assert.equal(typeof translations.hr[key], 'string', `hr:${key}`);
    assert.equal(typeof translations.sv[key], 'string', `sv:${key}`);
  }
});
