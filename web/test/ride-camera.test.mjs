import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../vendor/three.module.js';
import { advanceRideAim } from '../ride-camera.js';

const vec = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const close = (actual, expected, eps = 1e-6) => {
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(actual[axis] - expected[axis]) < eps, `${axis}: ${actual[axis]} != ${expected[axis]}`);
};

test('a slow frame cannot throw the ride camera away from its target', () => {
  let position = vec(), velocity = vec();
  const target = vec(90, 18, -35), route = [];
  for (let i = 0; i < 12; i++) {
    ({ position, velocity } = advanceRideAim({ position, velocity, target, dt: 0.5 }));
    route.push(position.clone());
    assert.ok([position.x, position.y, position.z].every(Number.isFinite));
    assert.ok([velocity.x, velocity.y, velocity.z].every(Number.isFinite));
    assert.ok(position.x >= 0 && position.x <= 90, `step ${i}: camera target diverged to ${position.x}`);
    if (i > 0) assert.ok(position.x >= route[i - 1].x, `step ${i}: camera bounced backwards`);
  }
});

test('the spring closes on the real look-ahead and damps its velocity', () => {
  let position = vec(), velocity = vec();
  const target = vec(90, 18, -35);
  for (let i = 0; i < 20; i++) ({ position, velocity } = advanceRideAim({ position, velocity, target, dt: 0.5 }));
  close(position, target, 0.001);
  assert.ok([velocity.x, velocity.y, velocity.z].every(value => Math.abs(value) < 0.001));
});

test('normal frames start moving without overshooting on the next frame', () => {
  const first = advanceRideAim({ position: vec(), velocity: vec(), target: vec(90, 18, -35), dt: 1 / 120 });
  assert.ok(first.position.x > 0);
  assert.ok(first.position.x < 90);
  assert.ok(first.velocity.x > 0);
  assert.ok(first.velocity.y > 0);
  assert.ok(first.velocity.z < 0);
});

test('a zero-time step leaves the current state intact', () => {
  const position = vec(42, 10, -4), velocity = vec(3, 0.2, -1);
  const next = advanceRideAim({ position, velocity, target: vec(90, 18, -35), dt: 0 });
  close(next.position, position);
  close(next.velocity, velocity);
});

test('the application rides with the bounded spring, not the divergent Euler step', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ advanceRideAim \} from '\.\/ride-camera\.js';/);
  assert.match(app, /advanceRideAim\(\{ position: ride\.aim, velocity: ride\.aimV, target: rideAim, dt \}\)/);
  assert.doesNotMatch(app, /2 \* k \* ride\.aimV/);
});
