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
export const BOOST_MS = 4000;   // issue #23: full dpr (2) is earned only after 4 s of median frames under 8 ms

// The boost verdict, pure: the page starts at min(dpr, 1.5); a median frame under 8 ms sustained over the last
// BOOST_MS means the GPU walks through the work even at the top ladder step, so full-resolution dpr is allowed.
// The evidence must fill the window, not sketch it: at 200 fps a mere hundred frames are half a second.
export function shouldBoost(gaps, now) {
  const win = gaps.filter(g => now - g.t <= BOOST_MS && g.dt < 250);
  if (win.length < 20 || now - win[0].t < BOOST_MS) return false;
  const fps = medianFps(gaps, now, BOOST_MS);
  return fps != null && fps > 1000 / 8;
}

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

// The page's owner: call quality.frame(now) from the render loop each frame (issue #23: on a drawn frame, the idle
// map does not feed it); it applies the scale itself and leaves a console line every time, honest about what it just
// did. `base` is the start (min(devicePixelRatio, 1.5) with MSAA on, #23); `boost` is the full-dpr ceiling the ladder
// earns only through shouldBoost — 4 s of median frames under 8 ms at the top step, say=2 on a retina display.
// `startStep` opens the ladder one notch down on GPUs whose own name says integrated (Intel, Mali, Adreno, ...).
export function makeQuality({ renderer, base = Math.min(
    typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 1.5), boost = Math.min(
    typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 2), startStep = 0,
  say = (...a) => console.info(...a) } = {}) {
  const gaps = [];
  let boosted = false;
  let i = Math.max(0, Math.min(STEPS.length - 1, startStep));
  let lastChange = -1e9;
  let last = -1e9;

  const scale = () => boosted ? boost : base * STEPS[i];
  const apply = fps => {
    renderer.setPixelRatio(scale());
    say(`quality: ${fps.toFixed(1)} fps pinned — pixel ratio ${scale().toFixed(2)}${boosted ? ' (headroom boost)' : ''} (adaptive)`);
  };

  return {
    frame(now) {
      if (last > 0) {
        gaps.push({ t: now, dt: now - last });
        if (gaps.length > 400) gaps.splice(0, gaps.length - 400);   // ~13 s of history is plenty
        const fps = medianFps(gaps, now);
        const next = nextStep(i, fps, now - lastChange);
        if (next !== i) { i = next; boosted = false; lastChange = now; apply(fps); }
        else if (!boosted && i === 0 && shouldBoost(gaps, now)) { boosted = true; lastChange = now; apply(fps); }
      }
      last = now;
    },
    get step() { return i; },
    get boosted() { return boosted; },
  };
}
