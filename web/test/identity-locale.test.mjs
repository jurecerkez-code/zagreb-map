import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const boot = readFileSync(new URL('../boot.js', import.meta.url), 'utf8');
const source = boot.slice(boot.indexOf('function croatian()'));
const croatian = (search, saved, languages, throws = false) => {
  const location = { search };
  const localStorage = { getItem() { if (throws) throw new Error('private mode'); return saved; } };
  const navigator = { languages, language: languages[0] };
  return new Function('location', 'localStorage', 'navigator', `${source}\nreturn croatian();`)(location, localStorage, navigator);
};

test('boot chooses Croatian only for explicit Croatian, storage or compatible locale', () => {
  const cases = [
    ['?lang=hr', 'en', ['de-DE'], true],
    ['?lang=en', 'hr', ['hr-HR'], false],
    ['', 'hr', ['en-GB'], true],
    ['', 'en', ['hr-HR'], false],
    ['', null, ['bs-BA'], true],
    ['', null, ['sr-Latn-RS'], true],
    ['', null, ['hr-HR'], true],
    ['', null, ['en-GB', 'hr-HR'], false],
    ['', null, ['sv-SE'], false],
    ['', null, ['de-DE'], false],
  ];
  for (const [search, saved, languages, expected] of cases) {
    assert.equal(croatian(search, saved, languages), expected, JSON.stringify({ search, saved, languages }));
  }
  assert.equal(croatian('', null, ['hr-HR'], true), true);
  assert.match(boot, /'Podaci o gradu nisu se mogli učitati\. Ponovno učitajte stranicu\.'/);
  assert.doesNotMatch(boot, /function swedish\(\)|Kunde inte ladda stadens data/);
});
