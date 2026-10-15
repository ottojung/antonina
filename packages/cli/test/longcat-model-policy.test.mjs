import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const model = 'opencode-go/longcat-2.5-preview-free';

test('canonical LongCat 2.5 Preview intent matches all executable model-selection surfaces', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  assert.match(intent, /^\$id-20261015-longcat-free-verified/);
  assert.match(intent, /LongCat 2.5 Preview Free is Antonina's sole authorized OpenCode model/);
  assert.match(intent, /no automatic paid or other fallback/i);
  assert.match(intent, /supersedes the prior Cat Jam Free sole-model intent/);
  assert.ok(intent.includes(model));
  const runtime = source('../../agent-runtime/src/backend.ts');
  assert.ok(runtime.includes("export const AGENT_MODEL = '" + model + "'"));
  const cli = source('../src/agent.ts');
  assert.ok(cli.includes("model: '" + model + "'"));
  assert.ok(cli.includes('configured OpenCode model ' + model + ' is unavailable'));
  const turn = source('../../../scripts/antonina-orchestrator-turn');
  assert.ok(turn.includes('--model ' + model));
  assert.match(turn, /FULL-FRONTIER DISPATCH/);
  assert.match(turn, /Return only when no more independent positive-speedup fronts remain/);
  const config = JSON.parse(source('../../../config/opencode-openclaw.json'));
  assert.equal(config.model, model);
  assert.equal(config.small_model, model);
  assert.deepEqual(config.provider['opencode-go'].whitelist, ['longcat-2.5-preview-free']);
  assert.match(turn, /--variant low/);
});


test('active model docs and scripts cannot retain the retired model identifiers', () => {
  const activePaths = [
    '../../../README.md',
    '../../../docs/openclaw-host-deployment.md',
    '../../../docs/skills/orchestrator.md',
    '../../../skills/antonina-orchestrator/SKILL.md',
    '../../../skills/antonina-scheduler/SKILL.md',
    '../../../scripts/antonina-orchestrator-turn',
    '../../../config/opencode-openclaw.json',
    '../../agent-runtime/src/backend.ts',
    '../src/agent.ts',
  ];
  for (const path of activePaths) {
    assert.doesNotMatch(source(path), /opencode-go\/(?:step-5-preview-free|cat-jam-free)/, path);
  }
});
