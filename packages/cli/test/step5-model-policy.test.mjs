import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const model = 'opencode-go/step-5-preview-free';
const variant = 'high';

const FORBIDDEN_MODELS = [
  'opencode-go/longcat-2.5-preview-free',
  'opencode/space-bunny-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/gpt-5.6-sol',
  'opencode/claude-opus-5',
  'opencode/big-pickle',
];

test('canonical Step 5 intent is the authoritative record', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  assert.match(intent, /^\$id-20261008-step5only/m);
  assert.match(intent, /Step 5 Preview Free is Antonina's sole permitted OpenCode model/);
  assert.match(intent, /Do not substitute other models/);
  assert.match(intent, /supersedes all earlier model-selection intent records/);
  assert.ok(intent.includes(model));
});

test('canonical Step 5 intent matches all executable model-selection surfaces', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  const runtime = source('../../agent-runtime/src/backend.ts');
  assert.ok(runtime.includes("export const AGENT_MODEL = '" + model + "'"));
  const metadata = source('../../agent-runtime/src/metadata.ts');
  assert.ok(metadata.includes("export const DEFAULT_VARIANT = '" + variant + "'"));
  const cli = source('../src/agent.ts');
  assert.ok(cli.includes("model: '" + model + "'"));
  assert.ok(cli.includes('configured OpenCode model ' + model + ' is unavailable'));
  const turn = source('../../../scripts/antonina-orchestrator-turn');
  assert.ok(turn.includes('--model ' + model));
  assert.match(turn, new RegExp('--variant ' + variant));
  assert.match(turn, /never fall back to any other model/);
  const config = JSON.parse(source('../../../config/opencode-openclaw.json'));
  assert.equal(config.model, model);
  assert.equal(config.small_model, model);
  assert.deepEqual(config.provider['opencode-go'].whitelist, ['step-5-preview-free']);
});

test('non-Step 5 models are refused on the release line', () => {
  const runtime = source('../../agent-runtime/src/backend.ts');
  const metadata = source('../../agent-runtime/src/metadata.ts');
  const cli = source('../src/agent.ts');
  const config = JSON.parse(source('../../../config/opencode-openclaw.json'));
  const turn = source('../../../scripts/antonina-orchestrator-turn');
  const schedulerSkill = source('../../../skills/antonina-scheduler/SKILL.md');
  const orchestratorSkill = source('../../../skills/antonina-orchestrator/SKILL.md');
  const surfaces = { runtime, metadata, cli, turn, schedulerSkill, orchestratorSkill };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const forbidden of FORBIDDEN_MODELS) {
      assert.ok(!text.includes(forbidden), `${name} must not select ${forbidden}`);
    }
  }
  const deploymentDoc = source('../../../docs/openclaw-host-deployment.md');
  assert.match(deploymentDoc, /sole permitted model for OpenClaw scheduling and managed Antonina agents is Step 5 Preview Free, `opencode-go\/step-5-preview-free`, with variant `high`/);
  assert.doesNotMatch(deploymentDoc, /sole permitted model[\s\S]{0,200}longcat-2\.5-preview-free/);
  assert.equal(config.provider['opencode-go'].whitelist.length, 1);
  assert.equal(config.provider['opencode-go'].whitelist[0], 'step-5-preview-free');
});

test('CLI availability gate refuses to launch when Step 5 is not offered', () => {
  const cli = source('../src/agent.ts');
  const gate = cli.match(/if \(configuredModelAvailable\([\s\S]*?\) === false\) \{\n\s*throw new Error\('configured OpenCode model opencode-go\/step-5-preview-free is unavailable'\);/);
  assert.ok(gate, 'the run path must consult configuredModelAvailable before launching and refuse with the Step 5 unavailable error');
  const runtime = source('../../agent-runtime/src/backend.ts');
  assert.ok(runtime.includes('export function configuredModelAvailable'));
  assert.ok(runtime.includes('.includes(AGENT_MODEL)'));
});

test('CI fake OpenCode offers Step 5 only', () => {
  const ci = source('../../../.github/workflows/ci.yml');
  const modelsCase = ci.match(/models\)\n\s*echo "([^"]+)"/);
  assert.ok(modelsCase, 'CI must stub an opencode models probe');
  assert.equal(modelsCase[1], model);
  for (const forbidden of FORBIDDEN_MODELS) {
    assert.ok(!modelsCase[1].includes(forbidden));
  }
});
