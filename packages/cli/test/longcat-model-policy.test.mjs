import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('managed agent model configuration is authoritative and no provider is hardcoded', () => {
  const intent = source('../../../docs/intent-records/agent.md');
  assert.match(intent, /^\$id-20261022-no-host-headroom-in-agent-status/);
  assert.match(intent, /\$id-20261022-reclaim-aware-headroom-diagnostics/);
  assert.match(intent, /\$id-20261022-failure-scoped-soft-model-selection/);
  assert.match(intent, /\$id-20261022-managed-agent-model-step-stall/);
  assert.match(intent, /\$id-20261021-no-opencode-model-discovery/);
  assert.match(intent, /\$id-20261021-agent-model-subcommands/);
  assert.match(intent, /\$id-20261021-configurable-model-order/);
  const runtime = source('../../agent-runtime/src/backend.ts');
  const config = source('../../agent-runtime/src/model-config.ts');
  const cli = source('../src/agent.ts');
  assert.match(config, /config\.json/);
  assert.match(config, /configuredModels/);
  assert.match(runtime, /selectConfiguredModel/);
  assert.match(cli, /selectConfiguredModel/);
  for (const [path, contents] of [
    ['backend', runtime], ['CLI', cli],
  ]) assert.doesNotMatch(contents, /opencode-go\/(?:longcat|beam|mini|max|step|cat)/i, path);
});
