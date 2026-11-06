// The ride's heads-up line (issue #26): what tram this is, where it goes next, and whether the position is live.
// Plain DOM with plain styles — a #34 token skin can restyle it later; its job is that the facts read from across
// the room. app.js startRide creates it, update() every ride step, endRide drops it.
export function makeRideHud({ T }) {
  const el = document.createElement('div');
  el.className = 'ride-hud';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="ride-line" aria-hidden="true"></span>
    <span class="ride-head">
      <span class="ride-dest"></span>
      <span class="ride-next"></span>
    </span>
    <span class="ride-speed" aria-hidden="true"></span>
    <span class="ride-live" title="">LIVE</span>`;
  const line = el.querySelector('.ride-line'), dest = el.querySelector('.ride-dest'),
    next = el.querySelector('.ride-next'), speedEl = el.querySelector('.ride-speed'),
    liveEl = el.querySelector('.ride-live');

  function fmtMins(seconds) {
    const m = Math.max(0, Math.round(seconds / 60));
    return m <= 0 ? T('ui.ride.now') : (T.num ? T.num(m) : String(m)) + ' min';
  }

  return {
    el,
    // { line: '11', colour: '#1c3f94', headsign, next: {name, mins}, speedKmh, live: bool, staleSec, fetchedAt }
    update({ line: ln, colour, headsign, next: n, speedKmh, live, staleSec, fetchedAt }) {
      line.textContent = ln ?? '';
      line.style.background = colour || '#1c3f94';
      dest.textContent = headsign || '';
      next.textContent = n?.name ? `${n.name} · ${fmtMins(n.sec ?? 0)}` : '';
      speedEl.textContent = speedKmh == null ? '' : `${Math.max(0, Math.round(speedKmh))} km/h`;
      liveEl.textContent = live ? 'LIVE' : T('ui.ride.tt');
      liveEl.classList.toggle('ride-live-on', !!live);
      liveEl.classList.remove('ride-live-stale');
      // The feed's own timestamp in the tooltip is the whole story when the feed is old (issue #26's freshness line).
      if (live && Number.isFinite(staleSec)) {
        liveEl.title = fetchedAt
          ? `${T('ui.ride.snapshot')} ${new Date(fetchedAt * 1000).toLocaleTimeString()} · ${Math.round(staleSec / 60)} min`
          : '';
        if (staleSec > 600) liveEl.classList.add('ride-live-stale');
      } else {
        liveEl.title = '';
      }
    },
    hide() { el.hidden = true; },
    show() { el.hidden = false; },
    dispose() { el.remove(); },
  };
}
