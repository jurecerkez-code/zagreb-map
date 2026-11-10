// A version directory is a dated publication, optionally followed by a short build suffix.
// Suffixes such as "lite", "p4u" and "fix" have no reliable chronological order.
function parseVersion(value) {
  if (typeof value !== 'string' || value.includes('..')) return null;
  const match = /^v(\d{4})(\d{2})(\d{2})(?:-([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(stamp);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return { stamp };
}

export function showNewVersion({ current, offered }) {
  if (current === offered) return false;
  const a = parseVersion(current), b = parseVersion(offered);
  if (!a || !b) return false;
  // Across dates, never announce a rollback as newer. Within one date the server's pointer is authoritative:
  // suffixes are build labels, not an alphabetically sortable release sequence.
  return b.stamp > a.stamp || b.stamp === a.stamp;
}

export function makeMapUpdateMonitor({ currentVersion, serviceWorker, fetchJson, onNewVersion,
  interval = 60_000, schedule = setInterval, onError = error => console.warn('Map service-worker registration failed.', error) }) {
  let checking = false, announced = null;
  async function check() {
    if (checking) return false;
    checking = true;
    try {
      const published = await fetchJson('data/current.json', { cache: 'no-store' });
      if (showNewVersion({ current: currentVersion, offered: published?.version }) && announced !== published.version) {
        await onNewVersion(published.version);
        announced = published.version;
        return true;
      }
    } catch {
      // A transient offline poll changes neither the visible map nor its cached data.
    } finally {
      checking = false;
    }
    return false;
  }
  return {
    check,
    async start() {
      if (serviceWorker?.register) {
        try { await serviceWorker.register('sw.js'); }
        catch (error) { onError(error); }
      }
      await check();
      if (interval > 0) schedule(check, interval);
    },
  };
}

export function makeMapUpdateChip({ document, reload }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-update';
  button.textContent = 'Nova verzija karte · Osvježi';
  button.hidden = true;
  button.addEventListener('click', reload);
  document.body.append(button);
  return version => {
    button.dataset.version = version;
    button.hidden = false;
  };
}
