// A start-up guard, loaded as a classic script just before app.js. If the browser cannot fetch app.js or a module
// it imports, the module never runs and the page would stay at "Building the city 0%"; this says so instead, with
// the same words as app.js's loadFailed. A failed script load fires `error` at its <script>, which does not bubble,
// so the listener captures it on the window. A module that arrives but cannot run (a top-level throw, or syntax the
// browser cannot parse) reports on the window itself, with the module's address; that counts while nothing has
// loaded yet. A file, not an inline handler: the page's Content-Security-Policy allows scripts from its own address
// only (scripts/build_dist.py).
addEventListener('error', e => {
  const el = document.getElementById('loading');
  if (!el) return;
  const fetchFailed = e.target instanceof HTMLScriptElement;
  const runFailed = e.target === window && /^[^?#]*\.js([?#]|$)/.test(e.filename || '')
    && e.filename.startsWith(location.origin) && document.getElementById('progress')?.textContent === '0';
  if (!fetchFailed && !runFailed) return;
  el.hidden = false;
  el.textContent = croatian()
    ? 'Podaci o gradu nisu se mogli učitati. Ponovno učitajte stranicu.'
    : 'Could not load the city data. Reload the page to try again.';
}, true);
// Croatian before English, following the same query and saved choice as the app. Storage and browser language
// lists are advisory: an explicit ?lang= wins, then the saved choice, then a compatible browser language.
function croatian() {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'hr' || q === 'en') return q === 'hr';
    const saved = localStorage.getItem('hfh-lang');
    if (saved === 'hr' || saved === 'en') return saved === 'hr';
  } catch { /* private mode still gets the browser's language below */ }
  for (const language of navigator.languages || [navigator.language]) {
    const locale = String(language || '').toLowerCase();
    if (locale === 'hr' || locale.startsWith('hr-') || locale === 'bs' || locale.startsWith('bs-')
      || locale === 'sr-latn' || locale.startsWith('sr-latn-')) return true;
    if (locale === 'en' || locale.startsWith('en-')) return false;
  }
  return false;
}
