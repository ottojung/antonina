import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-scheduler-worktrees', import.meta.url)), 'utf8');

test('worktree helper filters canonical topology read-only', () => {
  assert.match(helper, /board", "resource", "list"/);
  assert.match(helper, /agent", "list"/);
  assert.match(helper, /pgrep/);
  assert.match(helper, /os\.path\.isdir/);
  assert.match(helper, /os\.path\.realpath/);
  assert.match(helper, /occupied/);
  assert.doesNotMatch(helper, /memory|pressure|oom|headroom|cgroup|loadavg|cpu/i);
});

test('worktree helper is issue-scoped and paginated', () => {
  assert.match(helper, /--issue/);
  assert.match(helper, /for page in range\(1, 100\)/);
  assert.match(helper, /for item in resources\(issue\)/);
});

 test('worktree helper caps returned topology choices', () => {
  assert.match(helper, /MAX_RESULTS = 8/);
  assert.match(helper, /len\(available\) >= MAX_RESULTS/);
});

test('breadth barrier is enforced mechanically before returning worktrees', () => {
  assert.match(helper, /antonina-scheduler-snapshot/);
  assert.match(helper, /def breadth_allows\(issue\)/);
  assert.match(helper, /unrepresented_projects/);
  assert.match(helper, /unrepresented_issues/);
  assert.match(helper, /if not breadth_allows\(issue\):/);
  assert.match(helper, /print\("\[\]"\)/);
});
