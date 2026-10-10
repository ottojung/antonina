import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const loop = read('../../../scripts/antonina-orchestrator-loop');
const turn = read('../../../scripts/antonina-orchestrator-turn');
const scheduler = read('../../../skills/antonina-scheduler/SKILL.md');
const skill = read('../../../skills/antonina-scheduler/SKILL.md');
const launch = read('../../../scripts/antonina-scheduler-launch');
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
  assert.match(turn, /--model opencode-go\/longcat-2.5-preview-free/);
  assert.match(turn, /--variant low/);
  assert.match(turn, /never fall back to any other model/);
  assert.doesNotMatch(turn, /--thinking/);
});

test('bounded scheduler turn dispatches an entire useful frontier without idle-watching', () => {
  assert.match(turn, /FULL-FRONTIER DISPATCH/);
  assert.match(turn, /Do not return after one agent/);
  assert.match(turn, /Return only when no more independent positive-speedup fronts remain/);
  assert.doesNotMatch(turn, /RETURN IMMEDIATELY/);
  assert.doesNotMatch(turn, /IDLE WATCH/);
  assert.doesNotMatch(turn, /sleep 20/);
  assert.doesNotMatch(turn, /retry until watchdog\/fatal error/);
});

test('scheduler turn enforces distinct-front topology and replenishes the dispatch gap', () => {
  assert.match(turn, /DISTINCT-FRONT TOPOLOGY/);
  assert.match(turn, /never run two live agents on the same logical front/);
  assert.match(turn, /same worktree/);
  assert.match(turn, /De-duplicate by canonical worktree\/cwd path AND live-agent state/);
  assert.match(turn, /not by issue id or title alone/);
  assert.match(turn, /DISPATCH GAP/);
  assert.match(turn, /Count ACTUAL running sessions/);
  assert.match(turn, /dispatch promptly to replenish the pool/);
  assert.match(turn, /recent_terminal_agents/);
  assert.doesNotMatch(turn, /memory\.pressure|memory\.stat|memory\.events|reclaimable file cache|oom_kill|PSI/);
});

test('scheduler launcher closes the duplicate-worktree race after the run', () => {
  assert.match(launch, /concurrent live owner/);
  assert.match(launch, /stopped duplicate/);
  assert.match(launch, /agent", "stop", "--id", agent_id/);
  assert.doesNotMatch(launch, /antonina-scheduler-worktrees/);
  assert.doesNotMatch(launch, /antonina-scheduler-provision/);
});

test('scheduler service lifecycle keeps the supervisor wanted up', () => {
  assert.match(service, /exec "\$HOME\/\.local\/bin\/antonina-orchestrator-loop"/);
  assert.doesNotMatch(service, /ANTONINA_ORCHESTRATOR_INTERVAL_SECONDS/);
  assert.match(restart, /s6-svc -u "\$service"/);
  assert.match(restart, /s6-svc -r "\$service"/);
  assert.match(restart, /wantedup/);
});

test('scheduler is topology-only and never owns repositories or workspaces', () => {
  assert.doesNotMatch(loop, /board list|board resource|agent run/);
  assert.match(scheduler, /topology-only/);
  assert.match(scheduler, /positive marginal speedup/);
  assert.match(scheduler, /opencode-go\/longcat-2.5-preview-free/);
  assert.match(scheduler, /Do not substitute any other model/);
  assert.match(scheduler, /no global limit/);
  assert.doesNotMatch(scheduler, /memory\.pressure|memory\.stat|memory\.events|reclaimable file cache|oom_kill|PSI/);
});

test('scheduler uses human priority and dispatches full ready frontier', () => {
  assert.match(scheduler, /full priority-ordered open-issue list/);
  assert.match(scheduler, /CURRENT_SNAPSHOT/);
  assert.match(scheduler, /antonina-scheduler-issue --issue N/);
  assert.match(scheduler, /antonina-scheduler-launch --issue N/);
  assert.match(scheduler, /Delegate the WHOLE useful independent frontier/);
  assert.match(scheduler, /Continue dispatching in this same pass/);
  assert.match(scheduler, /Do not pass a cwd/);
  assert.match(scheduler, /agent owns repository\/filesystem setup/);
  assert.doesNotMatch(turn, /antonina-scheduler-provision/);
  assert.doesNotMatch(turn, /antonina-scheduler-worktrees/);
});

test('scheduler skill is canonical; no second scheduler.md document exists', () => {
  assert.equal(scheduler, skill);
  assert.match(skill, /^---\nname: antonina-scheduler\n/);
  assert.equal(existsSync(fileURLToPath(new URL('../../../docs/skills/scheduler.md', import.meta.url))), false);
  const doc = read('../../../docs/skills/orchestrator.md');
  const orchestratorSkill = read('../../../skills/antonina-orchestrator/SKILL.md');
  assert.ok(orchestratorSkill.endsWith(doc));
  assert.doesNotMatch(doc, /docs\/skills\/scheduler\.md/);
});
