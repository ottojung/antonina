import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn is a short OpenClaw scheduler pass with a compact snapshot', () => {
  assert.match(turn, /ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 10s 75s/);
  assert.match(turn, /--model opencode-go\/longcat-2\.5-preview-free/);
  assert.match(turn, /--variant low/);
  assert.doesNotMatch(turn, /--thinking/);
  assert.match(turn, /antonina-scheduler-snapshot/);
  assert.match(turn, /CURRENT_SNAPSHOT/);
  assert.match(turn, /project breadth/);
  assert.match(turn, /Do not implement project work yourself/);
});

test('launcher tells OpenClaw to use snapshot before broad discovery', () => {
  assert.match(turn, /Do not rerun broad agent-list, board-list, board-feed/);
  assert.match(turn, /Before any launch, re-check the chosen issue/);
  assert.match(turn, /only onto unoccupied cwd\/worktrees/);
});
