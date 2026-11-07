// The trams drawn on the map (web/trams.js says where each one is): the mapped rails, the vessels running to the
// timetable now, and ZET's live vehicles from /rt where the feed puts them. Every tram is a TMK 2200 at true size
// (data/<version>/trams.json vehicle: 32 m long, 2.3 m wide, 3.4 m high) in ZET's own livery — blue body, black
// window band, grey roof, a sloped windshield on both cabs (it runs double-ended), a single-arm pantograph — built
// in five sections that follow the shape independently, with wheelsets and open door frames.
// One InstancedMesh per part keeps the whole day at a handful of draw calls.
//
// app.js calls step() every frame while the trams show (at Today only, like the boats): the timetable is read from
// the page's clock in Zagreb's time, so the trams on the screen are the trams on the street, and the live feed is
// polled every LIVE_MS. A live vehicle replaces the timetable's guess for its own trip, so a tram is drawn once.
//
// Under the pointer, hitAt raycasts the two instanced meshes on the screen (the pick pass leaves the trams out, as it
// leaves the boats out: it reads a building id from a pixel) and reports how far along the ray the tram lies, so
// app.js can ask the pick pass whether a building stands in front of it. The tooltip itself is web/boat-tip.js,
// mounted a second time with web/trams.js tramHtml.
import { parseTrams, makeNet, tramClock, tramInfo, tramHtml } from './trams.js';
import { gunzip } from './veg.js';   // the same gzip in transit, inflated here: no library either way
import { BODY_PARTS, SECTION_LENGTH, SECTION_CENTRES, vehicleDimensions, makeDoorFrame } from './tram-model.js';

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

  // ---- the vehicles: a TMK 2200 as the fleet actually runs them. ZET blue (#0e63b8) over black windows and a
  // grey roof; the cab's big windshield tilts back. Five sections per tram, each placed on the shape itself:
  // four bellows, wheelsets and door outlines read at street level, not another blue cuboid.
  const dimensions = vehicleDimensions(trams.vehicle);
  const L = dimensions.length, W = dimensions.width, H = dimensions.height;
  const ZET = '#0e63b8', GLASS = '#171a1e', ROOF = '#c9cdd2', DARK = '#22262b', SIGN = '#e8b33f';
  const geoOf = c => shadedBox(THREE, 1, 1, 1, c);   // unit cube, scaled per instance; the shading rides along
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const roofMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const faceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  // Every material stays white: the geometry's vertices carry both the colour and the face's light
  // (a coloured base colour would multiply the vertices' own, and the pantograph would go twice as dark).
  const pantMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  const signMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  // These geometries carry no vertex-colour attribute, so their actual material colour must stand alone.
  const doorMat = new THREE.MeshBasicMaterial({ color: ROOF, side: THREE.DoubleSide });
  const wheelMat = new THREE.MeshBasicMaterial({ color: DARK });
  const doorGeo = makeDoorFrame(THREE).geometry;
  const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 1.78, 8); // octagonal tyres are enough at map scale
  wheelGeo.rotateX(Math.PI / 2);   // axle across the tram, not along its track

  const TILT = 0.42;                                              // the windshield's lean-back, in radians

  const schedCap = net.peakRunning();          // no second of the day puts more trams on the street than this
  const liveCap = 320;                          // ZET's feed carries about 150 trams; room for a busy moment
  const make = (cap, geo, mat, name) => {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;                    // they move every frame, all over the city
    m.count = 0;
    m.name = name;
    return m;
  };
  // Cab parts exist twice per tram. Body parts are five, and door frames and axles are five on each visible side.
  const parts = (tag, cap) => ({
    body: make(cap * BODY_PARTS, geoOf(ZET), bodyMat, `${tag}-body`),
    win: make(cap * BODY_PARTS, geoOf(GLASS), winMat, `${tag}-windows`),
    roof: make(cap * BODY_PARTS, geoOf(ROOF), roofMat, `${tag}-roof`),
    doors: make(cap * BODY_PARTS * 2, doorGeo, doorMat, `${tag}-doors`),
    wheels: make(cap * BODY_PARTS * 2, wheelGeo, wheelMat, `${tag}-wheels`),
    face: make(cap * 2, geoOf(GLASS), faceMat, `${tag}-cab`),
    pant: make(cap * 2, geoOf(DARK), pantMat, `${tag}-pant`),
    sign: make(cap * 2, geoOf(SIGN), signMat, `${tag}-sign`),
    cap,
  });
  const sched = parts('tram', schedCap);
  const live = parts('tram-live', liveCap);
  for (const p of [sched, live]) group.add(p.body, p.win, p.roof, p.doors, p.wheels, p.face, p.pant, p.sign);

  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), QT = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0),
    ZAX = new THREE.Vector3(0, 0, 1), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
  // What each drawn tram is, for the tooltip, the ride (app.js stepRide, which stands behind the tram) and for
  // __dbg: index -> {trip, live, x, z, heading, d}; each body mesh holds three consecutive instances for one tram.
  let drawnSched = [], drawnLive = [];

  // One instance: yaw about the world's Y (from +x towards -z), then an optional lean in the tram's own frame
  // (the windshields tilt; everything else does not).
  function instance(mesh, i, x, y, z, heading, sx, sy, sz, lean = 0) {
    Q.setFromAxisAngle(Y, -heading);
    if (lean) Q.multiply(QT.setFromAxisAngle(ZAX, lean));
    M.compose(P.set(x, y, z), Q, S.set(sx, sy, sz));
    mesh.setMatrixAt(i, M);
  }

  // Five body sections follow the shape. Two wheelsets and two outlined door frames per section
  // are actual geometry, so the TMK reads as a tram from street level instead of a cuboid.
  function putVehicle(p, k, trip, d, x, y, z, heading) {
    const shape = trip != null ? net.trips[trip * 5] : null;
    const sLen = trip != null ? net.trips[trip * 5 + 2] : 0;
    const iBody = k * BODY_PARTS, iDetail = k * BODY_PARTS * 2, i2 = k * 2;
    for (let s = 0; s < BODY_PARTS; s++) {
      if (shape != null && d != null) {
        const dd = Math.max(0, Math.min(sLen, d + SECTION_CENTRES[s]));
        const pt = net.pointAt(shape, dd, dd), yy = surfaceAt(pt.x, pt.z);
        instance(p.body, iBody + s, pt.x, yy + LIFT + H / 2, pt.z, pt.heading, SECTION_LENGTH, H, W);
        instance(p.win, iBody + s, pt.x, yy + LIFT + 1.98, pt.z, pt.heading, SECTION_LENGTH * 0.94, 1.25, W + 0.04);
        instance(p.roof, iBody + s, pt.x, yy + LIFT + H + 0.05, pt.z, pt.heading, SECTION_LENGTH * 0.98, 0.1, W * 0.94);
        for (const side of [-1, 1]) {
          const index = iDetail + s * 2 + (side === 1 ? 1 : 0), offset = side * (W / 2 + 0.035);
          const dx = Math.sin(pt.heading) * offset, dz = Math.cos(pt.heading) * offset;
          instance(p.doors, index, pt.x + dx, yy + LIFT + 1.25, pt.z + dz, pt.heading, 1, 1, 1);
          const axleD = Math.max(0, Math.min(sLen, dd + side * 0.65));
          const axle = net.pointAt(shape, axleD, axleD), axleY = surfaceAt(axle.x, axle.z);
          instance(p.wheels, index, axle.x, axleY + 0.33, axle.z, axle.heading, 1, 1, 1);
        }
        if (s === Math.floor(BODY_PARTS / 2)) {   // the pantograph lives on the middle section
          const bx = Math.cos(pt.heading) * 0.4, bz = -Math.sin(pt.heading) * 0.4;
          instance(p.pant, i2, pt.x - bx, yy + LIFT + H + 1.05, pt.z - bz, pt.heading, 0.11, 1.9, 0.11, -0.9);
          instance(p.pant, i2 + 1, pt.x + bx, yy + LIFT + H + 1.05, pt.z + bz, pt.heading, 0.11, 1.9, 0.11, 0.9);
        }
      } else {
        instance(p.body, iBody + s, x, y + LIFT + H / 2, z, heading, SECTION_LENGTH, H, W);
        instance(p.win, iBody + s, x, y + LIFT + 1.98, z, heading, SECTION_LENGTH * 0.94, 1.25, W + 0.04);
        instance(p.roof, iBody + s, x, y + LIFT + H + 0.05, z, heading, SECTION_LENGTH * 0.98, 0.1, W * 0.94);
      }
    }
    if (shape != null && d != null) {   // both cabs: the TMK 2200 runs double-ended, so both ends get a windshield
      const dF = Math.min(sLen, d + L / 2 - 0.35), dR = Math.max(0, d - L / 2 + 0.35);
      const pF = net.pointAt(shape, dF, dF), yF = surfaceAt(pF.x, pF.z);
      const pR = net.pointAt(shape, dR, dR), yR = surfaceAt(pR.x, pR.z);
      instance(p.face, i2, pF.x, yF + LIFT + 2.15, pF.z, pF.heading, 0.14, 1.5, W - 0.06, -TILT);
      instance(p.face, i2 + 1, pR.x, yR + LIFT + 2.15, pR.z, pR.heading, 0.14, 1.5, W - 0.06, TILT);
      // the destination sign stands proud of the windshield, or its amber never reaches the eye
      const dFS = Math.min(sLen, dF + 0.13), dRS = Math.max(0, dR - 0.13);
      const pFS = net.pointAt(shape, dFS, dFS), pRS = net.pointAt(shape, dRS, dRS);
      instance(p.sign, i2, pFS.x, yF + LIFT + H - 0.42, pFS.z, pF.heading, 0.09, 0.42, 1.5);
      instance(p.sign, i2 + 1, pRS.x, yR + LIFT + H - 0.42, pRS.z, pR.heading, 0.09, 0.42, 1.5);
    }
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
  // Issue #26: live trams do not jump between feeds. Every followed trip carries a delay in METRES along the shape
  // — the gap between the feed's projected distance and the timetable's expectation at the same clock — eased to
  // its new target over 20 s and never by teleporting the vehicle. Metres, not seconds, because the pace changes at
  // every stop's edge: an offset held in seconds would hop by exactly its own share there.
  // lastD: when the trip's service window ends (a tram that outruns its own day), the timetable's expectation
  // stops existing — falling back to the feed's raw point from there is exactly the teleport the ease exists to
  // prevent, so the last drawn distance stands as the drawn distance until the feed moves it again.
  const delayOf = new Map();   // trip -> { now, target, lastD }
  let delayTickAt = 0;         // wall-time the ease last moved (the layer has no external per-frame clock)

  async function poll() {
    try {
      const feed = (await fetchRt()) || {};
      // Same clock on both sides, always: the drawn position samples the timetable at the PAGE's Zagreb clock in
      // step(), so the delay must be measured against the same clock here. The feed's own stamp (liveAt) is only
      // the staleness reading for the HUD: mixing a minutes-stale feed clock into exp once pulled every drawn tram
      // through double-counted seconds (the live-swap snap, #26).

      // Only trams: a vehicle whose trip id is not in the schedule is a bus on another ZET line. Each is put on its
      // own shape once here, not every frame: a live position holds until the next answer.
      const seen = new Set(), out = [];
      for (const x of feed.vehicles || []) {
        const trip = net.tripByExternalId.get(x.trip);
        if (x.kind !== 'tram' || trip === undefined || seen.has(trip)) continue;
        seen.add(trip);
        const p = net.projectAt(trip, x.x, x.z);
        const t = delayOf.get(trip) || { now: 0, target: 0 };
        const exp = net.positionAt(trip, tramClock());
        if (exp) {
          // The delay lives in metres along the shape (feed point minus the timetable's expectation), never in
          // seconds: a seconds reading multiplied by the current pace hops by the delay's own share at every stop
          // boundary the pace changes, which is exactly the snap the live marker must never take (#26).
          t.target = Math.max(-900, Math.min(900, p.d - exp.d));
          if (!delayOf.has(trip)) {
            t.now = t.target;                       // a first sighting appears where it actually is
            delayOf.set(trip, t);
          } else if (Math.abs(t.target - t.now) > 600) t.now = t.target;   // a teleport still snaps, a stutter never does
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
    // The live delay's 20 s ease, ticked once per step with wall time (the app may skip frames when idle). The
    // per-frame wish is capped at a tram's own ceiling — 2.5 m a frame and 10 m/s a second — because the ease is
    // exactly what must never outrun its vehicle: a teleported feed catches up at tram speed, not faster.
    if (delayTickAt) {
      const dtEase = Math.min(0.5, Math.max(0, (performance.now() - delayTickAt) / 1000));
      if (dtEase > 0) for (const track of delayOf.values()) {
        const wish = (track.target - track.now) * (1 - Math.exp(-dtEase / 20));
        const cap = Math.min(2.5, 10 * dtEase);
        track.now += Math.max(-cap, Math.min(cap, wish));
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
      if (track && (exp || track.lastD != null)) {
        // The timetable's own distance, plus the ease: both terms already in metres, so a stop boundary (where the
        // pace changes) never moves the tram by the delay's own share between two frames. Past the end of the
        // service window the last served distance stands (the window's end has no expectation to jump back to).
        d = exp ? exp.d + track.now : track.lastD;
        track.lastD = d;
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
      putVehicle(live, drawnLive.length, o.trip, d, x, y, z, heading);
      drawnLive.push({ k: `tram:${o.trip}`, trip: o.trip, live: true, x, y, z, heading, d, next: net.nextStopAt(o.trip, d) });
    }

    drawnSched = [];
    for (const trip of net.runningAt(sec)) {
      if (liveSeen.has(trip) || drawnSched.length >= sched.cap) continue;
      const p = net.positionAt(trip, sec);
      if (!p) continue;
      const y = surfaceAt(p.x, p.z);
      putVehicle(sched, drawnSched.length, trip, p.d, p.x, y, p.z, p.heading);
      drawnSched.push({ k: `tram:${trip}`, trip, live: false, x: p.x, y, z: p.z, heading: p.heading, d: p.d, next: net.nextStopAt(trip, p.d) });
    }

    for (const p of [sched, live]) {
      const n = p === sched ? drawnSched.length : drawnLive.length;
      p.body.count = p.win.count = p.roof.count = n * BODY_PARTS;
      p.doors.count = p.wheels.count = n * BODY_PARTS * 2;
      p.face.count = p.pant.count = p.sign.count = n * 2;
      for (const mesh of [p.body, p.win, p.roof, p.doors, p.wheels, p.face, p.pant, p.sign]) mesh.instanceMatrix.needsUpdate = true;
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
    const d = set[Math.floor(hit.instanceId / BODY_PARTS)];   // five body sections per drawn tram
    if (!d) return null;
    const depth = hit.distance * ray.ray.direction.dot(camera.getWorldDirection(F));
    return { ...d, depth };
  }

  // Night: the body, the windows, the roof and the cab trim are unlit, so they are darkened by hand as the trees are.
  let nightOn = false;
  function setNight(v) {
    nightOn = !!v;
    const k = nightOn ? NIGHT : 1;
    for (const m of [bodyMat, winMat, roofMat, doorMat, wheelMat, faceMat, pantMat, signMat]) m.color.setScalar(k);
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
    // The ease's seconds for a followed trip — the ride's ETA and its LIVE dot read them (issue #26). Stored in
    // metres, read at the segment's own pace so an ETA stays an ETA; a paused tram still eases, so the fallback is
    // a tram-under-load pace, not a hop.
    liveDelay(t) {
      const m = delayOf.get(t)?.now;
      if (m == null) return null;
      const exp = net.positionAt(t, tramClock());
      const run = exp ? net.runAt(t, exp.d) : null;
      const pace = run ? (run.d1 - run.d0) / Math.max(1, run.arr - run.dep) : 0;
      return m / Math.max(1, pace);
    },
    get vehicles() { return liveVehicles.length; },
    // the tooltip: web/boat-tip.js mounts a second time on this
    html: (hit, T, esc) => (hit && hit.trip !== undefined ? tramHtml(tramInfo(net, hit, T), esc) : ''),
  };
}
