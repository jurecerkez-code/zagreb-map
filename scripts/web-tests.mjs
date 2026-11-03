#!/usr/bin/env node
// The web unit tests, minus the ones this Zagreb port has not ported yet (web/test/legacy_upstream.json).
//
// Node's test runner takes one skip pattern, so this reads the list, escapes it into a single anchored alternation and
// hands it over. Skipped tests are still counted and printed: a fork that quietly forgets them would look the same as
// one that ported them. Porting a test means deleting its name from the list.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const list = new URL('../web/test/legacy_upstream.json', import.meta.url);
let legacy = [];
try {
  legacy = JSON.parse(readFileSync(list, 'utf8')).tests ?? [];
} catch (e) {
  console.error(`web-tests: cannot read ${list.pathname}: ${e.message}`);
  process.exit(2);
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Not anchored: node reports a test inside a describe() as "describe > test", so the name to match is a
// substring of what the runner prints, never the whole of it.
const pattern = legacy.length ? `(?:${legacy.map(escape).join('|')})` : '';
// The flags come before the glob and in two arguments: after a positional, and in the `--flag=value` form, node reads
// the pattern as a file name and skips nothing.
const args = ['--test'];
if (pattern) args.push('--test-skip-pattern', pattern);
args.push('web/test/*.test.mjs');

if (legacy.length) {
  console.log(`web-tests: ${legacy.length} test(s) still written for Stockholm, skipped (web/test/legacy_upstream.json)`);
}
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
