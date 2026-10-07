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

test('deterministic refill enforces project breadth before issue breadth', () => {
  assert.match(refill, /if project_plan:\n        return represented, project_plan/);
  assert.match(refill, /phase": "project"/);
  assert.match(refill, /phase": "issue"/);
  assert.match(refill, /wave_projects/);
  assert.match(refill, /cwd in live_cwds/);
});

test('deterministic breadth identity comes from agent title before cwd heuristics', () => {
  assert.match(refill, /BREADTH_TITLE/);
  assert.match(refill, /def project_from_agent/);
  assert.match(refill, /if BREADTH_TITLE\.match/);
  assert.match(refill, /cleanup_duplicate_breadth/);
});

test('issue breadth uses cgroup backpressure rather than a worker-count cap', () => {
  assert.match(refill, /ISSUE_HEADROOM_FRACTION = 0\.15/);
  assert.match(refill, /ISSUE_HEADROOM_MIN_BYTES/);
  assert.match(refill, /def launch_allowed/);
  assert.match(refill, /candidate\["phase"\]/);
  assert.doesNotMatch(refill, /MAX_WORKERS|worker_count_limit/);
});
