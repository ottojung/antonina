import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const model = 'opencode-go/longcat-2.5-preview-free';

test('canonical LongCat intent matches all executable model-selection surfaces', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  assert.match(intent, /^\$id-20261009-longcat-restoration/m);
  assert.match(intent, /replacement of Step 5 Preview Free with `opencode-go\/longcat-2.5-preview-free`/);
  assert.match(intent, /--variant low/);
  assert.match(intent, /supersedes the 2026\/10\/08 Step 5-only constraint/);
  assert.match(intent, /No fallback models/);
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
});
