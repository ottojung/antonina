import assert from 'node:assert/strict';
import test from 'node:test';
import { agePhrase, agentStatusTimestamp, displayTimestamp } from '../dist/packages/cli/src/time-display.js';

test('agent timestamps share the version clock formatting and age phrase', () => {
  const then = Date.parse('2026-10-25T12:00:00.000Z');
  const now = then + (24 + 5) * 3600 * 1000;
  const iso = new Date(then).toISOString();
  assert.equal(agePhrase(iso, now), '1 day and 5 hours ago');
  assert.equal(agentStatusTimestamp(then / 1000, now), displayTimestamp(iso) + ' (1 day and 5 hours ago)');
  assert.equal(agentStatusTimestamp(null, now), '-');
  assert.equal(agentStatusTimestamp(1e50, now), 'invalid timestamp');
});

test('version-style ages for recent and future instants are unchanged', () => {
  const then = Date.parse('2026-10-25T12:00:00.000Z');
  const iso = new Date(then).toISOString();
  assert.equal(agePhrase(iso, then), '0 seconds ago');
  assert.equal(agePhrase(iso, then - 1000), '0 seconds ago');
  assert.equal(agePhrase(iso, then + 61_000), '1 minute and 1 second ago');
});
