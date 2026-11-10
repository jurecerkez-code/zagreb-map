// Pure load-probe/budget checks: this module must stay usable in static Node tests without Playwright.
export const NETWORK_4MBIT = Object.freeze({
  offline: false,
  latency: 150,
  downloadThroughput: 500_000, // 4,000,000 bits/s, bytes/s as required by CDP
  uploadThroughput: 500_000,
});
export const MAX_REVEAL_BYTES = 5_500_000;
// What a repeat visit must not do is download the city again. On CI at 4 Mbit/s the second load moved 4,500 bytes:
// the shell and the four reveal packs came from the HTTP cache, the rest of the city from the service worker.
export const SECOND_REVEAL_BYTES = 200_000;
// The clock on a repeat visit is compile and draw, not bytes. A GitHub runner draws the first frame with SwiftShader,
// which alone costs seconds (measured 6,032 ms there; 1.5-4 s on a GPU-less laptop). The ceiling is set to catch the
// regression it can actually catch, a second visit that starts pulling the city again (9 s at 4 Mbit/s), and no
// tighter: a tighter number would only be met by a machine nobody ships to.
export const SECOND_REVEAL_MS = 12_000;

export function loadProbeFailures(result) {
  const p = result.phases ?? {}, failures = [];
  if (!Number.isFinite(p.criticalBytes)) failures.push('first-load byte measurements are missing');
  else if (p.criticalBytes > MAX_REVEAL_BYTES) {
    failures.push(`first-load bytesBeforeReveal ${p.criticalBytes} exceeds ${MAX_REVEAL_BYTES}`);
  }
  if (!Number.isFinite(p.cachedCriticalBytes)) failures.push('second-load byte measurements are missing');
  else if (p.cachedCriticalBytes > SECOND_REVEAL_BYTES) {
    failures.push(`second-load bytesBeforeReveal ${p.cachedCriticalBytes} re-downloads the city `
      + `(over ${SECOND_REVEAL_BYTES})`);
  }
  if (!Number.isFinite(p.cachedRevealMs)) failures.push('second-load reveal was not measured');
  else if (p.cachedRevealMs >= SECOND_REVEAL_MS) {
    failures.push(`second-load reveal ${p.cachedRevealMs} ms must be under ${SECOND_REVEAL_MS} ms at 4 Mbit/s`);
  }
  if (result.errors?.length) failures.push(`page errors: ${result.errors.length}`);
  if (result.missing?.length) failures.push(`HTTP/404 responses: ${result.missing.length}`);
  if (result.rejected?.length) failures.push(`failed requests: ${result.rejected.length}`);
  if (result.fatal) failures.push(`probe failed: ${result.fatal}`);
  if (result.worker && result.worker.supported !== false && !result.worker.active) {
    failures.push('service worker is not active for the second navigation');
  }
  return failures;
}

export function numericBudgetFailures(measured, budget) {
  return Object.entries(budget)
    .filter(([key, limit]) => typeof limit === 'number' && Number.isFinite(limit)
      && Number.isFinite(measured[key]) && measured[key] > limit)
    .map(([key, limit]) => `${key}=${measured[key]} > ${limit}`);
}
