import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('scheduled turn is a LongCat OpenClaw scheduler pass with a compact snapshot', () => {
  assert.match(turn, /ANTONINA-SCHEDULER-TURN/);
  assert.match(turn, /timeout -k 15s 240s/);
  assert.match(turn, /--model opencode-go\/longcat-2\.5-preview-free/);
  assert.match(turn, /--variant low/);
  assert.doesNotMatch(turn, /--thinking/);
  assert.match(turn, /antonina-scheduler-snapshot/);
  assert.match(turn, /CURRENT_SNAPSHOT/);
  assert.match(turn, /positive expected marginal wall-clock speedup/);
  assert.match(turn, /Do not implement project work yourself/);
  assert.match(turn, /board show --id ISSUE --page 1 --json/);
  assert.match(turn, /agent run --id AGENT_ID --cwd CWD --prompt PROMPT --detach --json/);
  assert.match(turn, /Never call 'antonina board show ISSUE' positionally/);
});

test('launcher excludes runtime capacity from scheduling', () => {
  assert.match(turn, /Optimize ONLY for efficiency and topology/);
  assert.match(turn, /NEVER inspect, infer, request, discuss, or reason about runtime or host capacity/);
  assert.match(turn, /Runtime capacity is outside scheduling/);
  assert.match(turn, /Machine\/runtime capacity is NEVER a valid blocker/);
  assert.doesNotMatch(turn, /memory\.pressure|memory\.stat|memory\.events|reclaimable file cache|headroom/);
});

test('launcher uses topology snapshot before broad discovery', () => {
  assert.match(turn, /Do not rerun broad agent-list, board-list, board-feed/);
  assert.match(turn, /board resource list --issue ISSUE --page 1 --json/);
  assert.match(turn, /MUST NOT finish without either launching at least one missing-project owner or recording a precise dependency\/topology\/collision blocker/);
  assert.match(turn, /NEVER use ls\/find\/globs over \/workspace/);
  assert.match(turn, /only onto unoccupied cwd\/worktrees/);
});

test('launcher carries exact Antonina named-option grammar', () => {
  assert.match(turn, /board show --id ISSUE --page 1 --json/);
  assert.match(turn, /board resource list --issue ISSUE --page 1 --json/);
  assert.match(turn, /board comment --id ISSUE --body BODY --author openclaw@marceline-dev --json/);
  assert.match(turn, /agent new --id AGENT_ID --cwd CWD --title TITLE --json/);
  assert.match(turn, /agent run --id AGENT_ID --cwd CWD --prompt PROMPT --detach --json/);
  assert.match(turn, /never pass issue IDs positionally/);
});

test('launcher enforces dispatch before portfolio audit', () => {
  assert.match(turn, /FIRST-DISPATCH INVARIANT/);
  assert.match(turn, /launch an owner or bounded reconnaissance agent BEFORE reading another project's candidate/);
  assert.match(turn, /Do not batch-audit candidate issues or build a comprehensive blocker map before the first launch/);
});

test('launcher delegates stale project-queue archaeology', () => {
  assert.match(turn, /STALE-QUEUE DELEGATION/);
  assert.match(turn, /STOP auditing that project's backlog yourself/);
  assert.match(turn, /launch a bounded project-reconnaissance owner/);
});
