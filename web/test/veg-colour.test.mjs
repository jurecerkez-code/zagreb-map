import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { VEG_COLOURS, srgbLut } from '../veg.js';

test('the green-cover LUT stores authored sRGB bytes, not linear floats', () => {
  const lut = srgbLut(THREE, ['grass', 'meadow'], VEG_COLOURS.arg);
  assert.deepEqual([...lut.slice(3, 9)], [147, 176, 107, 160, 187, 118]);
});
