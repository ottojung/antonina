import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn is a short OpenClaw scheduler pass with a compact snapshot', () => {
  assert.match(turn, /ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 10s 90s/);
  assert.match(turn, /--model opencode\/nemotron-3\.5-lightning-free/);
  assert.match(turn, /--variant low/);
  assert.doesNotMatch(turn, /--thinking/);
  assert.match(turn, /antonina-scheduler-snapshot/);
  assert.match(turn, /CURRENT_SNAPSHOT/);
  assert.match(turn, /project breadth/);
  assert.match(turn, /Do not implement project work yourself/);
});

test('launcher tells OpenClaw to use snapshot before broad discovery', () => {
  assert.match(turn, /Do not rerun broad agent-list, board-list, board-feed/);
  assert.match(turn, /board resource list --issue ISSUE --page 1 --json/);
  assert.match(turn, /MUST NOT finish without either launching at least one missing-project owner or recording a precise blocker/);
  assert.match(turn, /NEVER use ls\/find\/globs over \/workspace/);
  assert.match(turn, /only onto unoccupied cwd\/worktrees/);
});
