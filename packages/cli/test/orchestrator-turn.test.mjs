import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn is a compact LongCat OpenClaw scheduler pass', () => {
  assert.match(turn, /ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 15s 240s/);
  assert.match(turn, /--model opencode-go\/longcat-2\.5-preview-free/);
  assert.match(turn, /--variant low/);
  assert.doesNotMatch(turn, /--thinking/);
  assert.match(turn, /antonina-scheduler-snapshot/);
  assert.match(turn, /CURRENT_SNAPSHOT/);
  assert.ok(Buffer.byteLength(turn, 'utf8') < 3000);
});

test('first useful breadth dispatch is cheap and precedes depth', () => {
  assert.match(turn, /FIRST ACTION: project breadth/);
  assert.match(turn, /Use project_hint/);
  assert.match(turn, /CANDIDATE BUDGET/);
  assert.match(turn, /one board show \+ one resource lookup/);
  assert.match(turn, /never reread a skipped candidate/);
  assert.match(turn, /LAUNCH before another candidate/);
  assert.match(turn, /BREADTH BARRIER/);
  assert.match(turn, /no project gets a second live agent/);
  assert.match(turn, /every project_hint is represented/);
});

test('launcher carries exact Antonina grammar and topology gates', () => {
  assert.match(turn, /board show --id ISSUE --page 1 --json/);
  assert.match(turn, /board resource list --issue ISSUE --page 1 --json/);
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
  assert.match(turn, /test -d CWD/);
  assert.match(turn, /skip missing registered paths without probing them via agent creation/);
  assert.match(turn, /CURRENT_SNAPSHOT\.live_agents is authoritative/);
  assert.match(turn, /Never scan historical\/finished agent inventories/);
  assert.match(turn, /bounded reconciliation owner/);
});


test('each LongCat turn takes one scheduling action then refreshes topology', () => {
  assert.match(turn, /ONE ACTION PER TURN/);
  assert.match(turn, /after one successful agent launch/);
  assert.match(turn, /RETURN IMMEDIATELY/);
  assert.match(turn, /fresh LongCat turn with a fresh snapshot/);
  assert.match(turn, /Never continue auditing after that action/);
});
