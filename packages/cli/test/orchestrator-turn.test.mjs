import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn is a short OpenClaw scheduler pass', () => {
  assert.match(turn, /ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 10s 120s/);
  assert.match(turn, /--variant low --thinking/);
  assert.match(turn, /antonina-scheduler\/SKILL\.md/);
  assert.match(turn, /project breadth, then issue breadth/);
  assert.match(turn, /Do not implement project work yourself/);
});
