import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { BODY_PARTS, SECTION_CENTRES, BELLOWS_CENTRES, makeVehicleParts, sideOffset, setVehicleNight } from '../tram-model.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

function parts() {
  const colours = ['#0e63b8', '#171a1e', '#c9cdd2', '#22262b', '#e8b33f'];
  const geoOf = colour => ({ geometry: new THREE.BoxGeometry(1, 1, 1), colour });
  const mats = Object.fromEntries(['bodyMat', 'winMat', 'roofMat', 'doorMat', 'wheelMat', 'faceMat', 'pantMat', 'signMat'].map(
    k => [k, new THREE.MeshBasicMaterial({ color: k === 'doorMat' ? '#c9cdd2' : k === 'wheelMat' ? '#22262b' : 0xffffff })]
  ));
  const make = (cap, geo, mat, name) => {
    const mesh = new THREE.InstancedMesh(geo.geometry, mat, cap);
    mesh.count = 0;
    mesh.name = name;
    return mesh;
  };
  return { p: makeVehicleParts({ make, geoOf, tag: 'tram', cap: 1, doorGeo: new THREE.BoxGeometry(1, 1, 1), wheelGeo: new THREE.CylinderGeometry(0.33, 0.33, 1.78, 8), ...mats }), mats };
}

test('the rendered vehicle parts allocate five sections and four real bellows meshes', () => {
  const { p } = parts();
  assert.equal(BODY_PARTS, 5);
  assert.deepEqual(BELLOWS_CENTRES, [-9.75, -3.25, 3.25, 9.75]);
  for (let i = 0; i < BELLOWS_CENTRES.length; i++) near(BELLOWS_CENTRES[i], (SECTION_CENTRES[i] + SECTION_CENTRES[i + 1]) / 2);
  assert.equal(p.body.count, 0);
  assert.equal(p.body.instanceMatrix.count, 5);
  assert.equal(p.bellows.instanceMatrix.count, 4);
  assert.ok(p.bellows.geometry.getAttribute('position').count > 0, 'a real connector mesh, not an empty label');
});

test('a side offset follows the same -heading Y rotation as the door mesh', () => {
  for (const heading of [0, Math.PI / 4, -Math.PI / 3]) {
    const actual = sideOffset(heading, 1.185);
    const expected = new THREE.Vector3(0, 0, 1.185).applyAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    near(actual.x, expected.x);
    near(actual.z, expected.z);
  }
});

test('switching night off preserves standalone material colours; both vehicles use the same tint', () => {
  const { p, mats } = parts();
  setVehicleNight(p, true);
  assert.ok(mats.doorMat.color.r > 0 && mats.doorMat.color.r < 0.7, 'night dims the configured door colour');
  assert.ok(mats.wheelMat.color.r > 0 && mats.wheelMat.color.r < 0.03, 'night does not erase wheel colour');
  setVehicleNight(p, false);
  near(mats.doorMat.color.r, new THREE.Color('#c9cdd2').r);
  near(mats.doorMat.color.b, new THREE.Color('#c9cdd2').b);
  near(mats.wheelMat.color.r, new THREE.Color('#22262b').r);
  assert.equal(mats.bodyMat.color.getHex(), 0xffffff);
});
