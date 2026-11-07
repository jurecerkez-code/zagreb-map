import assert from 'node:assert/strict';
import test from 'node:test';

import { tramsDataPath } from '../trams.js';

test('an independently versioned tram timetable keeps the city version untouched', () => {
  assert.equal(tramsDataPath({ version: 'city', trams_version: 'trams-fresh' }), 'data/trams-fresh/');
});
