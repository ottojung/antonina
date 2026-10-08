import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launch = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-scheduler-launch', import.meta.url)), 'utf8');

test('launch helper is execution plumbing, not a scheduler', () => {
  assert.match(launch, /antonina-scheduler-worktrees/);
  assert.match(launch, /chosen_cwd_is_available/);
  assert.doesNotMatch(launch, /unrepresented_projects|represented_issue_candidates|positive-speedup|breadth/i);
});

test('launch helper creates and runs before recording working claim', () => {
  const createPos = launch.indexOf('"agent", "new"');
  const runPos = launch.indexOf('"agent", "run"');
  const commentPos = launch.indexOf('"board", "comment"');
  assert.ok(createPos >= 0 && runPos > createPos && commentPos > runPos);
  assert.match(launch, /"--detach"/);
  assert.match(launch, /state: working/);
});

test('launch helper avoids phantom idle agents', () => {
  assert.match(launch, /secrets\.token_hex\(6\)/);
  assert.match(launch, /if started\.returncode != 0:/);
  assert.match(launch, /cleanup_idle\(agent_id\)/);
  assert.match(launch, /"agent", "delete", "--id", agent_id, "--force"/);
});

test('launch helper reports comment failure without killing a started worker', () => {
  assert.match(launch, /"comment_recorded": comment\.returncode == 0/);
  assert.match(launch, /worker started but board comment failed/);
});
