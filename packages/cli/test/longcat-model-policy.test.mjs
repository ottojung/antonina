import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('model configuration is authoritative and no model is hardcoded in launch surfaces', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  assert.match(intent, /^\$id-20261022-no-host-headroom-in-agent-status/);
  assert.match(intent, /\$id-20261022-reclaim-aware-headroom-diagnostics/);
  assert.match(intent, /\$id-20261022-failure-scoped-soft-model-selection/);
  assert.match(intent, /\$id-20261022-managed-agent-model-step-stall/);
  assert.match(intent, /\$id-20261021-orchestrator-model-recovery-session-checkpoint/);
  assert.match(intent, /\$id-20261021-no-opencode-model-discovery/);
  assert.match(intent, /\$id-20261021-agent-model-subcommands/);
  assert.match(intent, /\$id-20261021-configurable-model-order/);
  const runtime = source('../../agent-runtime/src/backend.ts');
  const config = source('../../agent-runtime/src/model-config.ts');
  const cli = source('../src/agent.ts');
  const scheduler = source('../../../scripts/antonina-orchestrator-turn');
  const toolConfig = JSON.parse(source('../../../config/opencode-openclaw.json'));
  assert.match(config, /config\.json/);
  assert.match(config, /configuredModels/);
  assert.match(runtime, /selectConfiguredModel/);
  assert.match(cli, /selectConfiguredModel/);
  assert.match(scheduler, /antonina-orchestrator-model" select/);
  assert.match(scheduler, /model_preferences/);
  for (const [path, contents] of [
    ['backend', runtime], ['CLI', cli], ['orchestrator', scheduler],
    ['OpenCode config', JSON.stringify(toolConfig)],
  ]) assert.doesNotMatch(contents, /opencode-go\/(?:longcat|beam|mini|max|step|cat)/i, path);
  assert.equal(toolConfig.model, undefined);
  assert.equal(toolConfig.small_model, undefined);
  assert.equal(toolConfig.provider, undefined);
  assert.match(scheduler, /--variant low/);
  assert.match(scheduler, /FULL-FRONTIER DISPATCH/);
});
