import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { eligibleAgentModel } from '../dist/packages/agent-runtime/src/model-failover.js';
import {
  MODEL_HEALTH_WINDOW_SECONDS,
  recordUnrecognizedBackendFailure,
  sharedUnreliableModels,
} from '../dist/packages/agent-runtime/src/model-health.js';

const ICEMAN = 'opencode/iceman-contributor-free';
const GLM = 'opencode/glm-5.3-flash-free';
const MODELS = [ICEMAN, GLM].map(model => ({ model, comment: 'fixture' }));
const NOW = 1793749500;

test('independent unknown backend errors temporarily demote a model across agents', t => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-model-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { XDG_STATE_HOME: root } };
  const meta = idleMeta('new-independent-agent', root, null);
  const fresh = () => sharedUnreliableModels(options, NOW);

  assert.equal(eligibleAgentModel(meta, MODELS, NOW, () => 0, new Set(), fresh()), ICEMAN);
  recordUnrecognizedBackendFailure('executive-one', ICEMAN, options, NOW - 60);
  recordUnrecognizedBackendFailure('executive-one', ICEMAN, options, NOW - 30);
  assert.deepEqual([...fresh()], [], 'repeated failures by one agent cannot quarantine a fleet model');
  recordUnrecognizedBackendFailure('recovery-two', ICEMAN, options, NOW - 20);
  assert.deepEqual([...fresh()], [ICEMAN]);
  assert.equal(eligibleAgentModel(meta, MODELS, NOW, () => 0, new Set(), fresh()), GLM);
  assert.equal(eligibleAgentModel(meta, MODELS.slice(0,1), NOW, () => 0, new Set(), fresh()), ICEMAN,
    'soft fleet health must not permanently deadlock the only usable model');

  assert.deepEqual([...sharedUnreliableModels(options, NOW + MODEL_HEALTH_WINDOW_SECONDS + 1)], [],
    'health penalty expires; model can be revalidated without operator intervention');
  assert.equal(eligibleAgentModel(meta, MODELS, NOW + MODEL_HEALTH_WINDOW_SECONDS + 1,
    () => 0, new Set(), sharedUnreliableModels(options, NOW + MODEL_HEALTH_WINDOW_SECONDS + 1)), ICEMAN);
  const files = readdirSync(join(root, 'antonina', 'model-health'));
  assert.equal(files.length, 3);
  assert.ok(files.every(name => (statSync(join(root, 'antonina', 'model-health', name)).mode & 0o077) === 0),
    'model-health evidence is private');
});

test('healthy model remains preferred; global penalties cannot override hard quota exclusion', t => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-model-health-combine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { XDG_STATE_HOME: root } };
  recordUnrecognizedBackendFailure('agent-a', ICEMAN, options, NOW - 2);
  recordUnrecognizedBackendFailure('agent-b', ICEMAN, options, NOW - 1);
  recordUnrecognizedBackendFailure('agent-c', GLM, options, NOW - 2);
  recordUnrecognizedBackendFailure('agent-d', GLM, options, NOW - 1);
  const meta = idleMeta('new-agent', root, null);
  const unreliable = sharedUnreliableModels(options, NOW);
  assert.deepEqual([...unreliable].sort(), [ICEMAN, GLM].sort());
  assert.equal(eligibleAgentModel(meta, MODELS, NOW, () => 0, new Set(), unreliable), ICEMAN);
  assert.equal(eligibleAgentModel(meta, MODELS, NOW, () => 1, new Set(), unreliable), GLM);
  assert.equal(eligibleAgentModel(meta, MODELS, NOW, () => 0, new Set([ICEMAN]), unreliable), GLM);
});

test('malformed, stale, and absent shared model-health evidence cannot block execution', t => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-model-health-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { XDG_STATE_HOME: root } };
  assert.deepEqual([...sharedUnreliableModels(options, NOW)], []);
  recordUnrecognizedBackendFailure('one', ICEMAN, options, NOW - 10000);
  recordUnrecognizedBackendFailure('two', ICEMAN, options, NOW - 10001);
  assert.deepEqual([...sharedUnreliableModels(options, NOW)], []);
});
