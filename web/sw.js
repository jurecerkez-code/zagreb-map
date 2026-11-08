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

async function publishedVersion() {
  const pointerUrl = new URL('data/current.json', globalThis.registration.scope).href;
  const response = await fetch(pointerUrl, { cache: 'no-store' });
  if (!response.ok) return null;
  const pointer = await response.json();
  return pointer && SAFE_VERSION.test(pointer.version) && !pointer.version.includes('..') ? pointer.version : null;
}

function siblingName(pack) {
  const name = typeof pack === 'string' ? pack : pack?.file;
  return typeof name === 'string' && name && !name.includes('/') && !name.includes('\\')
      && name !== '.' && name !== '..' && !name.includes('..') ? name : null;
}

async function installCriticalData() {
  // Registration still happens after reveal. Install therefore cannot delay the first map, and a first page with no
  // controller does not matter: the worker reads its config once and has all reveal packs before the next navigation.
  const version = await publishedVersion();
  if (version === null) return;
  const root = new URL(`data/${version}/`, globalThis.registration.scope);
  const configResponse = await fetch(new URL('zagreb.json', root).href, { cache: 'force-cache' });
  if (!configResponse.ok) throw new Error('Cannot install city config');
  const config = await configResponse.json();
  if (config.version !== version || !Array.isArray(config.packs)) throw new Error('City pointer/config version mismatch');
  const names = config.packs.map(siblingName);
  if (names.some(name => name === null)) throw new Error('Unsafe reveal pack name');
  const count = Number.isInteger(config.revealPacks) && config.revealPacks > 0
    ? Math.min(config.revealPacks, names.length) : names.length;
  const cache = await caches.open(cacheName(version));
  await Promise.all(['zagreb.json', ...names.slice(0, count)].map(async name => {
    const request = new Request(new URL(name, root).href, { cache: 'force-cache' });
    const response = await fetch(request);
    if (response.status !== 200 || response.redirected) throw new Error(`Cannot precache ${name}`);
    await cache.put(request, response.clone());
  }));
}

globalThis.addEventListener('install', event => {
  event.waitUntil(installCriticalData());
});

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
