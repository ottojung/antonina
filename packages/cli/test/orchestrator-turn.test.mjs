import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn is a short OpenClaw scheduler pass', () => {
  assert.match(turn, /ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 10s 75s/);
  assert.match(turn, /--variant low/);
  assert.doesNotMatch(turn, /--thinking/);
  assert.match(turn, /antonina-scheduler\/SKILL\.md/);
  assert.match(turn, /project breadth, then issue breadth/);
  assert.match(turn, /Do not implement project work yourself/);
});

test('scheduler launcher makes live cwd reconciliation precede policy loading', () => {
  const first = turn.indexOf('FIRST ACTION');
  const skill = turn.indexOf('read and obey $HOME/.openclaw/skills/antonina-scheduler/SKILL.md');
  assert.ok(first >= 0 && skill > first);
  assert.match(turn, /before reading any skill, docs, board history/);
  assert.match(turn, /immediately inspect current running Antonina agents/);
  assert.match(turn, /build the occupied cwd set/);
  assert.match(turn, /Do not launch while a same-cwd collision remains/);
});
