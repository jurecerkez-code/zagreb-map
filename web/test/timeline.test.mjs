import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLabels, labelAt, stepYear, filmYear, filmOrbit, countDatedAt } from '../timeline.js';

const { filmTimeAtYear } = await import('../timeline.js');

test('the film turns twenty degrees and honors reduced motion', () => {
  assert.equal(filmOrbit(0, false), 0);
  assert.ok(Math.abs(filmOrbit(0.5, false) - Math.PI / 18) < 1e-10);
  assert.equal(filmOrbit(1, false), Math.PI / 9);
  for (const t of [0, 0.5, 1]) assert.equal(filmOrbit(t, true), 0);
});


test('filmYear keeps the full interval monotonic, with exact endpoints', () => {
  const histogram = { 1100: [4, 0], 1500: [20, 0], 1900: [500, 0], 2026: [1200, 0] };
  assert.equal(filmYear(0, histogram, 1200, 2026), 1200);
  assert.equal(filmYear(1, histogram, 1200, 2026), 2026);
  const samples = [0, 0.2, 0.5, 0.75, 1].map(t => filmYear(t, histogram, 1200, 2026));
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1]);
});


const inverseHistogram = {
  1200: [4, 0], 1300: [8, 0], 1600: [30, 0], 1700: [10, 0],
  1800: [900, 0], 1900: [1000, 0], 2026: [1200, 0],
};
const inverse = year => filmTimeAtYear?.(year, inverseHistogram, 1200, 2026);

test('filmTimeAtYear clamps to exact film endpoints', () => {
  assert.equal(inverse(1100), 0);
  assert.equal(inverse(1200), 0);
  assert.equal(inverse(2026), 1);
  assert.equal(inverse(2100), 1);
});

test('filmTimeAtYear is monotonic across activity and century stops', () => {
  const years = [1200.25, 1299.75, 1300, 1300.25, 1613.5, 1699.75, 1700, 1700.25,
    1850, 1850.5, 1976.6, 2025.75];
  const times = years.map(inverse);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1], `${years[i]} must not resume before ${years[i - 1]}`);
  }
});

test('filmTimeAtYear recovers fractional years to sub-microyear accuracy', () => {
  for (const year of [1200.25, 1300, 1613.5, 1700, 1850.5, 1976.6, 2025.75]) {
    const restored = filmYear(inverse(year), inverseHistogram, 1200, 2026);
    assert.ok(restored >= year, `${year} must not resume backwards at ${restored}`);
    assert.ok(Math.abs(restored - year) < 1e-6, `${year} restored as ${restored}`);
  }
});

test('filmTimeAtYear uses a bounded number of curve evaluations', () => {
  let evaluations = 0;
  const observed = new Proxy(inverseHistogram, {
    ownKeys(target) { evaluations++; return Reflect.ownKeys(target); },
  });
  filmTimeAtYear?.(1613.5, observed, 1200, 2026);
  assert.ok(evaluations > 0, 'the inverse must evaluate the film curve');
  assert.ok(evaluations <= 40, `expected a bounded binary inverse, got ${evaluations} evaluations`);
});

test('the dated film count includes exact and bounded years up to the floor of the current year', () => {
  const histogram = { 1200: [2, 1], 1899: [3, 0], 1900: [4, 0] };
  const histogramEst = { 1754: [2, 1], 1900: [5, 0], 1901: [7, 0] };
  assert.equal(countDatedAt(1899.99, histogram, histogramEst), 9);
  assert.equal(countDatedAt(1900, histogram, histogramEst), 18);
  assert.equal(countDatedAt(2026, histogram, histogramEst), 25);
  assert.equal(countDatedAt(2026, {}, {}), 0);
});

const xOf = y => (y - 1100) / (2026 - 1100) * 1000;     // a 1000 px timeline from 1100 to Today
const measure = s => s.length * 6;

test('labels take priority, stay inside the canvas and never overlap', () => {
  const items = [
    { name: 'Stockholms slott', year: 1754, timeline: 1 }, { name: 'Storkyrkan', year: 1306, timeline: 1 },
    { name: 'Kungliga Operan', year: 1898, timeline: 2 }, { name: 'Nordiska museet', year: 1907, timeline: 3 },
    { name: 'Stockholms stadshus', year: 1923, timeline: 1 }, { name: 'Avicii Arena', year: 1989, timeline: 1 },
    { name: 'Vasamuseet', year: 1990, timeline: 3 },
  ];
  const placed = placeLabels(items, { xOf, width: 1000, measure });
  // Avicii Arena (1989, priority 1) would touch Stockholms stadshus (1923, priority 1, placed first by its year)
  assert.deepEqual(placed.map(p => p.name), ['Storkyrkan', 'Stockholms slott', 'Stockholms stadshus']);
  for (let i = 1; i < placed.length; i++) assert.ok(placed[i].x0 >= placed[i - 1].x1 + 8);
  assert.ok(placed.every(p => p.x0 >= 0 && p.x1 <= 1000));
  // Today's end: a label is pushed left to stay inside
  const end = placeLabels([{ name: 'Waterfront', year: 2025, timeline: 1 }], { xOf, width: 1000, measure })[0];
  assert.equal(end.x1, 1000);
  // a narrow phone timeline keeps fewer, never a label wider than the canvas
  assert.ok(placeLabels(items, { xOf: y => xOf(y) * 0.36, width: 360, measure }).length < placed.length);
  assert.deepEqual(placeLabels([{ name: 'x'.repeat(200), year: 1500, timeline: 1 }], { xOf, width: 1000, measure }), []);
});

test('labelAt finds the label under the pointer in the label strip only', () => {
  const placed = [{ name: 'A', x0: 100, x1: 160 }, { name: 'B', x0: 300, x1: 340 }];
  assert.equal(labelAt(placed, 130, 8).name, 'A');
  assert.equal(labelAt(placed, 98, 8).name, 'A');            // a little slack around the text
  assert.equal(labelAt(placed, 130, 40), null);              // lower down the pointer drags a handle
  assert.equal(labelAt(placed, 200, 8), null);
});

test('stepYear follows the slider keys and stays within its bounds', () => {
  const s = { value: 1900, min: 1100, max: 2025 };
  assert.equal(stepYear('ArrowRight', s), 1901);
  assert.equal(stepYear('ArrowLeft', { ...s, shift: true }), 1890);
  assert.equal(stepYear('PageUp', s), 1910);
  assert.equal(stepYear('Home', s), 1100);
  assert.equal(stepYear('End', s), 2025);
  assert.equal(stepYear('ArrowUp', { ...s, value: 2025 }), 2025);
  assert.equal(stepYear('Enter', s), null);
});

test('filmYear reserves each early-history floor, not only their total', () => {
  const histogram = { 1200: [4, 0], 1800: [8, 0], 2026: [1000, 0] };
  const at = year => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (filmYear(mid, histogram, 1200, 2026) < year) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  for (let year = 1300; year <= 1700; year += 100) {
    const minimum = (year - 1200) / 1000;
    assert.ok(at(year) >= minimum - 1e-9, `arrival at ${year} must reserve at least 3 s per century`);
  }
  assert.ok(at(1850) >= 0.15, 'the pre-1850 story gets at least 15% of the film');
});

test('early-history floors never erase a later activity segment', () => {
  const histogram = { 1200: [4, 0], 1800: [900, 0], 2026: [900, 0] };
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (filmYear(mid, histogram, 1200, 2026) < 1700) lo = mid;
    else hi = mid;
  }
  assert.ok(hi >= 0.5, 'the 1700 crossing must retain at least fifteen seconds');
  const atStop = filmYear(hi + 1e-6, histogram, 1200, 2026);
  assert.ok(atStop <= 1701,
    `the region after 1700 must receive its own time, not jump to ${atStop}`);
});

test('the early-history floor is not capped for a different start year', () => {
  const samples = [0.1, 0.3, 0.5, 0.7, 0.9, 1];
  const years = samples.map(t => filmYear(t, { 1900: [100, 0] }, 1000, 2026));
  years.forEach((year, i) => assert.ok(year >= years[i - 1] || i === 0));
  for (let i = 0; i < 1000; i++) {
    if (filmYear(i / 1000, { 1900: [100, 0] }, 1000, 2026) >= 1700) {
      assert.ok(i / 1000 >= 0.7);
      return;
    }
  }
  assert.fail('The film never reaches 1700');
});
