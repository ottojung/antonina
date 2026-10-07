import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const loop = read('../../../scripts/antonina-orchestrator-loop');
const turn = read('../../../scripts/antonina-orchestrator-turn');
const refill = read('../../../scripts/antonina-orchestrator-refill');

test('supervisor is non-blocking and runs deterministic breadth refill independently', () => {
  assert.match(loop, /antonina-orchestrator-turn.*&/s);
  assert.match(loop, /antonina-orchestrator-refill.*&/s);
  assert.match(loop, /REFILL_INTERVAL_SECONDS:-30/);
  assert.doesNotMatch(refill, /opencode-openclaw/);
  assert.match(refill, /def queue_plan/);
  assert.match(refill, /live_agent_ids/);
  assert.match(refill, /resources_for_issue/);
});

test('slow main orchestration cannot monopolize dispatch for fifteen minutes', () => {
  assert.match(turn, /timeout -k 15s 180s/);
  assert.match(turn, /ANTONINA-MAIN-TURN/);
  assert.match(turn, /Do not list \/workspace/);
});

test('deterministic refill launches only unrepresented projects from board state', () => {
  assert.match(refill, /if project in seen/);
  assert.match(refill, /seen = set\(represented\)/);
  assert.match(refill, /board", "list", "--state", "open/);
  assert.match(refill, /board", "resource", "list", "--issue"/);
  assert.match(refill, /project has no live OpenCode agent process/);
  assert.match(refill, /agent", "run"/);
});
