// The trams drawn on the map (web/trams.js says where each one is): the mapped rails, the vessels running to the
// timetable now, and ZET's live vehicles from /rt where the feed puts them. Every tram is a TMK 2200 at true size
// (data/<version>/trams.json vehicle: 32 m long, 2.3 m wide, 3.4 m high) in the livery the feed gives the line, in
// one InstancedMesh per part so the whole day costs six draw calls.
//
// app.js calls step() every frame while the trams show (at Today only, like the boats): the timetable is read from
// the page's clock in Zagreb's time, so the trams on the screen are the trams on the street, and the live feed is
// polled every LIVE_MS. A live vehicle replaces the timetable's guess for its own trip, so a tram is drawn once.
//
// Under the pointer, hitAt raycasts the two instanced meshes on the screen (the pick pass leaves the trams out, as it
// leaves the boats out: it reads a building id from a pixel) and reports how far along the ray the tram lies, so
// app.js can ask the pick pass whether a building stands in front of it. The tooltip itself is web/boat-tip.js,
// mounted a second time with web/trams.js tramHtml.
import { parseTrams, makeNet, tramClock, tramInfo, tramHtml, delaySeconds } from './trams.js';
import { gunzip } from './veg.js';   // the same gzip in transit, inflated here: no library either way

const LIVE_MS = 15000;      // ZET refreshes its feed about once a minute; a quarter of that keeps the map current
const NIGHT = 0.36;         // the same hand darkening the trees get: an unlit material does not dim at night
const LIFT = 0.2;           // metres from the street to the body's floor, the skirt's bottom edge

// A box whose vertices carry their own light, as the trees' crowns do: the map's materials are unlit, so a flat
// colour would read as a silhouette. Top faces take the sun, the sides less, the ends least.
function shadedBox(THREE, w, h, d, colour) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const n = geo.getAttribute('normal'), pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3), c = new THREE.Color(colour);
  for (let i = 0; i < pos.count; i++) {
    const k = n.getY(i) > 0.5 ? 1.06 : n.getY(i) < -0.5 ? 0.55 : Math.abs(n.getX(i)) > 0.5 ? 0.84 : 0.93;
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export async function makeTrams({ THREE, base, scene, camera, surfaceAt, on = true }) {
  const meta = await (await fetch(`${base}trams.json`)).json();
  const trams = parseTrams(meta);
  const [shapeBuf, tripBuf, stopBuf, railBuf] = await Promise.all(['trams_shapes.bin.gz', 'trams_trips.bin.gz',
    'trams_stops.bin.gz', 'trams_rails.bin.gz'].map(f => fetch(`${base}${f}`).then(r => r.arrayBuffer()).then(gunzip)));
  const net = makeNet(trams, shapeBuf, tripBuf, stopBuf);

  const group = new THREE.Group();
  group.name = 'trams';

  // ---- the rails: the mapped railway=tram ways, at the ground's height, one draw call
  const railPts = new Float32Array(railBuf);
  const segs = [];
  for (const way of trams.rails.index) {
    for (let k = 0; k < way.count - 1; k++) segs.push(way.offset + k, way.offset + k + 1);
  }
  const railPos = new Float32Array(segs.length * 3);
  const railGeo = new THREE.BufferGeometry();
  railGeo.setAttribute('position', new THREE.BufferAttribute(railPos, 3));
  const railMat = new THREE.LineBasicMaterial({ color: 0x4b5157, transparent: true, opacity: 0.85 });
  const rails = new THREE.LineSegments(railGeo, railMat);
  rails.frustumCulled = false;
  group.add(rails);
  // The rails follow the ground: the hills slider and a terrain that arrives after the trams move it, so it is
  // lifted again on the same slow beat as the trams' own heights.
  function liftRails() {
    for (let i = 0; i < segs.length; i++) {
      const p = segs[i];
      railPos[i * 3] = railPts[p * 2];
      railPos[i * 3 + 1] = surfaceAt(railPts[p * 2], railPts[p * 2 + 1]) + 0.07;
      railPos[i * 3 + 2] = railPts[p * 2 + 1];
    }
    railGeo.getAttribute('position').needsUpdate = true;
  }
  liftRails();

  // ---- the vehicles: a body, a window band and the line's own band, all at true size
  const v = trams.vehicle;
  const L = v.length || 32, W = v.width || 2.3, H = v.height || 3.4;
  const bodyGeo = shadedBox(THREE, L, H, W, '#e9e7e2').translate(0, LIFT + H / 2, 0);
  const winGeo = shadedBox(THREE, L * 0.9, H * 0.28, W + 0.05, '#1b2026').translate(0, LIFT + H * 0.62, 0);
  const bandGeo = new THREE.BoxGeometry(L * 0.998, 0.5, W + 0.05).translate(0, LIFT + 0.6, 0);
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const bandMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const schedCap = net.peakRunning();          // no second of the day puts more trams on the street than this
  const liveCap = 320;                          // ZET's feed carries about 150 trams; room for a busy moment
  const make = (cap, geo, mat, name) => {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;                    // they move every frame, all over the city
    m.count = 0;
    m.name = name;
    if (mat === bandMat) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    return m;
  };
  const parts = (tag, cap) => ({
    body: make(cap, bodyGeo, bodyMat, `${tag}-body`),
    win: make(cap, winGeo, winMat, `${tag}-windows`),
    band: make(cap, bandGeo, bandMat, `${tag}-line`),
    cap,
  });
  const sched = parts('tram', schedCap);
  const live = parts('tram-live', liveCap);
  for (const p of [sched, live]) group.add(p.body, p.win, p.band);

  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0),
    P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1), C = new THREE.Color();
  const lineColour = trams.lines.map(l => l.text || l.colour || '#1c3f94');
  // What each drawn instance is, for the tooltip, the ride (app.js stepRide, which stands behind the tram) and for
  // __dbg: index -> {trip, live, x, z, heading, d}
  let drawnSched = [], drawnLive = [];

  function put(p, i, x, y, z, heading, colour) {
    Q.setFromAxisAngle(Y, -heading);            // three.js turns anticlockwise seen from above, from +x towards -z
    M.compose(P.set(x, y, z), Q, S);
    p.body.setMatrixAt(i, M); p.win.setMatrixAt(i, M); p.band.setMatrixAt(i, M);
    C.set(colour);
    p.band.setColorAt(i, C);
  }

  // ---- the live feed: ZET's own positions, already in engine metres (scripts/serve.py projects them)
  // ZET's feed sends no CORS header, so a browser cannot read it directly and the dev server parses it at /rt. A
  // static host has no such endpoint, so a scheduled workflow publishes the same JSON to the `live` branch, and
  // raw.githubusercontent serves that with CORS. Local first, snapshot second.
  const RT_SNAPSHOT = 'https://raw.githubusercontent.com/jurecerkez-code/zagreb-map/live/rt.json';
  let liveVehicles = [];
  let liveAt = 0;
  async function fetchRt() {
    const bust = Math.floor(Date.now() / 60000);
    for (const url of [new URL('rt', location.href).href, `${RT_SNAPSHOT}?t=${bust}`]) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const json = await res.json();
        if (json && Array.isArray(json.vehicles) && json.vehicles.length) return json;
      } catch { /* the next source may still answer */ }
    }
    return null;
  }
  // Issue #26: live trams do not jump between feeds. Every followed trip carries a delay in SECONDS — the gap
  // between the feed's projected distance and the timetable's expectation, eased to its new target over 20 s and
  // never by teleporting the vehicle. Between two polls the vehicle keeps the timetable's own pace (plus its delay).
  const delayOf = new Map();   // trip -> { now, target } in seconds
  let delayTickAt = 0;         // wall-time the ease last moved (the layer has no external per-frame clock)

  async function poll() {
    try {
      const feed = (await fetchRt()) || {};
      const feedSec = Number(feed.ts) || tramClock();

      // Only trams: a vehicle whose trip id is not in the schedule is a bus on another ZET line. Each is put on its
      // own shape once here, not every frame: a live position holds until the next answer.
      const seen = new Set(), out = [];
      for (const x of feed.vehicles || []) {
        const trip = net.tripByExternalId.get(x.trip);
        if (x.kind !== 'tram' || trip === undefined || seen.has(trip)) continue;
        seen.add(trip);
        const p = net.projectAt(trip, x.x, x.z);
        const t = delayOf.get(trip) || { now: 0, target: 0 };
        const exp = net.positionAt(trip, feedSec);
        if (exp) {
          const run = net.runAt(trip, exp.d);
          const slope = run ? (run.d1 - run.d0) / Math.max(1, run.arr - run.dep) : 1;
          t.target = delaySeconds(p.d, exp.d, slope);
          if (!delayOf.has(trip)) t.now = t.target;   // first sighting lands where the feed says: zero ease distorts
          delayOf.set(trip, t);
        }
        out.push({ ...x, trip, d: p.d, heading: p.heading });
      }
      // A trip the feed has dropped: let its delay ease home over the same 20 s, then it stops mattering.
      for (const [trip, t] of delayOf) if (!seen.has(trip)) t.target = 0;
      liveVehicles = out;
      liveAt = Number(feed.ts) || 0;
    } catch { /* the timetable still runs the map; a feed that is down must not empty it */ }
  }

  let show = on;
  group.visible = show;
  let ticks = 0;

  // show: whether the trams belong on the map this frame.
  function step(visible) {
    show = visible;
    group.visible = show;
    if (!show) return;
    const sec = tramClock();
    // The live delay's 20 s ease, ticked once per step with wall time (the app may skip frames when idle).
    if (delayTickAt) {
      const dtEase = Math.min(0.5, Math.max(0, (performance.now() - delayTickAt) / 1000));
      if (dtEase > 0) for (const track of delayOf.values()) {
        track.now += (track.target - track.now) * (1 - Math.exp(-dtEase / 20));
      }
    }
    delayTickAt = performance.now();
    // A live vehicle replaces the timetable's guess for its trip: one tram per trip, never two.
    const liveSeen = new Set();
    drawnLive = [];
    for (const o of liveVehicles) {
      if (liveSeen.has(o.trip) || drawnLive.length >= live.cap) continue;
      liveSeen.add(o.trip);
      const track = delayOf.get(o.trip);
      const exp = net.positionAt(o.trip, sec);
      let x = o.x, z = o.z, d = o.d, heading = o.heading;
      if (track && exp) {
        // The timetable's own pace, plus the ease: the live tram moves between polls exactly as a live one should.
        const run = net.runAt(o.trip, exp.d);
        const slope = run ? (run.d1 - run.d0) / Math.max(1, run.arr - run.dep) : 0;
        d = exp.d + track.now * slope;
        const pt = net.pointAt(net.trips[o.trip * 5], d, d);
        x = pt.x; z = pt.z;
        // The feed sends no bearing: the shape's own direction is the direction of travel. A bearing in degrees from
        // north, if it ever comes, becomes the engine's angle from +x towards +z.
        heading = Number.isFinite(o.bearing) ? Math.atan2(-Math.cos(o.bearing * Math.PI / 180), Math.sin(o.bearing * Math.PI / 180))
          : pt.heading;
      } else if (Number.isFinite(o.bearing)) {
        heading = Math.atan2(-Math.cos(o.bearing * Math.PI / 180), Math.sin(o.bearing * Math.PI / 180));
      }
      const y = surfaceAt(x, z);
      put(live, drawnLive.length, x, y, z, heading, lineColour[net.trips[o.trip * 5 + 3]] || '#1c3f94');
      drawnLive.push({ k: `tram:${o.trip}`, trip: o.trip, live: true, x, y, z, heading, d, next: net.nextStopAt(o.trip, d) });
    }

    drawnSched = [];
    for (const trip of net.runningAt(sec)) {
      if (liveSeen.has(trip) || drawnSched.length >= sched.cap) continue;
      const p = net.positionAt(trip, sec);
      if (!p) continue;
      const y = surfaceAt(p.x, p.z);
      put(sched, drawnSched.length, p.x, y, p.z, p.heading, lineColour[net.trips[trip * 5 + 3]] || '#1c3f94');
      drawnSched.push({ k: `tram:${trip}`, trip, live: false, x: p.x, y, z: p.z, heading: p.heading, d: p.d, next: net.nextStopAt(trip, p.d) });
    }

    for (const p of [sched, live]) {
      const n = p === sched ? drawnSched.length : drawnLive.length;
      p.body.count = p.win.count = p.band.count = n;
      p.body.instanceMatrix.needsUpdate = p.win.instanceMatrix.needsUpdate = p.band.instanceMatrix.needsUpdate = true;
      if (p.band.instanceColor) p.band.instanceColor.needsUpdate = true;
      // The raycast culls against the instances' own bounds first, and they are empty until the matrices hold
      // something: computed here, every frame, since the trams move all over the city. Without it hitAt never hits.
      p.body.computeBoundingSphere();
    }
    // heights follow the ground slowly: the hills slider and a terrain that lands after the trams
    if (++ticks % 120 === 1) liftRails();
  }

  // ---- under the pointer
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const F = new THREE.Vector3();
  // The tram under (px, py) on a screen w by h: {trip, live, next, depth}, depth as the camera's own (view space -z,
  // where its far plane cuts) so app.js can draw the far plane in to it and ask the pick pass what stands in front.
  function hitAt(px, py, w, h) {
    if (!group.visible || (!drawnSched.length && !drawnLive.length)) return null;
    ndc.set(px / w * 2 - 1, 1 - py / h * 2);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([live.body, sched.body], false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const set = hit.object === live.body ? drawnLive : drawnSched;
    const d = set[hit.instanceId];
    if (!d) return null;
    const depth = hit.distance * ray.ray.direction.dot(camera.getWorldDirection(F));
    return { ...d, depth };
  }

  // Night: the body, the windows and the line's band are unlit, so they are darkened by hand as the trees are.
  let nightOn = false;
  function setNight(v) {
    nightOn = !!v;
    const k = nightOn ? NIGHT : 1;
    bodyMat.color.setScalar(k);
    winMat.color.setScalar(k);
    bandMat.color.setScalar(k);
  }

  scene.add(group);
  poll();
  setInterval(poll, LIVE_MS);
  // Scratch for inView(): one frustum projection per ask, never an allocation in the frame loop.
  const inViewFrustum = new THREE.Frustum();
  const inViewProj = new THREE.Matrix4();
  const inViewPoint = new THREE.Vector3();
  const inViewSphere = new THREE.Sphere();
  return {
    group, net,
    step, hitAt, setNight,
    get on() { return show; },
    // Issue #23: the render loop asks this before it grants trams their 20 fps idle tier — one drawn tram inside the
    // camera's frustum keeps the cadence, an empty frustum drops the frame rate to zero.
    inView(cam) {
      if (!show) return false;
      const probe = inViewSphere;
      inViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      inViewFrustum.setFromProjectionMatrix(inViewProj);
      for (const d of drawnSched) if (inViewFrustum.intersectsSphere(probe.set(inViewPoint.set(d.x, d.y ?? 0, d.z), 15))) return true;
      for (const d of drawnLive) if (inViewFrustum.intersectsSphere(probe.set(inViewPoint.set(d.x, d.y ?? 0, d.z), 15))) return true;
      return false;
    },
    get list() { return [...drawnSched, ...drawnLive]; },   // what is on the screen now (scripts/trams_check.mjs)
    get drawn() { return { schedule: drawnSched.length, live: drawnLive.length, total: drawnSched.length + drawnLive.length }; },
    get liveAt() { return liveAt; },
    // The ease's seconds for a followed trip — the ride's ETA and its LIVE dot read them (issue #26).
    liveDelay(t) { return delayOf.get(t)?.now ?? null; },
    get vehicles() { return liveVehicles.length; },
    // the tooltip: web/boat-tip.js mounts a second time on this
    html: (hit, T, esc) => (hit && hit.trip !== undefined ? tramHtml(tramInfo(net, hit, T), esc) : ''),
  };
}
