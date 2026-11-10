#!/usr/bin/env node
// The picture gate: compares shots.json (scripts/shots.mjs) against the committed baseline and fails when a view
// lost contrast (stddev under 97% of the baseline; strict mode allows only 1% for SwiftShader run-to-run noise) or
// drifted in brightness (mean outside [0.95, 1.20]x baseline; strict 1.00x to 1.25x). A "brighter" fix that washes
// the picture out reads as a lower std-dev (125->151 mean with 75.8->56.2 std-dev slipped a manual check, 2026-11-04);
// this gate is what catches the next one.
import { readFileSync } from 'node:fs';

const [shotsPath, baselinePath] = process.argv.slice(2);
const shots = JSON.parse(readFileSync(shotsPath, 'utf8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const strict = process.argv.includes('--strict');   // #24 opts in: at most 1% contrast noise; mean 1.00x to 1.25x.
const rows = [];
let failed = false;
for (const [view, base] of Object.entries(baseline)) {
  const now = shots[view];
  if (!now) { console.error(`missing view in shots: ${view}`); failed = true; continue; }
  const stddevOk = now.stddev >= base.stddev * (strict ? 0.99 : 0.97);
  const meanOk = now.mean >= base.mean * (strict ? 1 : 0.95) && now.mean <= base.mean * (strict ? 1.25 : 1.20);
  failed = failed || !stddevOk || !meanOk;
  rows.push({
    view,
    'mean (base)': base.mean, 'mean (now)': now.mean, mean: meanOk ? 'ok' : 'FAIL',
    'stddev (base)': base.stddev, 'stddev (now)': now.stddev, contrast: stddevOk ? 'ok' : 'FAIL',
  });
}
console.table(rows);
if (failed) { console.error('picture gate FAILED'); process.exit(1); }
console.log('picture gate OK');
