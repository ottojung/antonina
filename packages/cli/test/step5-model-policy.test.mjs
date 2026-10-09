import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const model = 'opencode-go/longcat-2.5-preview-free';

test('canonical Step 5 intent matches all executable model-selection surfaces', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  assert.match(intent, /Step 5 Preview Free is Antonina's sole permitted OpenCode model/);
  assert.match(intent, /Do not substitute other models/);
  assert.match(intent, /supersedes all earlier model-selection intent records/);
  assert.ok(intent.includes(model));
  const runtime = source('../../agent-runtime/src/backend.ts');
  assert.ok(runtime.includes("export const AGENT_MODEL = '" + model + "'"));
  const cli = source('../src/agent.ts');
  assert.ok(cli.includes("model: '" + model + "'"));
  assert.ok(cli.includes('configured OpenCode model ' + model + ' is unavailable'));
  const turn = source('../../../scripts/antonina-orchestrator-turn');
  assert.ok(turn.includes('--model ' + model));
  assert.match(turn, /FINISH THE BOUNDED TURN/);
  const config = JSON.parse(source('../../../config/opencode-openclaw.json'));
  assert.equal(config.model, model);
  assert.equal(config.small_model, model);
  assert.deepEqual(config.provider['opencode-go'].whitelist, ['longcat-2.5-preview-free']);
});
