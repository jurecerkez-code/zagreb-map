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

// The compass, all its surfaces in one place. A press — pointer, tap on a phone, or the N key — snaps the camera
// north on the frame it landed, wherever the camera was: first click works, fiftieth click works, because there is
// no turn to state-misremember. The earlier lives of this bug were (a) an eased turn whose state guard could stick
// and (b) a handler bound to a button node the header's redraw then replaced. Neither state nor node binding here:
// the snap is immediate, the wiring hangs off the document, and the needle is drawn on every frame from the bearing
// the camera actually has, so a dropped press would show as a wrong needle, not a stuck button.
//
// `endHolds` runs before the snap: a ride or a flight owns the camera, and a press asks for it back.
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
  const snap = () => {
    endHolds();
    const p = camera.position, c = controls.target, h = Math.hypot(p.x - c.x, p.z - c.z);
    if (h > 1e-3) p.set(c.x, p.y, c.z + h);      // due south of the place is azimuth 0: the map faces north
    controls._sphericalDelta.set(0, 0, 0);       // the vendored OrbitControls (r186) inertia must not carry on
    controls._panOffset.set(0, 0, 0);
    controls.update();
    at = null;
    draw(0);
  };
  let pressedAt = -1e9;
  const onPointer = e => {
    if (!e.target?.closest?.(buttonSel)) return;
    pressedAt = performance.now();
    snap();
  };
  const onClick = e => {
    if (!e.target?.closest?.(buttonSel)) return;
    if (performance.now() - pressedAt < 700) return;   // pointerdown already snapped: one press, one snap
    snap();
  };
  const onKey = e => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typingIn(e.target)) return;
    snap();
  };
  doc.addEventListener('pointerdown', onPointer, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey);
  return { snap, draw, press: onPointer };
}
