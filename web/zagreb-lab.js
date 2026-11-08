// Zagreb Lab is the page chrome, not a second rendering engine. The map keeps its
// period/estimate shaders; only the worksheet, typography and control dock change.
// Reference colours are transcribed from the public sources listed in docs/zagreb-lab.md.
export const LAB_UI = Object.freeze({
  '--ui-bg': '#0b0d33', '--ui-glass': 'rgba(11,13,51,.66)', '--ui-surface': '#161a78',
  '--ui-line': 'rgba(92,92,255,.16)', '--ui-line-strong': 'rgba(92,92,255,.24)',
  '--ui-fg': '#ecebf7', '--ui-muted': '#9a9ccc', '--ui-faint': '#6b6fa8',
  '--ui-gold': '#d8b55a', '--ui-gold-light': '#edd18f', '--ui-link': '#8f96ff',
  '--ui-ok': '#6ee7a8', '--ui-bad': '#ff6b81',
  '--paper': '#F4EFE6', '--red': '#FE2A00', '--step': '8px',
  '--display': '"Inter Display",sans-serif', '--mono': '"JetBrains Mono",ui-monospace,monospace',
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
  '--display': '"Inter Display",sans-serif', '--mono': '"JetBrains Mono",ui-monospace,monospace',
  '--bg': '#F4EFE6', '--panel': '#FAF7F1', '--ink': '#171717', '--muted': '#665f58',
  '--accent': '#FE2A00', '--link': '#2F5FAE', '--card-bg': '#FFFDF9',
  '--card-ink': '#171717', '--card-ground': '#F4EFE6', '--line': '#E5DED2',
  '--muted-content': '#665f58', '--accent-content': '#a82009',
});
// The default Foto scene keeps its photograph under Lab chrome; Paper is an explicit chrome variant.
const PAPER_LOOKS = new Set(['arg', 'kalk', 'paper']);
export const chromeKind = name => PAPER_LOOKS.has(name) ? 'paper' : 'lab';
export const chromeTokens = name => chromeKind(name) === 'paper' ? PAPER_UI : LAB_UI;

// Move the existing controls instead of making duplicate controls/listeners. Comments
// keep their original homes, so choosing a Paper look restores the old chrome exactly.
export function mountLabChrome(doc = document) {
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
  const syncLayers = () => layers.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
  const observer = new MutationObserver(syncLayers);
  observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  syncLayers();

  moreOpen.addEventListener('click', () => {
    more.showModal();
    moreOpen.setAttribute('aria-expanded', 'true');
  });
  more.querySelector('.lab-more-close')?.addEventListener('click', close);
  more.addEventListener('close', () => moreOpen.setAttribute('aria-expanded', 'false'));
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
  return { sync };
}
