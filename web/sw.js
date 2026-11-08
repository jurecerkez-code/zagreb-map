// Versioned data is immutable. The pointer, worker, application and /rt always take the normal network path.
const PREFIX = 'zagreb-map-data-';
const SAFE_VERSION = /^v\d{8}(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const cacheName = version => PREFIX + version;

function dataVersion(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url), scope = new URL(globalThis.registration.scope);
  const prefix = `${scope.pathname.endsWith('/') ? scope.pathname : `${scope.pathname}/`}data/`;
  if (url.origin !== globalThis.location.origin || url.origin !== scope.origin ||
      !url.pathname.startsWith(prefix) || url.pathname.endsWith('/')) return null;
  const parts = url.pathname.slice(prefix.length).split('/');
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part.includes('..') ||
      part.includes('\\') || /%(?:2e|2f|5c)/i.test(part))) return null;
  const version = parts[0];
  return SAFE_VERSION.test(version) && !version.includes('..') ? version : null;
}

async function onFetch(request, version) {
  let cache;
  try {
    cache = await caches.open(cacheName(version));
    const cached = await cache.match(request);
    if (cached) return cached;
  } catch {
    return fetch(request);
  }
  const response = await fetch(request);
  if (response.status === 200 && !response.redirected) {
    try { await cache.put(request, response.clone()); } catch { /* storage pressure must not break the map */ }
  }
  return response;
}

globalThis.addEventListener('fetch', event => {
  const version = dataVersion(event.request);
  if (version !== null) event.respondWith(onFetch(event.request, version));
});

globalThis.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const pointerUrl = new URL('data/current.json', globalThis.registration.scope).href;
      const response = await fetch(pointerUrl, { cache: 'no-store' });
      if (!response.ok) return;
      const pointer = await response.json();
      if (!pointer || !SAFE_VERSION.test(pointer.version) || pointer.version.includes('..')) return;
      const keep = cacheName(pointer.version);
      const names = await caches.keys();
      await Promise.all(names
        .filter(name => name.startsWith(PREFIX) && name !== keep)
        .map(name => caches.delete(name)));
    } catch {
      // Offline activation is not evidence that cached cities are obsolete.
    }
  })());
});
