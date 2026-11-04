// Adaptive render quality: the map is meant to be explored on any machine, also on an integrated GPU that can only
// fill a full-resolution window about a dozen times a second once the whole city is on screen (measured 2026-11-04,
// 1280x720 Chrome on a 2019-class iGPU: 13.5 fps at the home view, independent of the look). A renderer at reduced
// internal resolution fills proportionally faster and the scene stays readable, which beats a choppy 1:1 buffer at
// half the cadence.
//
// The rule is deliberately small and hysteretic so it cannot oscillate: a rolling median of recent frames judges
// every WINDOW_MS; below LOW it steps down a notch, above HIGH it steps up a notch, and after any change it stays
// quiet for COOLDOWN_MS so a frame spike while the timeline flies by (the rise shader does extra work) cannot flip
// it back and forth. Pure decision parts stay exported for node --test.
export const LOW = 24;          // sustained fps under this reads as lag on an interactive 3D map
export const HIGH = 45;         // sustained fps above this justifies one step back toward full resolution
export const WINDOW_MS = 2000;  // how long a spell must last before the engine reacts
export const COOLDOWN_MS = 4000;
export const STEPS = [1, 0.85, 0.72, 0.6, 0.5];   // render-scale ladder, full first

// The median of recent frame gaps, ignoring the tab-hidden stalls (>250 ms are background throttling, not cost).
export function medianFps(gaps, now, windowMs = WINDOW_MS) {
  const recent = gaps.filter(g => now - g.t <= windowMs && g.dt < 250).map(g => g.dt).sort((a, b) => a - b);
  if (recent.length < 20) return null;              // too fresh: no verdict before two dozen real frames
  const dt = recent[recent.length >> 1];
  return dt > 0 ? 1000 / dt : null;
}

// The one-decision function, pure: given the current ladder index, the measured fps, and the ms since the last
// change, return the new index. Tests assert the hysteresis: below LOW steps down, above HIGH only after cooldown
// steps up, and stuck in-between it never moves.
export function nextStep(i, fps, sinceChange) {
  if (fps == null) return i;
  if (fps < LOW && i < STEPS.length - 1 && sinceChange >= WINDOW_MS) return i + 1;
  if (fps > HIGH && i > 0 && sinceChange >= COOLDOWN_MS) return i - 1;
  return i;
}

// The page's owner: call quality.frame(now) from the render loop each frame; it applies the scale itself and
// leaves a console line every time, honest about what it just did.
export function makeQuality({ renderer, base = Math.min(
    typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 2),
  say = (...a) => console.info(...a) } = {}) {
  const gaps = [];
  let i = 0;
  let lastChange = -1e9;
  let last = -1e9;

  const apply = fps => {
    renderer.setPixelRatio(base * STEPS[i]);
    say(`quality: ${fps.toFixed(1)} fps pinned over 2 s — render scale ${STEPS[i].toFixed(2)} (adaptive)`);
  };

  return {
    frame(now) {
      if (last > 0) {
        gaps.push({ t: now, dt: now - last });
        if (gaps.length > 400) gaps.splice(0, gaps.length - 400);   // ~13 s of history is plenty
        const fps = medianFps(gaps, now);
        const next = nextStep(i, fps, now - lastChange);
        if (next !== i) { i = next; lastChange = now; apply(fps); }
      }
      last = now;
    },
    get step() { return i; },
  };
}
