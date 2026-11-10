import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.core.js';
import { makeMonuments, monumentVariant, makeFigureGeometry, FIGURE_VARIANTS, nearestStreetDirection, monumentFront, FIGURE_AT } from '../monuments.js';

const fixture = (kind, i, extra = {}) => ({ id: `node/${kind}-${i}`, name: extra.name || `Fixture ${kind} ${i}`, kind,
  x: i * 10, z: -i * 3, h: 4.2, material: 'bronze', ...extra });
const close = (got, want, tolerance = 0.0001) => assert.ok(Math.abs(got - want) <= tolerance, `${got} != ${want}`);

function layerOptions(records) {
  const uniforms = { uYear: { value: 2026 }, uSun: {}, uFog: {}, uFogColor: {} };
  return { list: records, uniforms, surfaceAt: () => 12, camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, look: () => 'arg', yearMax: 2026 };
}

test('there are four meaningful forms per human figure kind, selected from name and depiction evidence', () => {
  assert.deepEqual(FIGURE_VARIANTS, {
    statue: ['standing', 'seated', 'raised_arm', 'group'],
    bust: ['short_hair', 'beard', 'bob', 'updo'],
  });
  assert.equal(monumentVariant({ kind: 'statue', name: 'Nikola Tesla' }), 'standing');
  assert.equal(monumentVariant({ kind: 'statue', name: 'Josip Juraj Strossmayer 1815-1905' }), 'standing');
  assert.equal(monumentVariant({ kind: 'statue', name: 'A seated writer', depicts: { pose: 'seated' } }), 'seated');
  assert.equal(monumentVariant({ kind: 'statue', name: 'Sveti Juraj ubija zmaja' }), 'raised_arm');
  assert.equal(monumentVariant({ kind: 'statue', name: 'Dva studenta', depicts: [{ label: 'woman' }, { label: 'man' }] }), 'group');
  assert.equal(monumentVariant({ kind: 'bust', name: 'August Šenoa', depicts: { gender: 'male' } }), 'short_hair');
  assert.equal(monumentVariant({ kind: 'bust', name: 'Kralj Tomislav', depicts: { beard: true } }), 'beard');
  assert.equal(monumentVariant({ kind: 'bust', name: 'Marija Jurić Zagorka', depicts: { gender: 'female' } }), 'bob');
  assert.equal(monumentVariant({ kind: 'bust', name: 'Djevica Marija', depicts: { gender: 'female', hair: 'updo' } }), 'updo');
  assert.equal(monumentVariant({ kind: 'obelisk', name: 'Sveti Juraj ubija zmaja' }), '');
});

test('every figure geometry is distinct, starts on its plinth, has a canonical height and stays economical', () => {
  const seen = new Set();
  const nominal = { statue: 7, bust: 3 };
  let most = 0;
  for (const [kind, variants] of Object.entries(FIGURE_VARIANTS)) {
    for (const variant of variants) {
      const geometry = makeFigureGeometry(THREE, kind, variant);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      close(box.min.y, 0, 0.00001);
      close(box.max.y, nominal[kind]);
      assert.ok(box.max.x - box.min.x > 0 && box.max.z - box.min.z > 0);
      const triangles = geometry.index.count / 3;
      most = Math.max(most, triangles);
      assert.ok(triangles > 40 && triangles < 20_000, `${kind}/${variant}: ${triangles}`);
      const key = `${geometry.attributes.position.array.length}:${geometry.index.count}:${box.max.x.toFixed(3)}:${box.max.z.toFixed(3)}`;
      assert.ok(!seen.has(`${kind}:${key}`), `${kind}/${variant} duplicates another form`);
      seen.add(`${kind}:${key}`);
    }
  }
  // Even the largest variant on every one of the issue's 212 human figures fits the whole-layer budget.
  assert.ok(most * 212 < 150_000);
});

test('instancing is bucketed by variant and each transformed top is exactly its measured h', () => {
  const records = [
    fixture('statue', 0), fixture('statue', 1, { name: 'Sitting writer', depicts: { pose: 'seated' } }),
    fixture('statue', 2, { name: 'Sveti Juraj ubija zmaja' }),
    fixture('statue', 3, { depicts: [{ label: 'woman' }, { label: 'man' }] }),
    fixture('bust', 4, { depicts: { gender: 'male' } }),
    fixture('bust', 5, { depicts: { beard: true } }),
    fixture('bust', 6, { depicts: { gender: 'female' } }),
    fixture('bust', 7, { depicts: { gender: 'female', hair: 'updo' } }),
  ];
  const layer = makeMonuments(THREE, layerOptions(records));
  layer.place();
  const meshes = layer.group.children.filter(m => m.isInstancedMesh);
  assert.equal(meshes.length, 8);
  let triangles = 0;
  const matrix = new THREE.Matrix4();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const point = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      point.set(0, mesh.geometry.boundingBox.max.y, 0);
      mesh.getMatrixAt(i, matrix);
      point.applyMatrix4(matrix);
      close(point.y, 12 + records[mesh.userData.idx[i]].h);
    }
    triangles += mesh.count * (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3;
  }
  assert.ok(triangles < 150_000);
});

test('a city-model plinth is kept under the correctly scaled new figure', () => {
  const record = fixture('statue', 0, { plinth: 6 });
  const layer = makeMonuments(THREE, layerOptions([record]));
  layer.place();
  const mesh = layer.group.children[0], matrix = new THREE.Matrix4();
  const lift = record.plinth - FIGURE_AT.statue * record.h / 7;
  mesh.getMatrixAt(0, matrix);
  close(matrix.elements[13], 12 + lift);
  mesh.geometry.computeBoundingBox();
  close(new THREE.Vector3(0, mesh.geometry.boundingBox.max.y, 0).applyMatrix4(matrix).y, 12 + lift + record.h);
});

test('front view uses direction first, otherwise aims toward the nearest street', () => {
  const ways = [{ o: 0, c: 2 }, { o: 2, c: 2 }];
  const pts = new Float32Array([-10, -5, 10, -5, 20, 0, 20, 10]);
  const street = nearestStreetDirection(0, 0, ways, pts);
  close(street.vector[0], 0); close(street.vector[1], -1); close(street.distance, 5);
  assert.equal(street.source, 'street');
  assert.deepEqual(monumentFront({ x: 0, z: 0, dir: 180 }, { ways, points: pts }), { vector: [0, 1], source: 'direction' });
  assert.deepEqual(monumentFront({ x: 0, z: 0 }, { ways, points: pts }), { vector: [0, -1], source: 'street' });
  assert.deepEqual(monumentFront({ x: 0, z: 0 }, { ways: [], points: new Float32Array() }), { vector: [0, -1], source: 'default' });
});
