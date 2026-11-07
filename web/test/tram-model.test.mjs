import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { BODY_PARTS, SECTION_LENGTH, BELLOWS_WIDTH, SECTION_CENTRES, vehicleDimensions, makeDoorFrame } from '../tram-model.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('five sections with four bellows retain the measured 32 m body, not three blocks', () => {
  assert.equal(BODY_PARTS, 5);
  assert.deepEqual(SECTION_CENTRES, [-13, -6.5, 0, 6.5, 13]);
  near(BODY_PARTS * SECTION_LENGTH + (BODY_PARTS - 1) * BELLOWS_WIDTH, 32);
  near(SECTION_CENTRES[0] - SECTION_LENGTH / 2, -16);
  near(SECTION_CENTRES.at(-1) + SECTION_LENGTH / 2, 16);
});

test('the live trams.json field names feed the real vehicle dimensions', () => {
  const live = JSON.parse('{"length_m":32,"width_m":2.3,"height_m":3.4}');
  assert.deepEqual(vehicleDimensions(live), { length: 32, width: 2.3, height: 3.4 });
  assert.deepEqual(vehicleDimensions({}), { length: 32, width: 2.3, height: 3.4 });
});

test('door frames are true open outlines, not opaque panels hiding the windows', () => {
  const { geometry, width, height } = makeDoorFrame(THREE);
  assert.equal(width, 1.3);
  assert.equal(height, 1.9);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const centreRay = new THREE.Raycaster(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  assert.equal(centreRay.intersectObject(mesh).length, 0, 'the glass must remain unobstructed');
  const leftFrame = new THREE.Raycaster(new THREE.Vector3(-width / 2 + 0.03, 0, 1), new THREE.Vector3(0, 0, -1));
  assert.ok(leftFrame.intersectObject(mesh).length > 0, 'the door border itself must exist');
});
