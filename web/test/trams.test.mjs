// web/trams.js: the timetable read into shapes, trips and stop calls; where a trip is at a second of the day (on its
// shape, between the stops the timetable puts it between); which stop comes next; where a live vehicle's point falls
// along its shape; how many trams run at once; and what the tooltip says, in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrams, makeNet, tramClock, tramInfo, tramHtml, ZONE, RIDE_PROFILE, runProfile, dwellFor, delaySeconds } from '../trams.js';
import { makeT } from '../i18n.js';

const I18N = Object.fromEntries(['en', 'hr'].map(l => [l, JSON.parse(readFileSync(new URL(`../i18n/${l}.json`, import.meta.url), 'utf8'))]));
const EN = makeT(I18N, 'en'), HR = makeT(I18N, 'hr');

// Two shapes in local metres: 200 m east along z=0, and 100 m south along x=0. Two trips, the first with three stop
// calls (0 m at 0 s, 100 m at 200 s, 200 m at 400 s), the second with two (0 m at 0 s, 80 m at 200 s).
const shapes = [0, 0, 100, 0, 200, 0, 0, 0, 0, 100];
const trips = [0, 0, 600, 0, 0, 1, 100, 300, 0, 1];
const stops = [
  0, 0, 0, 0, 0, 0, 200, 220, 10000, 1, 0, 400, 420, 20000, 2,
  1, 100, 100, 0, 0, 1, 200, 210, 8000, 1,
];
const JSON_T = {
  day: '2026-11-03', lines: [{ id: '17', short: '17', long: 'Prečko-Borongaj', colour: '#1c3f94', text: '#ffffff' }],
  shapes: [{ shape: 's0', offset: 0, count: 3, length_m: 200 }, { shape: 's1', offset: 3, count: 2, length_m: 100 }],
  rails: { ways: 0, points: 0, index: [] }, trip_ids: ['t-a', 't-b'], headsigns: ['Prečko', 'Borongaj'],
  stop_names: ['First', 'Second', 'Third'], vehicle: { model: 'TMK 2200', length_m: 32, width_m: 2.3, height_m: 3.4 },
  columns: { trip: ['shape', 'start_s', 'end_s', 'line', 'headsign'], stops: ['trip', 'arrive_s', 'depart_s', 'dist_cm', 'name'] },
};
const f32 = a => new Float32Array(a).buffer, i32 = a => new Int32Array(a).buffer;
const net = makeNet(parseTrams(JSON_T), f32(shapes), i32(trips), i32(stops));

test('a feed without its blocks is refused, not drawn empty', () => {
  assert.throws(() => parseTrams(null), /not a tram feed/);
  assert.throws(() => parseTrams({ lines: [] }), /not a tram feed/);
  assert.equal(parseTrams(JSON_T).vehicle.length, 32);
  assert.equal(parseTrams(JSON_T).tripIds.length, 2);
});

test('a trip stands at its first stop before it leaves, and between two stops the timetable sets the distance', () => {
  // Issue #26: the hop runs by the ride's own profile (acc 1.0, brake 1.2, arrival unchanged) — a tram just gone
  // has covered only metres. The first call stands its clamped minimum (a 0 s stand reads as 8 before the run).
  const run = net.runAt(0, 1);
  const prof = runProfile(200, 100);
  assert.equal(run.dep - run.d0, run.dep, 'run starts after the dwell window');
  const go = net.positionAt(0, 10);
  assert.ok(Math.abs(go.x - prof.at(10 - run.dep)) < 0.01, `just gone by the profile, got x=${go.x}`);
  const mid = net.positionAt(0, 100);
  assert.ok(Math.abs(mid.x - prof.at(100 - run.dep)) < 0.01, `midway by the profile, got x=${mid.x}`);
  assert.equal(mid.z, 0);
  assert.ok(Math.abs(mid.heading) < 1e-6, 'east along the shape');
  // its invariants, tested without the map: never faster than the cap, exact arrival, never backwards
  assert.ok(prof.v <= RIDE_PROFILE.cruise + 1e-9, 'cruise capped at 70 km/h');
  assert.ok(Math.abs(prof.at(200) - 100) < 1e-6, 'arrives on time, on the metre');
  let last = -1;
  for (let s = 0; s <= 200; s += 7) { const d = prof.at(s); assert.ok(d >= last - 1e-9, `monotone at ${s}`); last = d; }
});

test('a tram stands still while it is at a stop, and the trip is over at its end', () => {
  assert.equal(net.positionAt(0, 210).x, 100, 'dwell at the second stop');
  const run = net.runAt(0, 101);
  assert.ok(run.inRun, 'past the stop its own call window ends');
  const prof2 = runProfile(run.arr - run.dep, run.d1 - run.d0);
  const hop = net.positionAt(0, 300);
  assert.ok(Math.abs(hop.x - (100 + prof2.at(300 - run.dep))) < 0.01, `part way by the profile, got ${hop.x}`);
  assert.equal(net.positionAt(0, 500).x, 200, 'arrived at the last stop');
  assert.equal(net.positionAt(0, 601), null, 'after its end it is not on the street');
  assert.equal(net.positionAt(0, -1), null, 'nor before its start');
});

test('the ride itself: dwell is clamped into 8–20 s, the delay is seconds of the segment\'s slope, short trips triangulate', () => {
  assert.equal(dwellFor(5), 8, 'a shorter timetable stand: 8 at least');
  assert.equal(dwellFor(12), 12, 'a stand the timetable has');
  assert.equal(dwellFor(45), 20, 'a long one: 20 at most');
  // A second too early over a 60 m hop in 12 s (5 m/s): 0.2 s of delay
  const slope = 60 / 12;
  assert.ok(Math.abs(delaySeconds(61, 60, slope) - 0.2) < 1e-9);
  // a two-second hop (no cruise section): its profile is a triangle with no cruise and still lands
  const tiny = runProfile(4, 6);
  assert.equal(tiny.tc, 0);
  assert.ok(Math.abs(tiny.at(4) - 6) < 1e-6, 'arrives even without a cruise span');
  let speedPeak = 0;
  for (let s = 0.1; s < 4; s += 0.2) speedPeak = Math.max(speedPeak, tiny.speed(s));
  assert.ok(speedPeak <= RIDE_PROFILE.cruise, 'a triangle never breaks the cap either');
});

test('the point is clamped to the shape when a stop lies past its drawn end', () => {
  const p = net.pointAt(0, 9999);
  assert.equal(p.x, 200);
  assert.equal(p.z, 0);
});

test('the next stop is the first one at or after the distance along the shape', () => {
  assert.equal(net.nextStopAt(0, 0).name, 'First');
  assert.equal(net.nextStopAt(0, 10).name, 'Second');
  assert.equal(net.nextStopAt(0, 100).name, 'Second', 'at the stop itself');
  assert.equal(net.nextStopAt(0, 101).name, 'Third');
  assert.equal(net.nextStopAt(0, 5000).name, 'Third', 'past the last: it is the last');
});

test('a live point becomes a distance along the trip\'s own shape', () => {
  const p = net.projectAt(0, 120, 7);           // 20 m off the line at x=120
  assert.ok(Math.abs(p.d - 120) < 0.01, `distance along, got ${p.d}`);
  assert.ok(Math.abs(p.off - 7) < 0.01, `distance off, got ${p.off}`);
  assert.ok(Math.abs(p.heading) < 1e-6, 'the shape runs east');
});

test('the trips running, and the most that ever run at once', () => {
  assert.deepEqual(net.runningAt(50), [0], 'only the first trip has started');
  assert.deepEqual(net.runningAt(250), [0, 1]);
  assert.deepEqual(net.runningAt(650), [], 'both are over');
  assert.equal(net.peakRunning(), 2);
});

test('a live vehicle\'s trip id finds its trip in the schedule', () => {
  assert.equal(net.tripByExternalId.get('t-b'), 1);
  assert.equal(net.tripByExternalId.get('nope'), undefined);
});

test('the clock is Zagreb\'s, whatever the machine\'s zone says', () => {
  // 2026-11-03 12:34:56 UTC is 13:34:56 in Zagreb, still on summer time (CET+1 until the last Sunday of October... it
  // has ended by then): 13:34:56 on 3 November is CET, UTC+1.
  const t = tramClock(new Date('2026-11-03T12:34:56Z'), ZONE);
  assert.equal(Math.round(t), 13 * 3600 + 34 * 60 + 56);
  const summer = tramClock(new Date('2026-07-01T10:00:00Z'), ZONE);
  assert.equal(Math.round(summer), 12 * 3600, 'CEST, UTC+2');
});

test('the tooltip says the line, the heading, the next stop and where the place came from', () => {
  const info = tramInfo(net, { trip: 0, live: true, next: { name: 'Second' } }, EN);
  assert.equal(info.title, 'Line 17');
  assert.equal(info.route, 'Prečko-Borongaj');
  assert.equal(info.heading, 'Heading for Prečko');
  assert.equal(info.next, 'Next stop: Second');
  assert.equal(info.note, "Live position, ZET's feed");
  const hr = tramInfo(net, { trip: 0, live: false, next: { name: 'Second' } }, HR);
  assert.equal(hr.title, 'Linija 17');
  assert.equal(hr.heading, 'Na putu prema Prečko');
  assert.equal(hr.next, 'Sljedeća stanica: Second');
  assert.equal(hr.note, 'Položaj po voznom redu, nije vozilo uživo');
  assert.ok(!hr.note.includes('{'), 'no placeholder left behind');
});

test('the tooltip\'s HTML is escaped and leaves out the lines with nothing to say', () => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bare = tramInfo(net, { trip: 0, live: false, next: null }, EN);
  const html = tramHtml(bare, esc);
  assert.ok(html.includes('tram-title'));
  assert.ok(!html.includes('tram-next'), 'no next stop, no line');
  assert.equal(tramHtml({ ...bare, route: '<b>x</b>' }, esc).includes('&lt;b&gt;'), true);
});
