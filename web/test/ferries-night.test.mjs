import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { makeFerries } from '../ferries-layer.js';

test('ferry hull and wake share the scene Night and dim exactly once before display fog', () => {
  const uNight = { value: 1 };
  const uniforms = {
    uNight, uFog: { value: new THREE.Vector2(10, 1000) }, uFogColor: { value: new THREE.Color('#ffffff') },
    uFogDisplay: { value: new THREE.Color('#ffffff') }, uSun: { value: new THREE.Vector3(0, 1, 0) },
    uFade: { value: new THREE.Vector2(1000, 1500) },
    uSunCol: { value: new THREE.Color('#ffdcae') }, uSkyCol: { value: new THREE.Color('#b3c7dd') },
    uGridO: { value: new THREE.Vector2() }, uGridN: { value: new THREE.Vector2(1, 1) }, uCell: { value: 1 },
  };
  const ferries = makeFerries(THREE, { routes: [], uniforms, fadeGlsl: '', look: () => 'arg',
    calm: { matches: false }, camera: new THREE.PerspectiveCamera() });
  const dim = 'vec3(0.30, 0.36, 0.56)';
  for (const name of ['boats', 'wakes']) {
    const shader = ferries.group.getObjectByName(name).material.fragmentShader;
    assert.equal(ferries.group.getObjectByName(name).material.uniforms.uNight, uNight, `${name}: shared Night uniform`);
    assert.equal([...shader.matchAll(/vec3\(0\.30, 0\.36, 0\.56\)/g)].length, 1, `${name}: one Night dim`);
    const tone = shader.indexOf('#include <colorspace_fragment>');
    const night = shader.indexOf(dim);
    const fog = shader.indexOf('outColor.rgb = displayFog');
    assert.ok(tone >= 0 && tone < night && night < fog, `${name}: tone, then one Night dim, then fog`);
  }
});
