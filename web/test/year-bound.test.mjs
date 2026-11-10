import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { yearLine, sourceLine, boundClass, isEstimate } from '../card.js';
import { makeT } from '../i18n.js';
import { YFLAG, YSRC } from '../codes.js';
import { boundCounts, cityCount, tallyFromAttrs } from '../count.js';

const en = makeT({ en: JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8')) }, 'en');
const hr = makeT({ hr: JSON.parse(readFileSync(new URL('../i18n/hr.json', import.meta.url), 'utf8')) }, 'hr');
const periods = Array.from({ length: 11 }, (_, i) => ({ key: `p${i + 1}` }));
const CONFIG = {
  bounds: { pre1968: 2, '1968_2007': 1 }, periods, yearMin: 1900, yearMax: 2026, unknown: 0,
  histogram: { 1968: periods.map((_, i) => i === 9 ? 2 : 0), 2007: periods.map((_, i) => i === 10 ? 1 : 0) },
  histogramEst: {},
};
const PRE = { year: 1968, yearFrom: 0, yearTo: 1968, yflag: YFLAG.BOUND, ysrc: YSRC.ZBSM };
const POST = { year: 2007, yearFrom: 0, yearTo: 2007, yflag: YFLAG.BOUND, ysrc: YSRC.ZBSM };

test('bounded cards have a wording and source, never an unknown/estimate or bare year', () => {
  for (const [kind, b] of [['pre1968', PRE], ['1968_2007', POST]]) {
    assert.equal(boundClass(b), kind);
    assert.equal(isEstimate(b), false);
    assert.equal(yearLine(b, '', en), en(`card.bound.${kind}`));
    assert.equal(sourceLine(b, en), en(`card.src.zbsm.bound.${kind}`));
    assert.match(yearLine(b, '', en), /1968|2007/);
    assert.match(sourceLine(b, en), /bound|upper|cadastr/);
    assert.doesNotMatch(sourceLine(b, en), /built 1968$|built 2007$|estimated|Year unknown/);
    assert.equal(sourceLine(b, hr), hr(`card.src.zbsm.bound.${kind}`));
  }
  assert.equal(yearLine(PRE, '', hr), hr('card.bound.pre1968'));
  assert.doesNotMatch(yearLine(PRE, '', makeT({ en: {} }, 'en')), /^1968$/);
});

function attrs(rows) {
  const view = new DataView(new ArrayBuffer(rows.length * 24));
  rows.forEach(([year, yflag, period], gid) => {
    view.setUint8(gid * 24 + 3, yflag);
    view.setInt16(gid * 24 + 4, year, true);
    view.setUint8(gid * 24 + 21, period);
  });
  return view;
}

test('bound classes enter the film at their own bound, outside unknown and the estimate set', () => {
  const tally = tallyFromAttrs(attrs([[1968, YFLAG.BOUND, 9], [1968, YFLAG.BOUND, 9], [2007, YFLAG.BOUND, 10],
    [1968, YFLAG.EXACT, 9], [2007, YFLAG.EXACT, 10], [1930, YFLAG.ESTIMATE, 6], [0, YFLAG.UNKNOWN, 0]]), 7, 24, CONFIG);
  assert.equal(tally.unknown, 1);
  assert.deepEqual(tally.histogram, { 1968: periods.map((_, i) => i === 9 ? 3 : 0),
    2007: periods.map((_, i) => i === 10 ? 2 : 0) });
  assert.deepEqual(tally.histogramEst, { 1930: periods.map((_, i) => i === 6 ? 1 : 0) });
  const counted = (from, to) => cityCount(tally, from, to, () => true, 'hide', { est: false });
  assert.equal(counted(1900, 1967), 0);
  assert.equal(counted(1900, 1968), 3);
  assert.equal(counted(1969, 2007), 2);
  assert.equal(counted(1900, 2026), 5);
  // the headed counts are BOUND only: the exact 1968/2007 buildings in the same histogram buckets stay out
  assert.deepEqual(boundCounts(tally, 0, 2026), { pre1968: 2, '1968_2007': 1 });
  assert.deepEqual(boundCounts(tally, 0, 1950), { pre1968: 0, '1968_2007': 0 });
  assert.deepEqual(boundCounts(tally, 1970, 2026), { pre1968: 0, '1968_2007': 1 });
  const on = i => i === 9;
  assert.deepEqual(boundCounts(tally, 0, 2026, on), { pre1968: 2, '1968_2007': 0 });
  // config's flat totals are the build's own headed counts, not its histogram buckets
  assert.deepEqual(boundCounts(CONFIG, 0, 2026), { pre1968: 2, '1968_2007': 1 });
});

test('the bound legend has a heading and a count for each class', () => {
  const chart = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(chart, /buildBoundLegend/);
  assert.match(chart, /ui\.legend\.bounds/);
  assert.match(chart, /boundCounts\(/);
  assert.match(en('ui.legend.bounds.pre1968'), /1968/);
  assert.match(en('ui.legend.bounds.1968_2007'), /Before 2007/);
  assert.match(hr('ui.legend.bounds.1968_2007'), /Prije 2007/);
});

test('the shader uses a separate bound stipple, not the estimate darkening or unknown hatch', () => {
  const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(source, /flat out float vStipple/);
  assert.match(source, /flat in float vStipple/);
  assert.match(source, /vStipple\s*=\s*float\(bounded\)/);
  assert.doesNotMatch(source, /yflag\s*==\s*8\s*\|\|\s*yflag\s*==\s*[346]/);
  assert.match(source, /fract\(gl_FragCoord\.xy/);
  assert.match(source, /vStipple.*stipple/);
});
