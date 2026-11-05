// Zagreb's trams: the real network and the real timetable (data/<version>/trams.json and the four .bin.gz files,
// pipeline/s16_zagreb_trams.py), plus ZET's live positions from /rt (scripts/serve.py).
//
// What is real here: every line, every shape (the geometry the vehicle actually drives, both directions separate),
// every trip's start and end, every stop call with its time and its distance along the shape. A vehicle between two
// stops is placed by spreading the timetable over the distance between them, the best the data allows without a
// stop-by-stop position feed. Live vehicles (a trip id in trip_ids, so a bus is left out) are drawn where the feed
// puts them, which is their real position to the metre.
//
// Pure: no three.js, no document. web/trams-layer.js draws it, web/app.js decides when it shows and shows the
// tooltip; tested by node --test (web/test/trams.test.mjs).

// The timetable is in Zagreb's own time, whatever the visitor's clock says: a tram on the screen must be the tram on
// the street, not one shifted by a laptop's time zone.
export const ZONE = 'Europe/Zagreb';

// Seconds since midnight in Zagreb, with the fraction of the second: the schedule counts in seconds of the day.
export function tramClock(date = new Date(), zone = ZONE) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' }).formatToParts(date);
  const at = k => Number(p.find(x => x.type === k)?.value || 0);
  return at('hour') * 3600 + at('minute') * 60 + at('second') + (date.getMilliseconds() || 0) / 1000;
}

// ---------- The ride's pace (issue #26) ----------
// Between two stops a tram accelerates at 1.0 m/s², cruises at most 70 km/h, and brakes at 1.2 m/s², arriving at
// exactly the second the timetable says. The dwell is the timetable's own, clamped into 8–20 s: at a stop that
// stands 5 s, 8 means the timetable may run three late rather than ten early.
export const RIDE_PROFILE = { acc: 1.0, dec: 1.2, cruise: 70 / 3.6, dwell: 20, dwellMin: 8 };

// The pieces of one stop-to-stop run: { v (cruise m/s), ta (accel s), td (brake s), tc (cruise s), at(sec) rell < L+1}.
export function runProfile(runSec, distM, P = RIDE_PROFILE) {
  const L = Math.max(0, distM), T = Math.max(1e-3, runSec);
  if (L <= 0) return { v: 0, ta: 0, td: 0, tc: T, at: () => 0, speed: () => 0 };
  // T = L/v + v/2 * (1/acc + 1/dec): solve for the cruise speed; clamp it at the line's cap and accept being late.
  const inv = 1 / P.acc + 1 / P.dec;
  const disc = T * T - 2 * L * inv;
  let v = disc > 0 ? (T - Math.sqrt(disc)) / inv : 2 * L / Math.max(T, 1e-6);
  v = Math.min(P.cruise, Math.max(0.001, v));
  let ta = v / P.acc, td = v / P.dec, tc = T - ta - td;
  if (tc < 0) {   // a run too short for full speed: triangle, not trapezoid
    const total = ta + td;
    ta = T * (ta / total); td = T - ta; tc = 0;
    v = P.acc * ta;
  }
  const at = s => {
    if (s <= 0) return 0;
    if (s < ta) return 0.5 * P.acc * s * s;
    const s2 = Math.min(s, ta + tc);
    if (s < ta + tc) return 0.5 * P.acc * ta * ta + v * (s2 - ta);
    const b = Math.min(s - ta - tc, td);
    return L - 0.5 * P.dec * Math.max(0, td - b) ** 2;
  };
  const speed = s => (s <= 0 ? 0 : s < ta ? P.acc * s : s < ta + tc ? v : Math.max(0, v - P.dec * (s - ta - tc)));
  return { v, ta, td, tc, at, speed };
}

// The dwell the profile gives a stay, never below 8 s and never above 20.
export const dwellFor = ttStay => Math.max(RIDE_PROFILE.dwellMin, Math.min(RIDE_PROFILE.dwell, ttStay));

// The live feed says a point, the timetable says a distance: seconds of delay, as the current segment's slope says
// them. export so the layer and the HUD agree (issue #26's delay measure).
export function delaySeconds(liveD, expectedD, metresPerSec) {
  return (liveD - expectedD) / Math.max(1e-3, metresPerSec);
}

export function parseTrams(json) {
  const ok = json && Array.isArray(json.lines) && Array.isArray(json.shapes) && Array.isArray(json.trip_ids)
    && Array.isArray(json.headsigns) && Array.isArray(json.stop_names);
  if (!ok) throw new Error('trams.json: not a tram feed');
  const vehicle = json.vehicle || {};
  return {
    lines: json.lines,
    shapes: json.shapes,
    rails: json.rails || { ways: 0, points: 0, index: [] },
    tripIds: json.trip_ids,
    headsigns: json.headsigns,
    stopNames: json.stop_names,
    vehicle: { model: vehicle.model || '', length: Number(vehicle.length_m) || 0,
      width: Number(vehicle.width_m) || 0, height: Number(vehicle.height_m) || 0 },
  };
}

// The schedule over the three binaries: shape points (x, z), trips (5 ints), stop calls (5 ints).
export function makeNet(trams, shapeBuf, tripBuf, stopBuf) {
  const pts = new Float32Array(shapeBuf);
  const trips = new Int32Array(tripBuf);
  const stops = new Int32Array(stopBuf);
  const nTrips = trips.length / 5;
  const nShapes = trams.shapes.length;

  // Cumulative distance along every shape, in one flat array indexed by the shape point: a trip's place is a
  // distance, and this is the only way from it to a point.
  const cum = new Float32Array(pts.length / 2);
  const shapeLength = new Float64Array(nShapes);
  for (let s = 0; s < nShapes; s++) {
    const { offset, count } = trams.shapes[s];
    let d = 0;
    for (let k = 1; k < count; k++) {
      const a = offset + k - 1, b = offset + k;
      d += Math.hypot(pts[b * 2] - pts[a * 2], pts[b * 2 + 1] - pts[a * 2 + 1]);
      cum[b] = d;
    }
    shapeLength[s] = d;
  }

  // Stop calls are contiguous and in order per trip (the pipeline writes them so): one start and count per trip.
  const stopStart = new Int32Array(nTrips + 1);
  for (let c = 0; c < stops.length; c += 5) {
    const t = stops[c];
    if (t >= 0 && t < nTrips) stopStart[t + 1]++;
  }
  for (let t = 0; t < nTrips; t++) stopStart[t + 1] += stopStart[t];

  const tripByExternalId = new Map();
  trams.tripIds.forEach((id, i) => tripByExternalId.set(id, i));

  const shapeOf = t => trips[t * 5];
  const startOf = t => trips[t * 5 + 1];
  const endOf = t => trips[t * 5 + 2];
  const lineOf = t => trams.lines[trips[t * 5 + 3]] || null;
  const headsignOf = t => trams.headsigns[trips[t * 5 + 4]] || '';

  // The point, and the direction of travel, `d` metres along shape s. The direction is the segment's, so a tram
  // always points the way its shape runs; on the last point it keeps the last segment's. `along` is the distance the
  // point was clamped to, which the trip's own answer already knows.
  function pointAt(s, d, along) {
    const { offset, count } = trams.shapes[s];
    let lo = 0, hi = Math.max(0, count - 1);
    const total = shapeLength[s];
    const want = Math.max(0, Math.min(total, d));
    while (lo < hi) {                       // the last point whose cumulative distance is at or before `want`
      const mid = (lo + hi + 1) >> 1;
      if (cum[offset + mid] <= want) lo = mid; else hi = mid - 1;
    }
    const k = Math.max(0, Math.min(count - 2, lo));
    const a = offset + k, b = a + 1;
    const seg = cum[b] - cum[a];
    const f = seg > 1e-6 ? Math.max(0, Math.min(1, (want - cum[a]) / seg)) : 0;
    const x = pts[a * 2] + (pts[b * 2] - pts[a * 2]) * f;
    const z = pts[a * 2 + 1] + (pts[b * 2 + 1] - pts[a * 2 + 1]) * f;
    return { x, z, heading: Math.atan2(pts[b * 2 + 1] - pts[a * 2 + 1], pts[b * 2] - pts[a * 2]), d: along ?? want };
  }

  // Where trip t is at second `sec` of the day: null before its start and after its end (a trip that has not left
  // the depot, or has arrived). Issue #26: between two stops the distance follows the ride's speed profile
  // (accelerate at 1.0 m/s², cruise at most 70 km/h, brake at 1.2 m/s², arrival unchanged), and the dwell is the
  // timetable's own clamped into 8–20 s. Where the timetable says the tram stands at a stop, it stands.
  // Per-call dwell gates, with the issue's dwell rule baked in: every stop stands between 8 and 20 seconds
  // (dwellFor), never below 8; a shorter timetable stand is taken whole, a longer one capped, and the slip lands
  // downstream (never an arrival before its own time; a 5 s stand at 8 means this trip runs 3 s late).
  const runsOf = t => {
    if (!runsOf._cache) runsOf._cache = new Map();
    let runs = runsOf._cache.get(t);
    if (runs) return runs;
    runs = [];
    const n = stopStart[t + 1] - stopStart[t];
    if (!n) { runsOf._cache.set(t, runs); return runs; }
    const c0 = stopStart[t] * 5, last = c0 + (n - 1) * 5;
    let slip = 0;   // the trip's lateness so far: each stop's effective departure carries it forward
    const calls = [];
    for (let c = c0; c <= last; c += 5) {
      const arr = stops[c + 1] + slip;
      const arrEff = Math.max(arr, stops[c + 1]);
      const dwellEff = dwellFor(stops[c + 2] - stops[c + 1]);
      const dep = arrEff + dwellEff;
      slip = Math.max(slip, dep - stops[c + 2]);   // a clamp never makes the depart earlier than it was
      calls.push({ arr: arrEff, dep, d: stops[c + 3] / 100 });
    }
    for (let i = 0; i + 1 < calls.length; i++) {
      const dep = calls[i].dep, arr = calls[i + 1].arr;
      runs.push({ dep, arr, d0: calls[i].d, d1: calls[i + 1].d, prof: runProfile(arr - dep, calls[i + 1].d - calls[i].d) });
    }
    runsOf._cache.set(t, runs);
    return runs;
  };
  // Where trip t is at second `sec` of the day on the ADJUSTED calls (the dwell rule lands here too): null outside
  // its [start,end] window.
  function positionAt(t, sec) {
    const s = startOf(t), e = endOf(t);
    if (sec < s || sec > e) return null;
    const n = stopStart[t + 1] - stopStart[t];
    if (!n) return null;
    const c0 = stopStart[t] * 5;
    const first = c0, last = c0 + (n - 1) * 5;
    const runs = runsOf(t);
    let d;
    if (sec <= stops[first + 1]) d = stops[first + 3] / 100;
    else if (sec >= stops[last + 1]) d = stops[last + 3] / 100;
    else {
      const run = runs.find(r => sec < r.arr);
      if (!run) d = stops[last + 3] / 100;
      else if (sec < run.dep) {
        // Inside this call's stand: the adjusted dwell is its length minus the run's start, of the call before it.
        d = run.d0;
      } else {
        d = run.d0 + run.prof.at(sec - run.dep);
      }
    }
    return pointAt(shapeOf(t), d, d);
  }
  // The call window standing around `d` (for the delay model and the HUD): the tram stands between the previous
  // run's adjusted arrive and its adjusted depart; call windows are how a standing tram reads on the map.
  function standAt(t, sec) {
    const n = stopStart[t + 1] - stopStart[t];
    if (!n) return null;
    const runs = runsOf(t);
    return runs.find(r => sec >= r.arr && sec < r.dep) || null;
  }
  // The same gates in public: the trip's run profile around distance `d` within its own calls, for the delay
  // model and the ride's HUD (issue #26): { inRun, dep, arr, d0, d1, prof } or null inside a stop's stay.
  function runAt(t, d) {
    const n = stopStart[t + 1] - stopStart[t];
    if (!n) return null;
    const c0 = stopStart[t] * 5, last = c0 + (n - 1) * 5;
    for (const r of runsOf(t, n, c0, last)) if (d < r.d1 - 1e-9) return { ...r, inRun: true };
    return null;
  }

  // The nearest point of the trip's own shape to (x, z), with the direction there: a live vehicle reports a point,
  // not a distance along the shape, and this is how its place becomes one.
  function projectAt(t, x, z) {
    const s = shapeOf(t), { offset, count } = trams.shapes[s];
    let best = 0, bestD = Infinity, bestX = 0, bestZ = 0, bestH = 0;
    for (let k = 0; k < count - 1; k++) {
      const a = offset + k, b = a + 1;
      const ax = pts[a * 2], az = pts[a * 2 + 1], bx = pts[b * 2], bz = pts[b * 2 + 1];
      const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
      const f = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
      const px = ax + dx * f, pz = az + dz * f, dd = (x - px) ** 2 + (z - pz) ** 2;
      if (dd < bestD) {
        bestD = dd; best = cum[a] + Math.sqrt(len2) * f; bestX = px; bestZ = pz;
        bestH = Math.atan2(dz, dx);
      }
    }
    return { d: best, x: bestX, z: bestZ, heading: bestH, off: Math.sqrt(bestD) };
  }

  // The next stop call of trip t at or after distance `d` along its shape: {name, d, sec, index}. null for a trip
  // with no stop calls (never, in this feed, but a newer file could have none).
  function nextStopAt(t, d) {
    const n = stopStart[t + 1] - stopStart[t];
    const c0 = stopStart[t] * 5;
    for (let i = 0; i < n; i++) {
      const c = c0 + i * 5;
      if (stops[c + 3] / 100 >= d - 0.5) {
        return { name: trams.stopNames[stops[c + 4]] || '', d: stops[c + 3] / 100, sec: stops[c + 1], index: i };
      }
    }
    const c = c0 + (n - 1) * 5;
    return n ? { name: trams.stopNames[stops[c + 4]] || '', d: stops[c + 3] / 100, sec: stops[c + 1], index: n - 1 } : null;
  }

  // Every trip running at second `sec`: the schedule's own answer to how many trams are on the street.
  function runningAt(sec) {
    const out = [];
    for (let t = 0; t < nTrips; t++) if (sec >= startOf(t) && sec <= endOf(t)) out.push(t);
    return out;
  }

  // The most trams that can ever be running at once, from the starts and ends alone: the capacity of one
  // InstancedMesh, so a busy second never writes past it.
  function peakRunning() {
    const events = [];
    for (let t = 0; t < nTrips; t++) { events.push([startOf(t), 1], [endOf(t), -1]); }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let n = 0, peak = 0;
    for (const [, k] of events) { n += k; peak = Math.max(peak, n); }
    return Math.max(1, peak);
  }

  return {
    trams, trips, nTrips, tripByExternalId,
    lineOf, headsignOf, pointAt, positionAt, projectAt, nextStopAt, runningAt, peakRunning, runAt,
  };
}

// Everything the tooltip says about one tram, in T's language: which line, where it is headed, and its next stop.
// `live` says whether this is the feed's position or the timetable's, so the visitor is never told a timetable is
// a live vehicle. Names come from the file, never from here.
export function tramInfo(net, { trip, live = false, next = null }, T) {
  const line = net.lineOf(trip);
  const toward = net.headsignOf(trip);
  return {
    title: line ? T('tram.line', { ref: line.short || line.id }) : '',
    route: line && line.long ? line.long : '',
    heading: toward ? T('tram.heading', { place: toward }) : '',
    next: next && next.name ? T('tram.next', { name: next.name }) : '',
    note: live ? T('tram.live') : T('tram.schedule'),
    ride: trip !== undefined,   // a tram can be ridden (app.js startRide); a stop's sheet has no trip and no ride
  };
}

// The tooltip's HTML, each line escaped (esc), the empty ones left out, and last the button that rides the tram. The
// button's words are Croatian, as the ride's own way out is (app.js startRide), and it is a button, so the sheet's
// tapped state (styles.css .tram-tip.tapped) is what makes it take a click.
export const tramHtml = (info, esc) => [['tram-title', info.title], ['tram-route', info.route],
  ['tram-heading', info.heading], ['tram-next', info.next], ['tram-note', info.note]].filter(([, t]) => t)
  .map(([cls, t]) => `<p class="${cls}">${esc(t)}</p>`).join('')
  + (info.ride ? '<p class="tram-ride"><button type="button" class="tram-ride-btn">Vozim se</button></p>' : '');
