import test from 'node:test';
import assert from 'node:assert/strict';
import { yearIssueUrl } from '../crowd-year.js';

test('an undated card opens the real issue form with gid and address prefilled', () => {
  const href = yearIssueUrl(42, 'Ilica 25 & Savska 7');
  const url = new URL(href);
  assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/amirelion/husforhus/issues/new');
  assert.equal(url.searchParams.get('template'), 'year.yml');
  assert.equal(url.searchParams.get('gid'), '42');
  assert.equal(url.searchParams.get('address'), 'Ilica 25 & Savska 7');
  assert.equal(url.searchParams.get('labels'), 'contributions,needs-human');
  assert.equal(url.searchParams.get('year'), null);
  assert.equal(url.searchParams.get('source'), null);
  assert.equal(url.searchParams.get('evidence'), null);
  assert.equal(yearIssueUrl(0, ''), `https://github.com/amirelion/husforhus/issues/new?${new URLSearchParams({
    template: 'year.yml', title: '[year] gid 0', gid: '0', address: '', labels: 'contributions,needs-human' })}`);
  assert.equal(yearIssueUrl('not-a-gid', 'secret'), null);
  assert.equal(yearIssueUrl(-1, ''), null);
});
