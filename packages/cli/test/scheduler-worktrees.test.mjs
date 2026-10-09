import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-scheduler-worktrees', import.meta.url)), 'utf8');

test('worktree helper filters canonical topology read-only', () => {
  assert.match(helper, /board", "resource", "list"/);
  assert.match(helper, /agent", "list"/);
  assert.match(helper, /"--running", "--json"/);
  assert.doesNotMatch(helper, /pgrep|live_ids|opencode run --auto --title/);
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

test('worktree helper uses reconciled running-agent inventory without inferring process names', () => {
  assert.match(helper, /def running_agents\(\):/);
  assert.match(helper, /running = running_agents\(\)/);
  assert.doesNotMatch(helper, /pgrep|live_ids|breadth_allows/);
});
