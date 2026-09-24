import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installGetRandomValues } from '../build/polyfills/install-get-random-values.js';

test('installs getRandomValues when crypto is missing', () => {
  const target = {};
  const implementation = (array) => array;
  installGetRandomValues(target, implementation);
  assert.equal(target.crypto.getRandomValues, implementation);
});
test('fills a crypto object that lacks getRandomValues', () => {
  const subtle = {};
  const target = { crypto: { subtle } };
  const implementation = (array) => array;
  installGetRandomValues(target, implementation);
  assert.equal(target.crypto.getRandomValues, implementation);
  assert.equal(target.crypto.subtle, subtle);
});
test('keeps an existing implementation', () => {
  const existing = (array) => array;
  const target = { crypto: { getRandomValues: existing } };
  installGetRandomValues(target, () => { throw new Error('should not be used'); });
  assert.equal(target.crypto.getRandomValues, existing);
});
test('the bundled bridge contains no dynamic imports or Node modules', () => {
  const dir = new URL('../build/polyfills/', import.meta.url);
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|\bimport\.meta\b|from\s*['"]node:/, file);
  }
});
