import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn is a compact LongCat OpenClaw scheduler pass', () => {
  assert.match(turn, /ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 15s 900s/);
  assert.match(turn, /--model opencode-go\/longcat-2\.5-preview-free/);
  assert.match(turn, /--variant low/);
  assert.doesNotMatch(turn, /--thinking/);
  assert.match(turn, /antonina-scheduler-snapshot/);
  assert.match(turn, /CURRENT_SNAPSHOT/);
  assert.ok(Buffer.byteLength(turn, 'utf8') < 3000);
});

test('first useful breadth dispatch is cheap and precedes depth', () => {
  assert.match(turn, /FIRST ACTION: breadth/);
  assert.match(turn, /unrepresented_projects/);
  assert.match(turn, /CANDIDATE BUDGET/);
  assert.match(turn, /one compact issue read/);
  assert.match(turn, /at most one worktree lookup/);
  assert.match(turn, /never reread a skipped candidate/);
  assert.match(turn, /skip immediately WITHOUT a worktree lookup/);
  assert.match(turn, /LAUNCH before another candidate/);
  assert.match(turn, /BREADTH BARRIER/);
  assert.match(turn, /no project gets a second live agent/);
  assert.match(turn, /every project_hint is represented/);
});

test('launcher carries exact Antonina grammar and topology gates', () => {
  assert.match(turn, /antonina-scheduler-issue --issue ISSUE/);
  assert.doesNotMatch(turn, /board show --id ISSUE/);
  assert.match(turn, /antonina-scheduler-worktrees --issue ISSUE/);
  assert.doesNotMatch(turn, /board resource list --issue ISSUE/);
  assert.match(turn, /board comment --id ISSUE --body BODY --author openclaw@marceline-dev --json/);
  assert.match(turn, /agent new --id AGENT_ID --cwd CWD --title TITLE --json/);
  assert.match(turn, /agent run --id AGENT_ID --cwd CWD --prompt PROMPT --detach --json/);
  assert.match(turn, /Never reuse a live cwd/);
  assert.match(turn, /Never use ls\/find\/globs over \/workspace/);
});

test('launcher optimizes only topology and marginal speedup', () => {
  assert.match(turn, /positive expected marginal wall-clock speedup/);
  assert.match(turn, /dependencies, overlap, collision risk, and reconciliation cost/);
  assert.match(turn, /AssemblyP1 should have at least five useful agents/);
  assert.doesNotMatch(turn, /memory|pressure|oom|headroom|cgroup|loadavg|runtime capacity|machine capacity|host capacity/i);
});


test('launcher rejects stale cwd paths and historical ownership archaeology', () => {
  assert.match(turn, /returned cwd is registered, existing, and unoccupied/);
  assert.match(turn, /antonina-scheduler-worktrees --issue ISSUE/);
  assert.doesNotMatch(turn, /test -d CWD/);
  assert.match(turn, /CURRENT_SNAPSHOT\.live_agents is authoritative/);
  assert.match(turn, /Never scan historical\/finished agent inventories/);
  assert.match(turn, /bounded reconciliation owner/);
});


test('LongCat batches actions but refreshes topology after each one', () => {
  assert.match(turn, /AFTER EACH ACTION/);
  assert.match(turn, /PRE-LAUNCH GATE/);
  assert.match(turn, /newly unrepresented/);
  assert.match(turn, /rerun antonina-scheduler-snapshot/);
  assert.match(turn, /treat it as CURRENT_SNAPSHOT/);
  assert.match(turn, /continue from project breadth/);
  assert.match(turn, /IDLE WATCH/);
  assert.match(turn, /sleep 20/);
  assert.match(turn, /Never return just because frontier is full/);
});

test('breadth gate forbids inspecting represented projects while gaps remain', () => {
  assert.match(turn, /inspect ONLY CURRENT_SNAPSHOT\.unrepresented_issues/);
  assert.match(turn, /skip represented-project issue reads/);
});
