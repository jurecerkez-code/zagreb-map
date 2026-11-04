// The north button (index.html .north-open, app.js North): the map turns to face north, the short way round, in about
// half a second, and at once for a viewer who asks for less motion. North-up is azimuth 0 in the local frame (x east,
// z south): OrbitControls' theta is atan2(x, z) of the camera's offset from the target, so at 0 the camera stands
// south of the place and looks north. Only the azimuth changes; app.js keeps the place, the zoom and the tilt. Pure,
// so node --test can check it.
export const TURN_MS = 500;
const TAU = 2 * Math.PI;

// Into (-π, π]: both ends are one direction, and π stands for it. Never -0.
export const wrapAngle = a => (a - TAU * Math.ceil((a - Math.PI) / TAU)) || 0;

// The signed turn from `from` to `to` that is at most half a turn.
export const shortestTurn = (from, to = 0) => wrapAngle(to - from);

// A turn to north that starts at `now` (ms) from azimuth `from`. Already north, or calm (prefers-reduced-motion), it is
// over at once.
export function northTurn(from, now, { calm = false } = {}) {
  from = wrapAngle(from);
  const delta = shortestTurn(from);
  return { from, delta, t0: now, dur: calm || Math.abs(delta) < 1e-9 ? 0 : TURN_MS };
}

// The azimuth `turn` has at `now`, eased in and out like a flight (app.js stepFlight). The end is exactly 0. A frame
// stamped before the turn began (the render loop's time is the frame's start) is its start.
export function turnAt(turn, now) {
  const k = turn.dur > 0 ? Math.max(0, (now - turn.t0) / turn.dur) : 1;
  if (k >= 1) return { theta: 0, done: true };
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  return { theta: turn.from + turn.delta * e, done: false };
}

// The needle's CSS rotation in degrees, clockwise: at azimuth π/2 the camera stands east of the place and looks west,
// so north is to the right of the screen. A tenth of a degree, so a still map writes no new style.
export const needleDeg = theta => Math.round(wrapAngle(theta) * 1800 / Math.PI) / 10 || 0;

// The four cardinal headings the compass snaps to, clockwise from north, as camera azimuth: in the local frame
// (x east, z south) the camera's offset angle is atan2(x, z), so E is +π/2 — the camera stands east of the place
// looking west. Export for tests and for the key table below.
export const CARDINALS = Object.freeze([0, Math.PI / 2, Math.PI, -Math.PI / 2]);              // N E S W
export const CARDINAL_KEYS = Object.freeze({ n: 0, e: Math.PI / 2, s: Math.PI, w: -Math.PI / 2 });

// The nearest of the four cardinals to an azimuth — the press-to-snap target: whatever side of the world you level
// the map at, one click puts it exactly there. Ties (exactly between two) fall to the side at the smaller index:
// north, then east, then south, then west — any deterministic order would do, but "north wins the seam" matches
// what a user who mostly pressed N expects.
export function nearestCardinal(a) {
  a = wrapAngle(a);
  let best = 0, dist = Infinity;
  CARDINALS.forEach((c, i) => {
    const d = Math.abs(wrapAngle(a - c));
    if (d < dist - 1e-12) { dist = d; best = i; }
  });
  return CARDINALS[best];
}

// Where the camera stands for a heading: due south of the ground north stays north-up; parameterised in azimuth
// (x/z of the offset in the plane), so any heading works, cardinal or dragged. y is untouched: the tilt is the
// user's, not the compass's.
export function bearingOffset(h, rad) { return { x: h * Math.sin(rad), z: h * Math.cos(rad) }; }

// The compass, all its surfaces in one place. Three ways in, all free of state that could latch: a drag of the
// needle turns the camera under the pointer, a click snaps to the nearest cardinal, and the N/E/S/W keys snap to
// their side. The needle is drawn on every frame from the bearing the camera actually has, so a dropped press
// shows as a wrong needle, not a stuck button.
//
// `endHolds` runs before any change of heading: a ride or a flight owns the camera, and a press asks for it back.
export function makeNorth({ camera, controls, endHolds = () => {}, typingIn = () => false, doc = document,
  buttonSel = '.north-open' } = {}) {
  let at = null;
  const btn = () => doc.querySelector(buttonSel);
  const draw = rad => {
    const d = needleDeg(rad);
    if (d === at) return;
    at = d;
    const svg = btn()?.querySelector('svg');
    if (svg) svg.style.transform = `rotate(${d}deg)`;
  };
  const face = rad => {
    endHolds();
    const p = camera.position, c = controls.target, h = Math.hypot(p.x - c.x, p.z - c.z);
    if (h > 1e-3) p.set(c.x + h * Math.sin(rad), p.y, c.z + h * Math.cos(rad));
    controls._sphericalDelta.set(0, 0, 0);       // the vendored OrbitControls (r186) inertia must not carry on
    controls._panOffset.set(0, 0, 0);
    controls.update();
    at = null;
    draw(rad);
  };
  const snap = () => face(0);
  const snapNearest = () => face(nearestCardinal(controls.getAzimuthalAngle()));

  // The gesture. A press starts on the compass; moving more than DRAG_PX px is a drag of the needle, and the
  // camera follows the pointer's bearing live. A release without travel is the click: snap to nearest cardinal.
  let drag = null;
  const DRAG_PX = 5;
  const headingOf = e => {
    const r = btn()?.getBoundingClientRect();
    if (!r) return null;
    return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2)));
  };
  const onPointer = e => {
    if (!e.target?.closest?.(buttonSel)) return;
    drag = { x0: e.clientX, y0: e.clientY, moved: false, id: e.pointerId };
  };
  const onMove = e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > DRAG_PX) drag.moved = true;
    if (!drag.moved) return;
    const rad = headingOf(e);
    if (rad != null) face(rad);
  };
  const onUp = e => {
    if (!drag || drag.id !== e.pointerId) return;
    const wasDrag = drag.moved;
    drag = null;
    if (!wasDrag) snapNearest();
  };
  const onKey = e => {
    const k = e.key && e.key.toLowerCase();
    if (!(k in CARDINAL_KEYS)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typingIn(e.target)) return;
    face(CARDINAL_KEYS[k]);
  };
  doc.addEventListener('pointerdown', onPointer, true);
  doc.addEventListener('pointermove', onMove, true);
  doc.addEventListener('pointerup', onUp, true);
  doc.addEventListener('pointercancel', () => { drag = null; }, true);
  doc.addEventListener('keydown', onKey);
  return { snap, face, snapNearest, draw, press: onPointer };
}
