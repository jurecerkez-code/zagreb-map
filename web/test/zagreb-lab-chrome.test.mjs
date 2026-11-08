import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountLabChrome, trapLabFocus } from '../zagreb-lab.js';

class Element {
  constructor(doc, name = '') {
    this.ownerDocument = doc; this.name = name; this.children = [];
    this.attrs = {}; this.dataset = {}; this.listeners = new Map(); this.hidden = false;
    this.foci = 0; this.clicks = 0; this.open = false; this.parentNode = null;
    this.classes = new Set(); this.disabled = false; this.isConnected = true;
    this.queries = new Map();
  }
  set className(s) { this.classes = new Set(s.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  get classList() {
    return { contains: n => this.classes.has(n), toggle: (n, on) => on ? this.classes.add(n) : this.classes.delete(n) };
  }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  emit(type, init = {}) {
    const event = { target: this, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  append(...nodes) { for (const node of nodes) {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(n => n !== node);
    this.children.push(node); node.parentNode = this;
  } }
  before(node) {
    if (!node.parentNode) this.parentNode?.children.push(node);
    node.parentNode = this.parentNode;
  }
  insertBefore(node, before) {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(n => n !== node);
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parentNode = this;
    return node;
  }
  querySelector(selector) { return this.queries.get(selector) || null; }
  querySelectorAll() { return this.queries.get('focusables') || []; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  contains(node) { return this === node || this.children.includes(node); }
  focus() { this.ownerDocument.activeElement = this; this.foci++; }
  click() { this.clicks++; return this.emit('click'); }
}

function focusFixture() {
  const doc = { activeElement: null, documentElement: { dataset: { ui: 'lab' } } };
  const card = new Element(doc), first = new Element(doc), last = new Element(doc);
  card.attrs.role = 'dialog'; card.append(first, last); card.queries.set('focusables', [first, last]);
  return { doc, card, first, last };
}
const tab = (card, target, shiftKey = false) => card.emit('keydown', { key: 'Tab', target, shiftKey });

test('Lab dialog focus wraps from the last control and Escape invokes the real close path once', () => {
  const { doc, card, first, last } = focusFixture();
  let closes = 0;
  trapLabFocus(card, { close: () => { closes++; card.attrs.role = ''; } });
  const forward = tab(card, last);
  assert.equal(doc.activeElement, first);
  assert.equal(forward.prevented, true);
  tab(card, first, true);
  assert.equal(doc.activeElement, last);
  const outside = tab(card, new Element(doc));
  assert.equal(doc.activeElement, first);
  assert.equal(outside.prevented, true);
  const escape = card.emit('keydown', { key: 'Escape', target: first });
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(closes, 1);
  // Modal cancellation must not leak to the map's unrelated Escape handlers.
  card.emit('keydown', { key: 'Escape', target: first });
  assert.equal(closes, 1);
  doc.documentElement.dataset.ui = 'paper';
  assert.equal(tab(card, last).prevented, false, 'Paper uses its pre-existing focus behavior');
});

function chromeFixture() {
  const doc = {
    activeElement: null, documentElement: { dataset: { ui: 'lab' } },
    children: new Map(), patches: new Map(), observations: [],
    getElementById(id) { return this.children.get(id) || null; },
    querySelector(selector) { return this.patches.get(selector) || null; },
    createComment() { return new Element(this, 'comment'); },
    createElement() { return new Element(this); },
  };
  for (const id of ['lab-more', 'lab-more-button', 'lab-more-items', 'lab-layers', 'panel', 'card'])
    doc.children.set(id, new Element(doc, id));
  const dock = new Element(doc), north = new Element(doc), handle = new Element(doc), close = new Element(doc);
  dock.append(north); dock.queries.set('.north-open', north);
  for (const s of ['.stories-open', '.postcard-open', '.lang']) dock.queries.set(s, null);
  doc.patches.set('.corner .buttons', dock);
  doc.children.get('panel').queries.set('.sheet-handle', handle);
  doc.children.get('lab-more').queries.set('.lab-more-close', close);
  doc.children.get('lab-more').showModal = function () { this.open = true; close.focus(); };
  doc.children.get('lab-more').close = function () { this.open = false; this.emit('close'); };
  doc.observationCallback = null;
  doc.defaultView = { MutationObserver: class {
    constructor(callback) { doc.observationCallback = callback; doc.observations.push(this); this.calls = 0; }
    observe() { this.calls++; }
  } };
  return { doc, dock, north, handle, close };
}

test('More reuses existing controls, restores its trigger, and is idempotent across mounts and theme syncs', () => {
  const { doc, dock, north } = chromeFixture();
  const more = doc.children.get('lab-more'), trigger = doc.children.get('lab-more-button'), items = doc.children.get('lab-more-items');
  const first = mountLabChrome(doc);
  assert.equal(mountLabChrome(doc), first, 'the same document gets the same mounted controller');
  assert.equal(doc.observations.length, 1);
  const opens = trigger.listeners.get('click');
  first.sync('lab'); first.sync('lab');
  assert.equal(opens.length, 1);
  assert.equal(north.parentNode, items);
  assert.equal(items.children.filter(n => n === north).length, 1);
  trigger.click(); trigger.click();
  assert.equal(more.open, true);
  more.emit('click');
  assert.equal(more.open, false);
  assert.equal(doc.activeElement, trigger);
  assert.equal(more.attrs['aria-expanded'] ?? 'true', 'true');
  assert.equal(trigger.attrs['aria-expanded'], 'false');
  first.sync('paper');
  assert.equal(north.parentNode, dock);
  assert.equal(trigger.hidden, true);
  first.sync('lab'); first.sync('paper');
  assert.equal(north.parentNode, dock, 'each Paper sync restores, never duplicates, the original node');
});

test('Layers forwards to the real sheet and reflects its expanded state; missing chrome fails softly', () => {
  const { doc, handle } = chromeFixture();
  const panel = doc.children.get('panel'), layers = doc.children.get('lab-layers');
  panel.classes.add('collapsed');
  handle.addEventListener('click', () => { panel.classes.delete('collapsed'); doc.observationCallback(); });
  mountLabChrome(doc).sync('lab');
  assert.equal(layers.attrs['aria-expanded'], 'false');
  assert.ok(layers.listeners.has('click'), 'the real Layers forwarding listener is attached');
  layers.click();
  assert.equal(handle.clicks, 1);
  assert.equal(doc.activeElement, handle);
  assert.equal(layers.attrs['aria-expanded'], 'true');
  panel.classes.add('collapsed'); doc.observationCallback();
  assert.equal(layers.attrs['aria-expanded'], 'false');
  assert.doesNotThrow(() => {
    const chrome = mountLabChrome({ querySelector: () => null, getElementById: () => null });
    chrome.sync('lab');
  });
});

test('More and the card install the same focus helper without replacing their established controls', () => {
  const source = readFileSync(new URL('../zagreb-lab.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(source, /trapLabFocus\(doc\.getElementById\('card'\)\)/);
  assert.match(source, /trapLabFocus\(more, \{ close \}\)/);
  assert.match(source, /moreOpen\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /role', 'dialog'/);
});
