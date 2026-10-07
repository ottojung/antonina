import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const loop = read('../../../scripts/antonina-orchestrator-loop');
const turn = read('../../../scripts/antonina-orchestrator-turn');
const scheduler = read('../../../docs/skills/scheduler.md');
const skill = read('../../../skills/antonina-scheduler/SKILL.md');

test('scheduler is a single short OpenClaw scheduling lane', () => {
  assert.match(loop, /ANTONINA-SCHEDULER-TURN/);
  assert.doesNotMatch(loop, /orchestrator-refill/);
  assert.match(turn, /timeout -k 10s 75s/);
  assert.match(turn, /--variant low/);
  assert.doesNotMatch(turn, /--thinking/);
  assert.match(turn, /antonina-scheduler\/SKILL\.md/);
});

test('scheduler remains agentic rather than deterministic dispatch code', () => {
  assert.doesNotMatch(loop, /board list|board resource|agent run/);
  assert.doesNotMatch(turn, /python3|board list|board resource|agent run/);
  assert.match(scheduler, /There is no global worker-count cap/);
  assert.match(scheduler, /memory\.pressure/);
  assert.match(scheduler, /reclaimable file cache/);
  assert.match(scheduler, /fresh .*oom.*oom_kill.* increment/);
  assert.match(scheduler, /launch a bounded reconnaissance agent/);
});

test('scheduler requires project breadth before issue depth', () => {
  const project = scheduler.indexOf('### 1. Project breadth');
  const issue = scheduler.indexOf('### 2. Issue breadth');
  const depth = scheduler.indexOf('### 3. Intra-issue depth and project floors');
  assert.ok(project >= 0 && issue > project && depth > issue);
  assert.match(scheduler, /AssemblyP1 should maintain at least five useful agents/);
  assert.match(scheduler, /CURRENT_SNAPSHOT\.live_agents/);
  assert.match(scheduler, /complete open-issue header list/);
  assert.match(scheduler, /general board feed as an initial scheduling scan/);
  assert.match(scheduler, /Occupied cwd is a hard scheduling constraint/);
  assert.match(scheduler, /Never invoke .*antonina agent run.*cwd that is already/);
  assert.match(scheduler, /resolve the collision before launching anything else/i);
});

test('installed scheduler skill stays in sync with canonical docs', () => {
  const frontmatter = [
    '---',
    'name: antonina-scheduler',
    'description: Keep the Antonina agent mycelium broad, saturated, collision-free, and resource-aware by scheduling work from the canonical board.',
    '---',
    '',
    '',
  ].join('\n');
  assert.equal(skill, frontmatter + scheduler);
});
