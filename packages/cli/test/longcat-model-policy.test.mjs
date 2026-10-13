import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const model = 'opencode-go/longcat-2.5-preview-free';
const variant = 'low';

const FORBIDDEN_MODELS = [
  'opencode-go/step-5-preview-free',
  'opencode/space-bunny-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/gpt-5.6-sol',
  'opencode/claude-opus-5',
  'opencode/big-pickle',
];

test('canonical LongCat intent is the authoritative head record', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  assert.match(intent, /^\$id-20261009-longcat-restoration/m);
  assert.match(intent, /opencode-go\/longcat-2.5-preview-free/);
  assert.match(intent, /--variant low/);
  assert.match(intent, /supersedes the 2026\/10\/08 Step 5-only constraint/);
  assert.doesNotMatch(intent.slice(0, intent.indexOf('$id-1773008474150624')), /^\$id-20261008-step5only/m);
});

test('canonical LongCat intent matches all executable model-selection surfaces', () => {
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
  assert.deepEqual(config.provider['opencode-go'].whitelist, ['longcat-2.5-preview-free']);
});

test('non-LongCat models are refused on the release line', () => {
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
  assert.equal(config.provider['opencode-go'].whitelist.length, 1);
  assert.equal(config.provider['opencode-go'].whitelist[0], 'longcat-2.5-preview-free');
});

test('CLI availability gate refuses to launch when LongCat is not offered', () => {
  const cli = source('../src/agent.ts');
  const gate = cli.match(/if \(configuredModelAvailable\([\s\S]*?\) === false\) \{\n\s*throw new Error\('configured OpenCode model opencode-go\/longcat-2.5-preview-free is unavailable'\);/);
  assert.ok(gate, 'the run path must consult configuredModelAvailable before launching and refuse with the LongCat unavailable error');
  const runtime = source('../../agent-runtime/src/backend.ts');
  assert.ok(runtime.includes('export function configuredModelAvailable'));
  assert.ok(runtime.includes(".includes(AGENT_MODEL)"));
});

test('CI fake OpenCode offers LongCat only', () => {
  const ci = source('../../../.github/workflows/ci.yml');
  const modelsCase = ci.match(/models\)\n\s*echo "([^"]+)"/);
  assert.ok(modelsCase, 'CI must stub an opencode models probe');
  assert.equal(modelsCase[1], model);
  for (const forbidden of FORBIDDEN_MODELS) {
    assert.ok(!modelsCase[1].includes(forbidden));
  }
});
