import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const snapshot = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-scheduler-snapshot', import.meta.url)), 'utf8');

test('scheduler snapshot is read-only topology context, not a scheduler', () => {
  assert.match(snapshot, /agent", "list"/);
  assert.match(snapshot, /board", "list"/);
  assert.match(snapshot, /pgrep/);
  assert.match(snapshot, /live_agents/);
  assert.match(snapshot, /open_issues/);
  assert.doesNotMatch(snapshot, /\/sys\/fs\/cgroup|memory\.|pressure|oom|cpu|loadavg|headroom/);
  assert.doesNotMatch(snapshot, /agent", "run"|agent", "new"|board", "comment"|agent", "stop"|agent", "kill"/);
});

test('snapshot paginates the open queue without classifying or scheduling it', () => {
  assert.match(snapshot, /for page in range\(1, 100\)/);
  assert.match(snapshot, /--state", "open"/);
  assert.doesNotMatch(snapshot, /project_from|queue_plan|launch_allowed|worker_count/);
});
