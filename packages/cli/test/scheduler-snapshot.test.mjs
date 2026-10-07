import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const snapshot = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-scheduler-snapshot', import.meta.url)), 'utf8');

test('scheduler snapshot is read-only context gathering, not a scheduler', () => {
  assert.match(snapshot, /agent", "list"/);
  assert.match(snapshot, /board", "list"/);
  assert.match(snapshot, /memory\.pressure/);
  assert.match(snapshot, /pgrep/);
  assert.doesNotMatch(snapshot, /agent", "run"|agent", "new"|board", "comment"|agent", "stop"|agent", "kill"/);
});
