// Zagreb Lab is the page chrome, not a second rendering engine. The map keeps its
// period/estimate shaders; only the worksheet, typography and control dock change.
// Reference colours are transcribed from the public sources listed in docs/zagreb-lab.md.
export const LAB_UI = Object.freeze({
  '--ui-bg': '#0b0d33', '--ui-glass': 'rgba(11,13,51,.72)', '--ui-surface': '#11144a',
  '--ui-line': '#2b3170', '--ui-line-strong': '#3d4390',
  '--ui-fg': '#ecebf7', '--ui-muted': '#9a9ccc', '--ui-faint': '#5d6199',
  '--ui-gold': '#d8b55a', '--ui-gold-light': '#e3c46f', '--ui-link': '#8f96ff',
  '--ui-ok': '#6ee7a8', '--ui-bad': '#ff6b81',
  '--paper': '#F4EFE6', '--red': '#FE2A00', '--step': '8px',
  '--display': '"Inter",system-ui,sans-serif', '--mono': '"JetBrains Mono",ui-monospace,Menlo,monospace',
  // Legacy scene/component aliases are applied in the same loop as the canonical --ui tokens.
  '--bg': '#0b0d33', '--panel': '#11144a', '--ink': '#ecebf7', '--muted': '#9a9ccc',
  '--accent': '#d8b55a', '--link': '#8f96ff', '--card-bg': '#161a78',
  '--card-ink': '#ecebf7', '--card-ground': '#0b0d33', '--line': '#2b3170',
  '--muted-content': '#9a9ccc', '--accent-content': '#d8b55a',
});
export const PAPER_UI = Object.freeze({
  '--ui-bg': '#F4EFE6', '--ui-glass': 'rgba(244,239,230,.90)', '--ui-surface': '#FAF7F1',
  '--ui-line': 'rgba(23,23,23,.16)', '--ui-line-strong': 'rgba(23,23,23,.36)',
  '--ui-fg': '#171717', '--ui-muted': '#665f58', '--ui-faint': '#766e64',
  '--ui-gold': '#FE2A00', '--ui-gold-light': '#a82009', '--ui-link': '#2F5FAE',
  '--ui-ok': '#176b38', '--ui-bad': '#a82009',
  '--paper': '#F4EFE6', '--red': '#FE2A00', '--step': '8px',
  '--display': '"Inter",system-ui,sans-serif', '--mono': '"JetBrains Mono",ui-monospace,Menlo,monospace',
  '--bg': '#F4EFE6', '--panel': '#FAF7F1', '--ink': '#171717', '--muted': '#665f58',
  '--accent': '#FE2A00', '--link': '#2F5FAE', '--card-bg': '#FFFDF9',
  '--card-ink': '#171717', '--card-ground': '#F4EFE6', '--line': '#E5DED2',
  '--muted-content': '#665f58', '--accent-content': '#a82009',
});
// The default Foto scene keeps its photograph under Lab chrome; Paper is an explicit chrome variant.
const PAPER_LOOKS = new Set(['arg', 'kalk', 'paper']);
export const chromeKind = name => PAPER_LOOKS.has(name) ? 'paper' : 'lab';
export const chromeTokens = name => chromeKind(name) === 'paper' ? PAPER_UI : LAB_UI;

export function labSpecification(config, T) {
  if (!config || !Number.isFinite(config.stats?.buildings) || !Number.isFinite(config.yearMin)
    || !Number.isFinite(config.yearMax) || !Array.isArray(config.districts)) return '';
  const upper = id => T(id).toLocaleUpperCase(T.lang === 'hr' ? 'hr-HR' : T.lang === 'sv' ? 'sv-SE' : 'en');
  return `${T.num(config.stats.buildings)} ${upper('ui.lab.spec.buildings')} · ${config.yearMin}–${config.yearMax} · ${config.districts.length} ${upper('ui.lab.spec.districts')}`;
}

const LAB_MOUNTS = new WeakMap();

// The pinned card is a non-modal ARIA dialog, so it has no native Tab trap.
// Only a visible dialog in the Lab chrome is captured; Paper keeps its prior behavior.
// Escape invokes the established close operation, which records/restores focus itself.
export function trapLabFocus(root, { close = () => root.querySelector('.card-close, .lab-more-close')?.click() } = {}) {
  const doc = root?.ownerDocument;
  if (!root || !doc || !root.addEventListener) return () => {};
  const onkeydown = event => {
    const modal = root.getAttribute?.('role') === 'dialog' || (root.tagName === 'DIALOG' && root.open);
    if (root.hidden || doc.documentElement?.dataset?.ui !== 'lab' || !modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && !el.disabled && el.isConnected !== false
        && (typeof el.tabIndex !== 'number' || el.tabIndex >= 0)
        && (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0));
    if (!items.length) return;
    const at = items.indexOf(doc.activeElement), last = items.length - 1;
    if (event.shiftKey ? at <= 0 : at === last || at < 0) {
      event.preventDefault();
      (event.shiftKey ? items[last] : items[0]).focus({ preventScroll: true });
    }
  };
  root.addEventListener('keydown', onkeydown, true);
  return () => root.removeEventListener('keydown', onkeydown, true);
}

// Move the existing controls instead of making duplicate controls/listeners. Comments
// keep their original homes, so choosing a Paper look restores the old chrome exactly.
export function mountLabChrome(doc = document) {
  if (LAB_MOUNTS.has(doc)) return LAB_MOUNTS.get(doc);
  const dock = doc.querySelector('.corner .buttons');
  const more = doc.getElementById('lab-more');
  const moreOpen = doc.getElementById('lab-more-button');
  const moreItems = doc.getElementById('lab-more-items');
  const layers = doc.getElementById('lab-layers');
  const panel = doc.getElementById('panel');
  const handle = panel?.querySelector('.sheet-handle');
  if (!dock || !more || !moreOpen || !moreItems || !layers || !panel || !handle) return { sync() {} };

  const entries = ['.north-open', '.stories-open', '.postcard-open', '.lang'].map(selector => {
    const el = dock.querySelector(selector);
    if (!el) return null;
    const home = doc.createComment(`zagreb-lab-home ${selector}`);
    el.before(home);
    // Icon-only actions need a visible name when they live in the More worksheet.
    if (selector === '.north-open' || selector === '.postcard-open') {
      const label = doc.createElement('span');
      label.className = 'lab-secondary-label';
      label.dataset.i18n = selector === '.north-open' ? 'ui.lab.north' : 'postcard.open';
      el.append(label);
    }
    return { el, home };
  }).filter(Boolean);
  let moved = false;

  const close = () => { if (more.open) more.close(); };
  trapLabFocus(doc.getElementById('card'));
  trapLabFocus(more, { close });
  const syncLayers = () => layers.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
  const Observer = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
  if (typeof Observer === 'function') new Observer(syncLayers)
    .observe(panel, { attributes: true, attributeFilter: ['class'] });
  syncLayers();

  moreOpen.addEventListener('click', () => {
    if (!more.open) more.showModal();
    moreOpen.setAttribute('aria-expanded', 'true');
  });
  more.querySelector('.lab-more-close')?.addEventListener('click', close);
  more.addEventListener('close', () => {
    moreOpen.setAttribute('aria-expanded', 'false');
    moreOpen.focus({ preventScroll: true });
  });
  more.addEventListener('click', e => { if (e.target === more) close(); });
  layers.addEventListener('click', () => {
    if (panel.classList.contains('collapsed')) handle.click();
    handle.focus({ preventScroll: true });
    syncLayers();
  });
  // Postcard replaces the whole page chrome. Stories and About retain the More sheet,
  // so their own close operations return to a real, visible trigger.
  moreItems.addEventListener('click', e => {
    if (e.target.closest('.postcard-open')) setTimeout(close, 0);
  });

  function sync(kind) {
    const lab = kind === 'lab';
    layers.hidden = !lab;
    moreOpen.hidden = !lab;
    if (lab && !moved) {
      entries.forEach(({ el }) => moreItems.append(el));
      moved = true;
    } else if (!lab && moved) {
      close();
      entries.forEach(({ el, home }) => home.parentNode?.insertBefore(el, home));
      moved = false;
    }
  }
  const api = { sync };
  LAB_MOUNTS.set(doc, api);
  return api;
}
