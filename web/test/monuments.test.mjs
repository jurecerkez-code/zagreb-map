import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownAt, monumentsOnFrom, monumentCard, makeMonuments, NOMINAL, FIGURE_AT, MATERIALS } from '../monuments.js';
import { THEMES } from '../themes.js';
import * as THREE from '../vendor/three.module.js';

const jelacic = { name: 'Ban Josip Jelačić', kind: 'equestrian', year: 1866, removed: [[1947, 1989]], mat: 'bronze', h: 9,
  by: ['Anton Dominik Fernkorn'], qid: 'Q121636557', wp: { hr: 'Kip bana Josipa Jelačića u Zagrebu' },
  ex: { hr: { t: 'Kip bana <Josipa> Jelačića.', r: 7131100 } } };

test('a monument shows from its year, not while it was removed, always at Today', () => {
  assert.equal(shownAt(jelacic, 1865, 2026), false);
  assert.equal(shownAt(jelacic, 1866, 2026), true);
  assert.equal(shownAt(jelacic, 1947, 2026), false);
  assert.equal(shownAt(jelacic, 1989, 2026), false);
  assert.equal(shownAt(jelacic, 1990, 2026), true);
  assert.equal(shownAt(jelacic, 2026, 2026), true);
  assert.equal(shownAt({ kind: 'bust' }, 1700, 2026), true);   // no year: always
});

test('the switch is on unless turned off', () => {
  assert.equal(monumentsOnFrom(null), true);
  assert.equal(monumentsOnFrom('off'), false);
});

test('every kind has a figure height and every look its materials', () => {
  for (const k of Object.keys(NOMINAL)) assert.ok(FIGURE_AT[k] >= 0 && FIGURE_AT[k] < NOMINAL[k], k);
  for (const look of Object.keys(THEMES)) assert.ok(MATERIALS[look], look);
});

test('monuments share the scene light and the buildings night attenuation', () => {
  const uniforms = {
    uYear: { value: 2026 }, uSun: { value: new THREE.Vector3(0, 1, 0) },
    uFog: { value: new THREE.Vector2(9000, 26000) }, uFogColor: { value: new THREE.Color('#b3c7dd') },
    uSunCol: { value: new THREE.Color('#ffdcae') }, uSkyCol: { value: new THREE.Color('#b3c7dd') },
    uNight: { value: 0 },
  };
  const monuments = makeMonuments(THREE, {
    list: [{ id: 'test', kind: 'statue', mat: 'stone', x: 0, z: 0, h: 7, year: 1900 }],
    uniforms, surfaceAt: () => 0, camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, look: () => 'paper', yearMax: 2026,
  });
  const material = monuments.group.children[0].material;
  for (const key of ['uSun', 'uSunCol', 'uSkyCol', 'uNight']) assert.equal(material.uniforms[key], uniforms[key], key);
  assert.match(material.fragmentShader, /uSunCol \* \(max\(dot\(n, normalize\(uSun\)\), 0\.0\) \* 2\.2\)/);
  assert.match(material.fragmentShader, /uSkyCol \* \(mix\(0\.6, 1\.0, n\.y \* 0\.5 \+ 0\.5\) \* 0\.55\)/);
  assert.match(material.fragmentShader, /mix\(c, c \* vec3\(0\.30, 0\.36, 0\.56\), uNight\)/);
});

test('the card escapes, names the sculptor, the removal and the Croatian excerpt', () => {
  const T = (id, v = {}) => `${id}${Object.values(v).length ? `(${Object.values(v).join(',')})` : ''}`;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = monumentCard(jelacic, { T, esc, link: (h, t) => `<a href="${esc(h)}">${esc(t)}</a>`, lang: 'en', photoHtml: '' });
  assert.match(html, /Anton Dominik Fernkorn/);
  assert.match(html, /monument\.removed\(1947,1990\)/);
  assert.match(html, /lang="hr"/);
  assert.match(html, /&lt;Josipa&gt;/);
  assert.match(html, /oldid=7131100/);
});
