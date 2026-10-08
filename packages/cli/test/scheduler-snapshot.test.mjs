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

test('project hints are read-only topology context', () => {
  assert.match(snapshot, /project_hint_from_title/);
  assert.match(snapshot, /project_hint_from_cwd/);
  assert.match(snapshot, /project_hint/);
  assert.doesNotMatch(snapshot, /agent\", \"run|agent\", \"new|board\", \"comment/);
});


test('project hints prefer explicit titles and keep independent workstreams distinct', () => {
  assert.match(snapshot, /startswith\("pyreports"\).*return "pyreports"/);
  assert.match(snapshot, /return "Kawun"/);
  assert.match(snapshot, /return "Skrynia"/);
  assert.match(snapshot, /number == 206.*return "Antonina"/);
});


test('live agent issue number overrides misleading cwd topology', () => {
  assert.match(snapshot, /issue_number_from_agent_title/);
  assert.match(snapshot, /issue_project_by_number/);
  assert.match(snapshot, /issue_project_by_number\.get\(issue_number_from_agent_title/);
  const titlePos = snapshot.indexOf('project_hint_from_title(a.get("title"))');
  const issuePos = snapshot.indexOf('issue_project_by_number.get(issue_number_from_agent_title');
  const cwdPos = snapshot.indexOf('project_hint_from_cwd(a.get("cwd"))');
  assert.ok(titlePos >= 0 && issuePos > titlePos && cwdPos > issuePos);
});
