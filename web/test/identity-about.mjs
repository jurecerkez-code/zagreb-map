import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactLink } from '../about.js';

test('About accepts the project repository as contact without inventing a mailto link', () => {
  const href = 'https://github.com/jurecerkez-code/zagreb-map';
  assert.equal(contactLink(href),
      '<a href="https://github.com/jurecerkez-code/zagreb-map" target="_blank" rel="noopener">github.com/jurecerkez-code/zagreb-map</a>');
});

test('About preserves real email contacts and rejects unsafe contact values', () => {
  assert.equal(contactLink('info@example.com'),
      '<a href="mailto:info@example.com" target="_blank" rel="noopener">info@example.com</a>');
  assert.equal(contactLink(''), '');
  assert.equal(contactLink('javascript:alert(1)'), '');
});
