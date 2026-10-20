// Board issue 320: the shared entity-id generator.
//
// The generator is two independently drawn parts -- a 22-character random
// suffix over the id alphabet, and one curated readable word -- joined by a
// hyphen. These tests pin the shape, the independence of successive draws, the
// alphabet actually drawn from, and the structural validator. They deliberately
// do not assert a specific id: the whole point is that an id is unpredictable.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isEntityId, newEntityId } from '../dist/ids.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SHAPE = /^([0-9A-Za-z]{22})-([a-z]+)$/;

test('an id is a 22-character random suffix, a hyphen, and a readable word', () => {
  const match = SHAPE.exec(newEntityId());
  assert.ok(match, 'a generated id must match the entity-id shape');
  assert.equal(match[1].length, 22, 'the random suffix is exactly 22 characters');
  assert.ok(match[2].length >= 3, 'the word is a real word, not an empty suffix');
  assert.equal(isEntityId(match[0]), true);
});

test('the suffix is always present, so an id is never a word alone', () => {
  for (let index = 0; index < 200; index += 1) {
    const match = SHAPE.exec(newEntityId());
    assert.ok(match, 'every id carries a random suffix');
    assert.equal(match[1].length, 22);
    assert.notEqual(match[1], '', 'the random part is not empty');
  }
});

test('successive ids are independent: many draws are all distinct', () => {
  const seen = new Set();
  const draws = 5_000;
  for (let index = 0; index < draws; index += 1) seen.add(newEntityId());
  assert.equal(seen.size, draws, 'no two of many draws may collide');
});

test('the suffix draws from the whole id alphabet without gross bias', () => {
  const counts = new Map();
  const draws = 3_000;
  for (let index = 0; index < draws; index += 1) {
    const suffix = SHAPE.exec(newEntityId())[1];
    for (const character of suffix) counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  const expected = (draws * 22) / ALPHABET.length;
  for (const character of ALPHABET) {
    const count = counts.get(character) ?? 0;
    assert.ok(
      count > expected * 0.5 && count < expected * 1.5,
      `symbol ${JSON.stringify(character)} appeared ${count} times, expected about ${expected}`,
    );
  }
});

test('isEntityId accepts the generated shape and nothing else', () => {
  for (let index = 0; index < 50; index += 1) assert.equal(isEntityId(newEntityId()), true);
  for (const value of [
    '',
    'a1b2',
    'ABCD1234',
    'not-an-id',
    'a'.repeat(22), // no word
    'a'.repeat(21) + '-word', // suffix one character short
    'a'.repeat(23) + '-word', // suffix one character long
    'a'.repeat(22) + '-Word', // the word is lowercase
    'a'.repeat(22) + '-word!',
    null,
    undefined,
    123,
    true,
    {},
    [],
  ]) {
    assert.equal(isEntityId(value), false, `${JSON.stringify(value)} must not be an entity id`);
  }
});

test('the legacy hex id space is a different shape and is not produced here', () => {
  // A legacy managed-agent id is lowercase hex and contains no hyphen; the
  // entity-id shape always contains the joining hyphen. The two spaces cannot
  // be confused, which is what lets the runtime accept both.
  for (let index = 0; index < 50; index += 1) {
    const id = newEntityId();
    assert.equal(/^[0-9a-f]+$/.test(id), false, `${id} must not look like a legacy hex id`);
  }
});

test('large word vocabulary is reachable and selection terminates', () => {
  const observed = new Set();
  for (let i = 0; i < 30000; i += 1) {
    const word = SHAPE.exec(newEntityId())?.[2];
    assert.ok(word);
    observed.add(word);
  }
  assert.ok(observed.size > 9000, 'the generator must draw from the expanded wordlist');
});
