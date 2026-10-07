import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const loop = read('../../../scripts/antonina-orchestrator-loop');
const turn = read('../../../scripts/antonina-orchestrator-turn');
const refill = read('../../../scripts/antonina-orchestrator-refill');

test('supervisor is non-blocking and runs an independent breadth refill lane', () => {
  assert.match(loop, /antonina-orchestrator-turn.*&/s);
  assert.match(loop, /antonina-orchestrator-refill.*&/s);
  assert.match(loop, /ANTONINA-MAIN-TURN/);
  assert.match(loop, /ANTONINA-FRONTIER-REFILL/);
  assert.match(loop, /REFILL_INTERVAL_SECONDS:-30/);
});

test('slow main orchestration cannot monopolize dispatch for fifteen minutes', () => {
  assert.match(turn, /timeout -k 15s 180s/);
  assert.match(turn, /ANTONINA-MAIN-TURN/);
  assert.match(turn, /Do not list \/workspace/);
});

test('refill lane is short, breadth-only, and excludes archaeology', () => {
  assert.match(refill, /timeout -k 10s 120s/);
  assert.match(refill, /ANTONINA-FRONTIER-REFILL/);
  assert.match(refill, /NEVER add depth to a represented project/);
  assert.match(refill, /at most one new front for each such project/);
  assert.match(refill, /Do not list \/workspace/);
  assert.match(refill, /inspect git history/);
});
