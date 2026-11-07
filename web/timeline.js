// The timeline's landmark labels and its keyboard handles. Pure, tested by node --test.

const histogramCount = row => Array.isArray(row)
  ? row.reduce((sum, n) => sum + (Number(n) || 0), 0)
  : (Number(row) || 0);

// t is elapsed film time from 0 to 1. Dated-building activity changes the pace, but never the clock's direction.
export function filmYear(t, histogram, from, to) {
  if (t <= 0 || to <= from) return from;
  if (t >= 1) return to;
  const rows = Object.entries(histogram || {})
    .map(([year, counts]) => ({ year: Number(year), count: histogramCount(counts) }))
    .filter(row => row.year >= from && row.year <= to)
    .sort((a, b) => a.year - b.year);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const weights = [];
  let seen = 0, weightTotal = 0;
  for (let year = from; year <= to; year++) {
    seen += rows.find(row => row.year === year)?.count || 0;
    const weight = 0.25 / (to - from) + 0.75 * (total ? seen / total : 0);
    weights.push(weight);
    weightTotal += weight;
  }
  const cumulative = [0];
  for (const weight of weights) cumulative.push(cumulative.at(-1) + weight / (weightTotal || 1));
  // Activity controls the pace within a region; the issue's early-history floors apply between regions.
  const stops = [{ year: from, share: 0, at: 0 }];
  const stop = (year, minimum) => {
    if (year <= from || year > to) return;
    stops.push({ year, share: Math.max(minimum, cumulative[year - from]), at: cumulative[year - from] });
  };
  stop(Math.min(1700, to), (Math.min(1700, to) - from) * 0.001);
  stop(1850, 0.15);
  stop(to, 1);
  const index = Math.max(1, stops.findIndex(point => t < point.share));
  const left = stops[index - 1], segment = stops[index];
  const raw = left.at + (segment.at - left.at) * (t - left.share) / (segment.share - left.share);
  const target = raw * (weightTotal || to - from);
  let before = 0;
  for (let i = 0; i < weights.length; i++) {
    if (before + weights[i] >= target) return from + i + (target - before) / (weights[i] || 1);
    before += weights[i];
  }
  return to;
}

// The camera's orbit is an angle, not a duty cycle. Shortened films still turn the same twenty degrees.
export const filmOrbit = (t, reducedMotion) => reducedMotion ? 0 : Math.PI / 9 * t;

// Which landmark names fit on the timeline: highest priority first (stockholm.json landmarks' `timeline`, 1 first), then
// the older year, each placed centred on its year and kept inside the canvas, and dropped when it would come closer
// than `gap` px to one already placed. items: [{name, year, timeline, ...}]; xOf(year) -> px; measure(text) -> px.
// Returns the placed items with x0 and x1 (their box), in year order.
export function placeLabels(items, { xOf, width, measure, gap = 8 }) {
  const order = [...items].sort((a, b) => (a.timeline - b.timeline) || (a.year - b.year) || a.name.localeCompare(b.name));
  const placed = [];
  for (const it of order) {
    const w = measure(it.name);
    if (w + 2 > width) continue;
    const x0 = Math.min(Math.max(0, xOf(it.year) - w / 2), width - w);
    const x1 = x0 + w;
    if (placed.every(p => x1 + gap <= p.x0 || x0 >= p.x1 + gap)) placed.push({ ...it, x0, x1 });
  }
  return placed.sort((a, b) => a.year - b.year);
}

// The label under a pointer, or null: x inside its box (with a few px of slack), y within the label strip.
export const labelAt = (placed, x, y, strip = 16, slack = 3) =>
  (y <= strip ? placed.find(p => x >= p.x0 - slack && x <= p.x1 + slack) || null : null);

// A handle's next year for a key (the WAI-ARIA slider keys): arrows move a year (ten with Shift), Page Up/Down ten,
// Home/End to the ends. Returns null for any other key, so the caller lets it be.
export function stepYear(key, { value, min, max, shift = false }) {
  const step = shift ? 10 : 1;
  const next = { ArrowLeft: value - step, ArrowDown: value - step, ArrowRight: value + step, ArrowUp: value + step,
    PageDown: value - 10, PageUp: value + 10, Home: min, End: max }[key];
  return next === undefined ? null : Math.max(min, Math.min(max, next));
}
