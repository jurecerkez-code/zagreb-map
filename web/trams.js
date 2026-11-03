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

// trams.json's blocks, checked: a newer file with a missing block must leave no trams rather than throw in the loop.
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
  // the depot, or has arrived). Between two stops the distance grows with the time between the departure and the
  // next arrival, which is the timetable's own answer; while a tram stands at a stop, it stands at that stop.
  function positionAt(t, sec) {
    const s = startOf(t), e = endOf(t);
    if (sec < s || sec > e) return null;
    const n = stopStart[t + 1] - stopStart[t];
    if (!n) return null;
    const c0 = stopStart[t] * 5;
    const first = c0, last = c0 + (n - 1) * 5;
    let d;
    if (sec <= stops[first + 1]) d = stops[first + 3] / 100;                       // not yet at the first stop
    else if (sec >= stops[last + 2]) d = stops[last + 3] / 100;                    // arrived at the last one
    else {
      let c = first;
      while (c + 5 <= last && stops[c + 5 + 1] <= sec) c += 5;                     // the call before `sec`
      if (sec <= stops[c + 2]) d = stops[c + 3] / 100;                             // standing at it
      else {
        const from = stops[c + 2], to = stops[c + 5 + 1], f = (sec - from) / Math.max(1, to - from);
        d = (stops[c + 3] + (stops[c + 5 + 3] - stops[c + 3]) * Math.max(0, Math.min(1, f))) / 100;
      }
    }
    return pointAt(shapeOf(t), d, d);
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
    lineOf, headsignOf, pointAt, positionAt, projectAt, nextStopAt, runningAt, peakRunning,
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
