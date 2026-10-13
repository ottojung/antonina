import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-scheduler-issue', import.meta.url)), 'utf8');

test('issue helper is a bounded read-only board view', () => {
  assert.match(helper, /board", "show"/);
  assert.match(helper, /--id/);
  assert.match(helper, /BODY_LIMIT = 10000/);
  assert.match(helper, /MESSAGE_LIMIT = 6000/);
  assert.match(helper, /SUBSTANTIVE_LIMIT = 12/);
  assert.match(helper, /MAX_PAGES = 12/);
  assert.match(helper, /for message in reversed\(messages\)/);
  assert.match(helper, /is_routine_launch/);
  assert.match(helper, /latest_handoff_claim/);
  assert.match(helper, /newest_messages/);
  assert.doesNotMatch(helper, /memory|pressure|oom|headroom|cgroup|loadavg|cpu/i);
});

test('issue helper is issue-scoped', () => {
  assert.match(helper, /--issue/);
  assert.match(helper, /usage: antonina-scheduler-issue --issue ISSUE/);
});
