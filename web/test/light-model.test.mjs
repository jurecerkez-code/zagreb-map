import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { goldenModel } from '../../scripts/light-model.mjs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('the analytical neutral recipe matches the renderer\'s display stage', () => {
  const model = goldenModel(app);
  assert.equal(model.tone, 'NeutralToneMapping');
  assert.equal(model.exposure, 1);
  // The curve passes the mid-tones and only rolls off the highlights: a mid grey stays a mid grey (the vendored
  // neutral shader takes its 0.04 base offset, so 0.35 linear shows as #979797, not #9f9f9f).
  assert.equal(model.shown([0.35, 0.35, 0.35]), '#979797');
  assert.equal(model.shown([0.8, 0.8, 0.8]), '#e2e2e2');
  // Its toe sinks the darkest values instead of lifting them, which is what the strict picture gate measures.
  assert.equal(model.shown([0.02, 0.02, 0.02]), '#080808');
  assert.equal(model.shown([0, 0, 0]), '#000000');
});
