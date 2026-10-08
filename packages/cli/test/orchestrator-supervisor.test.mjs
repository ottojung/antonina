import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const loop = read('../../../scripts/antonina-orchestrator-loop');
const turn = read('../../../scripts/antonina-orchestrator-turn');
const scheduler = read('../../../docs/skills/scheduler.md');
const skill = read('../../../skills/antonina-scheduler/SKILL.md');
const service = read('../../../config/s6/antonina-orchestrator/run');
const restart = read('../../../scripts/antonina-orchestrator-restart');

test('scheduler is a single agentic OpenClaw scheduling lane owned by the supervisor', () => {
  assert.match(loop, /ANTONINA_SCHEDULER_INTERVAL_SECONDS/);
  assert.match(loop, /ANTONINA_SCHEDULER_INTERVAL_SECONDS:-2/);
  assert.doesNotMatch(loop, /orchestrator-refill/);
  assert.match(loop, /child_pid=/);
  assert.match(loop, /child_pid=\$!/);
  assert.match(loop, /kill -TERM "\$child_pid"/);
  assert.match(loop, /wait "\$child_pid"/);
  assert.match(loop, /trap on_exit TERM INT HUP/);
  assert.doesNotMatch(loop, /pgrep -f .*ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 15s 900s/);
  assert.match(turn, /--model opencode-go\/step-5-preview-free/);
  assert.match(turn, /--variant high/);
  assert.match(turn, /never fall back to any other model/);
  assert.doesNotMatch(turn, /--thinking/);
});

test('bounded scheduler turn returns instead of idle-watching', () => {
  assert.match(turn, /FINISH THE BOUNDED TURN/);
  assert.match(turn, /RETURN IMMEDIATELY/);
  assert.match(turn, /s6-supervised loop is responsible for invoking another fresh reconciliation pass/);
  assert.doesNotMatch(turn, /IDLE WATCH/);
  assert.doesNotMatch(turn, /sleep 20/);
  assert.doesNotMatch(turn, /retry until watchdog\/fatal error/);
});

test('scheduler service lifecycle keeps the supervisor wanted up', () => {
  assert.match(service, /exec "\$HOME\/\.local\/bin\/antonina-orchestrator-loop"/);
  assert.doesNotMatch(service, /ANTONINA_ORCHESTRATOR_INTERVAL_SECONDS/);
  assert.match(restart, /s6-svc -u "\$service"/);
  assert.match(restart, /s6-svc -r "\$service"/);
  assert.match(restart, /wantedup/);
});

test('scheduler optimizes only efficiency and topology', () => {
  assert.doesNotMatch(loop, /board list|board resource|agent run/);
  assert.match(scheduler, /Optimize only for \*\*efficiency and topology\*\*/);
  assert.match(scheduler, /positive expected marginal wall-clock speedup/);
  assert.match(scheduler, /A large number of live agents is never itself a reason to stop/);
  assert.doesNotMatch(scheduler, /memory\.pressure|memory\.stat|memory\.events|reclaimable file cache|oom_kill|PSI/);
});

test('scheduler expands breadth before costly depth because of topology', () => {
  const project = scheduler.indexOf('### 1. Project breadth');
  const issue = scheduler.indexOf('### 2. Issue breadth');
  const depth = scheduler.indexOf('### 3. Intra-issue parallelism');
  const stop = scheduler.indexOf('### 4. Marginal-speedup stop condition');
  assert.ok(project >= 0 && issue > project && depth > issue && stop > depth);
  assert.match(scheduler, /\*\*Breadth barrier:\*\*/);
  assert.match(scheduler, /before giving any project a second live agent/);
  assert.match(scheduler, /AssemblyP1 should ordinarily have at least five useful agents/);
  assert.match(scheduler, /### First-dispatch invariant/);
  assert.match(scheduler, /Do not batch-read several candidate issues/);
  assert.match(scheduler, /A good independent front launched now is better/);
  assert.match(scheduler, /### Stale-queue delegation/);
  assert.match(scheduler, /stop auditing more issues in that project yourself/);
  assert.match(scheduler, /project reconnaissance owner/);
  assert.match(scheduler, /## Registered-worktree fast path/);
  assert.match(scheduler, /reject that candidate immediately/);
  assert.match(scheduler, /launch immediately on one such worktree/);
  assert.match(scheduler, /test -d CWD/);
  assert.match(scheduler, /path-existence probe/);
  assert.match(scheduler, /authoritative for live ownership/);
  assert.match(scheduler, /Do not scan historical\/finished agent inventories/);
  assert.match(scheduler, /bounded reconciliation owner/);
  assert.match(scheduler, /CURRENT_SNAPSHOT\.live_agents/);
  assert.match(scheduler, /complete open-issue header list/);
  assert.match(scheduler, /Occupied cwd is a hard scheduling constraint/);
  assert.match(scheduler, /Never invoke .*antonina agent run.*cwd owned by another genuinely live worker/);
  assert.match(scheduler, /antonina-scheduler-issue --issue ISSUE/);
  assert.doesNotMatch(scheduler, /board show --id ISSUE --page 1 --json/);
  assert.match(scheduler, /Never pass issue IDs as positional arguments/);
});

test('installed scheduler skill stays in sync with canonical docs', () => {
  const frontmatter = [
    '---',
    'name: antonina-scheduler',
    'description: Keep the Antonina agent mycelium efficient, topologically parallel, collision-free, and saturated with positive-speedup work from the canonical board.',
    '---',
    '',
    '',
  ].join('\n');
  assert.equal(skill, frontmatter + scheduler);
});
