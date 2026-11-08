import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../vendor/three.core.js';
import { makeMonuments, monumentCard } from '../monuments.js';
import { monumentView, makeMonumentPreview, flipRenderPixels, pixelVariance, nextMonumentMediaTab } from '../monument-preview.js';

const close = (got, want, tolerance = 1e-6) => assert.ok(Math.abs(got - want) <= tolerance, `${got} != ${want}`);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const T = (id, vars = {}) => `${id}${Object.values(vars).length ? `(${Object.values(vars).join(',')})` : ''}`;
const link = (url, label) => `<a href="${esc(url)}">${esc(label)}</a>`;

class FakeRenderer {
  constructor() { this.target = { name: 'city-target' }; this.calls = []; this.readbacks = 0; }
  getRenderTarget() { return this.target; }
  setRenderTarget(target) { this.target = target; }
  render(scene, camera) { this.calls.push({ scene, camera, target: this.target }); }
  readRenderTargetPixels(target, x, y, w, h, pixels) {
    assert.equal(target.width, 512); assert.equal(target.height, 384);
    this.readbacks++;
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const i = (row * w + col) * 4;
      pixels[i] = (col * 17 + row * 13) & 255;
      pixels[i + 1] = (col * 3 + row * 29) & 255;
      pixels[i + 2] = (col + row * 7) & 255;
      pixels[i + 3] = 255;
    }
  }
}
class FakeImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } }
function fakeCanvas() {
  const canvas = { writes: [], attributes: {}, dataset: {} };
  canvas.setAttribute = (k, v) => { canvas.attributes[k] = String(v); };
  canvas.getContext = type => {
    assert.equal(type, '2d');
    return { putImageData: image => canvas.writes.push(image) };
  };
  return canvas;
}
function statueLayer(m = { id: 'node/statue', name: 'Nikola Tesla', kind: 'statue', x: 10, z: 20, h: 5, dir: 90, mat: 'bronze' }) {
  const layer = makeMonuments(THREE, { list: [m], uniforms: { uYear: { value: 2026 }, uSun: { value: new THREE.Vector3(0, 0.6, -0.8) },
      uFog: { value: new THREE.Vector2(9000, 26000) }, uFogColor: { value: new THREE.Color('#eef') } },
    surfaceAt: () => 7, camera: new THREE.PerspectiveCamera(), renderer: { domElement: { clientWidth: 800, clientHeight: 600 } },
    look: () => 'arg', yearMax: 2026 });
  layer.place();
  return { layer, m };
}

test('card camera is 3h from the centre, on the monument front and under a golden light', () => {
  const { m } = statueLayer();
  const view = monumentView(m, { surfaceAt: () => 7, streets: {} });
  assert.deepEqual(view.size, [512, 384]);
  close(Math.hypot(...view.camera.position.map((v, i) => v - view.target[i])), 3 * m.h);
  // east-facing monument
  assert.ok(view.camera.position[0] > 10 && view.target[0] === 10);
  close(view.target[1], 7 + m.h / 2);
  assert.equal(view.front.source, 'direction');
  assert.match(view.light.color, /^#[fF][fF]/);
  assert.ok(view.light.direction[1] > 0 && view.light.direction[1] < 0.6);

  const noDirection = { ...m, dir: null };
  const streetView = monumentView(noDirection, { surfaceAt: () => 7,
    streets: { ways: [{ o: 0, c: 2 }], points: new Float32Array([-10, 15, 10, 15]) } });
  assert.equal(streetView.front.source, 'street');
  assert.ok(streetView.camera.position[2] < 20);
});

test('readback pixels are vertically flipped and luminance variance detects a blank buffer', () => {
  const source = new Uint8Array([
    1, 2, 3, 255, 4, 5, 6, 255,
    7, 8, 9, 255, 10, 11, 12, 255,
  ]);
  assert.deepEqual([...flipRenderPixels(source, 2, 2)], [7, 8, 9, 255, 10, 11, 12, 255, 1, 2, 3, 255, 4, 5, 6, 255]);
  assert.ok(pixelVariance(source) > 0);
  const flat = new Uint8Array(16).fill(128);
  assert.equal(pixelVariance(flat), 0);
  assert.ok(pixelVariance(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255])) > 1000);
});

test('offscreen render target returns populated canvas pixels, restores the city target and caches by id', () => {
  const { layer, m } = statueLayer();
  const renderer = new FakeRenderer(), created = [], oldSun = layer.group.children[0].material.uniforms.uSun.value.clone();
  const preview = makeMonumentPreview(THREE, { renderer, surfaceAt: () => 7, streets: {},
    createCanvas: () => { const c = fakeCanvas(); created.push(c); return c; }, ImageDataClass: FakeImageData });
  let sources = 0;
  const source = () => { sources++; return layer.previewMesh(m); };
  const first = preview.render(m, source);
  assert.equal(first.canvas.width, 512); assert.equal(first.canvas.height, 384);
  assert.equal(first.canvas.writes.length, 1);
  const image = first.canvas.writes[0];
  assert.equal(image.width, 512); assert.equal(image.height, 384);
  const i = 0; // WebGL bottom row (y=383) becomes canvas top row (y=0).
  assert.equal(image.data[i], 115); // (0 * 17 + 383 * 13) & 255
  assert.equal(image.data[i + 1], 99);
  assert.equal(image.data[i + 2], 121);
  assert.equal(image.data[i + 3], 255);
  assert.ok(first.variance > 100 && Number(first.canvas.dataset.pixelVariance) === first.variance);
  assert.ok(first.canvas.className.includes('monument-render-canvas'));
  assert.equal(renderer.target.name, 'city-target');
  assert.equal(renderer.readbacks, 1);
  assert.deepEqual(layer.group.children[0].material.uniforms.uSun.value, oldSun); // the map's sun is not overwritten
  const solo = renderer.calls[0].scene.children.find(o => o.isInstancedMesh);
  assert.equal(solo.count, 1);
  assert.ok(solo.material.uniforms.uSun.value.y > 0 && solo.material.uniforms.uSun.value.y < 0.6);
  close(renderer.calls[0].camera.position.distanceTo(renderer.calls[0].scene.userData.target), 15);

  const second = preview.render(m, source);
  assert.equal(second, first); assert.equal(second.canvas, first.canvas);
  assert.equal(sources, 1); assert.equal(renderer.calls.length, 1); assert.equal(created.length, 1);
});

test('card always has the labelled render panel; photo tabs are accessible and Commons is linked', () => {
  const m = { id: 'node/42', name: 'Spomen', kind: 'statue', h: 5, mat: 'bronze',
    commons: 'Category:Spomen u Zagrebu', qid: 'Q42', wp: { hr: 'Spomen' } };
  const withoutPhoto = monumentCard(m, { T, esc, link, lang: 'en', photoHtml: '' });
  assert.match(withoutPhoto, /class="monument-render"/);
  assert.match(withoutPhoto, /class="monument-render-mount"/);
  assert.doesNotMatch(withoutPhoto, /data-monument-panel="render"[^>]* hidden/);
  assert.doesNotMatch(withoutPhoto, /role="tablist"/);
  assert.match(withoutPhoto, /<figcaption>monument\.render<\/figcaption>/);
  assert.match(withoutPhoto, /Category%3ASpomen%20u%20Zagrebu/);

  const withPhoto = monumentCard(m, { T, esc, link, lang: 'en', photoHtml: '<figure class="photo">photo</figure>' });
  assert.match(withPhoto, /role="tablist"/);
  assert.match(withPhoto, /role="tab"[^>]*data-monument-tab="photo"[^>]*aria-selected="true"/);
  assert.match(withPhoto, /data-monument-panel="render"[^>]*hidden/);
  assert.match(withPhoto, /data-monument-panel="photo"/);
  assert.equal(nextMonumentMediaTab('ArrowRight', 'photo'), 'render');
  assert.equal(nextMonumentMediaTab('ArrowRight', 'render'), 'photo');
  assert.equal(nextMonumentMediaTab('Home', 'render'), 'photo');
  assert.equal(nextMonumentMediaTab('End', 'photo'), 'render');
  assert.equal(nextMonumentMediaTab('Enter', 'photo'), null);
  assert.equal(nextMonumentMediaTab('ArrowRight', 'render', false), 'render');
});

test('the UI labels are localized exactly and the pin path mounts actual renderer output', () => {
  const en = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
  const hr = JSON.parse(readFileSync(new URL('../i18n/hr.json', import.meta.url), 'utf8'));
  assert.equal(hr['monument.render'], 'Prikaz na karti');
  assert.ok(en['monument.render'] && en['monument.media'] && hr['monument.media']);
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /monuments\.renderCard\(m\)/);
  assert.match(app, /\.monument-render-mount/);
  assert.match(app, /\.replaceChildren\(/);
  assert.match(app, /nextMonumentMediaTab/);
  const roads = readFileSync(new URL('../roads-layer.js', import.meta.url), 'utf8');
  assert.match(roads, /nearestStreetDirection/);
  assert.match(roads, /pts\.slice\(\)/); // the worker transfer must not detach the later card lookup
});
