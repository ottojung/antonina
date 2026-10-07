import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn enforces cross-project breadth before depth', () => {
  assert.match(turn, /MANDATORY SCHEDULING ORDER: project breadth before issue breadth before intra-issue depth/);
  assert.match(turn, /any useful live agent is already represented/);
  assert.match(turn, /DO NOT launch another new front in any represented project/);
  assert.match(turn, /at most one new front per project/);
  assert.match(turn, /worker floors are constraints, not monopolization licenses/);
});
