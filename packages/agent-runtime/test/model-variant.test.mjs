import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildAgentCommand } from '../dist/packages/agent-runtime/src/backend.js';
import {
  idleMeta, persistedVariant, validateAgentMetadata,
} from '../dist/packages/agent-runtime/src/metadata.js';
import { configuredModels, modelReference } from '../dist/packages/agent-runtime/src/model-config.js';
import {
  MODEL_COOLDOWN_SECONDS, agentModelFailover, coolDownAgentModel,
} from '../dist/packages/agent-runtime/src/model-failover.js';
import { commandVariant } from '../dist/packages/agent-runtime/src/runner.js';

const FREE_ONE = 'opencode-go/hy4-flash-free';
const FREE_TWO = 'opencode/beam-free';
const LUNA = 'openai/gpt-6-luna';
const PAID = 'opencode-go/muse-spark-1.3-contributor';
const NOW = Date.now() / 1000;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-variant-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  mkdirSync(config);
  const backend = join(root, 'opencode');
  writeFileSync(backend, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, config, env: { XDG_CONFIG_HOME: config, ANTONINA_OPENCODE_BIN: backend } };
}

/** Founder order: every free model, then Luna at low, then paid models. */
function installFounderOrder(config, lunaVariant = 'low') {
  mkdirSync(join(config, 'antonina'), { recursive: true });
  const lunaEntry = lunaVariant === null ? { model: LUNA, comment: 'fallback' } : { model: LUNA, comment: 'fallback', variant: lunaVariant };
  writeFileSync(join(config, 'antonina', 'config.json'), JSON.stringify({
    models: [
      { model: FREE_ONE, comment: 'free' },
      { model: FREE_TWO, comment: 'free' },
      lunaEntry,
      { model: PAID, comment: 'paid' },
    ],
  }));
}

function modelArg(command) {
  return command[command.indexOf('--model') + 1];
}

test('config retains a validated per-model variant and keeps canonical IDs separate', (t) => {
  const { config } = fixture(t);
  installFounderOrder(config);
  const prefs = configuredModels({ XDG_CONFIG_HOME: config });
  assert.deepEqual(prefs.map((p) => p.model), [FREE_ONE, FREE_TWO, LUNA, PAID]);
  assert.deepEqual(prefs.map((p) => p.variant), [undefined, undefined, 'low', undefined]);
  for (const p of prefs) assert.equal(p.model.includes('#'), false);
  assert.equal(modelReference(prefs[0]), FREE_ONE);
  assert.equal(modelReference(prefs[2]), `${LUNA}#low`);
});

test('invalid and suffixed variants are rejected instead of being discarded', (t) => {
  const { config } = fixture(t);
  mkdirSync(join(config, 'antonina'), { recursive: true });
  const path = join(config, 'antonina', 'config.json');
  const write = (models) => writeFileSync(path, JSON.stringify({ models }));
  for (const variant of ['low#extra', '', 'low high', 42, 'x'.repeat(65)]) {
    write([{ model: FREE_ONE, comment: 'free' }, { model: LUNA, comment: 'fallback', variant }]);
    assert.throws(() => configuredModels({ XDG_CONFIG_HOME: config }), /models\[1\]\.variant/);
  }
  write([{ model: `${LUNA}#low`, comment: 'suffixed canonical ID' }]);
  assert.throws(() => configuredModels({ XDG_CONFIG_HOME: config }), /models\[0\]\.model/);
});

test('ordered fallback uses #low only for Luna, after all free models and before paid', (t) => {
  const { root, env } = fixture(t);
  installFounderOrder(env.XDG_CONFIG_HOME);
  const meta = idleMeta('variant-agent', root, 'fallback', 1);
  const command = () => buildAgentCommand(meta, 'work', false, env);

  assert.equal(modelArg(command()), FREE_ONE, 'first healthy choice is a free model');
  assert.equal(modelArg(command()).includes('#'), false);

  coolDownAgentModel(meta, FREE_ONE, 'quota_exhausted', NOW, MODEL_COOLDOWN_SECONDS);
  assert.equal(modelArg(command()), FREE_TWO, 'second free model is preferred next');

  coolDownAgentModel(meta, FREE_TWO, 'quota_exhausted', NOW, MODEL_COOLDOWN_SECONDS);
  assert.equal(modelArg(command()), `${LUNA}#low`, 'Luna is used as fallback with its configured variant');

  coolDownAgentModel(meta, LUNA, 'quota_exhausted', NOW, MODEL_COOLDOWN_SECONDS);
  assert.equal(modelArg(command()), PAID, 'paid models come last and stay variant-less');

  // Cooldowns and recorded selections stay keyed on canonical model IDs.
  const state = agentModelFailover(meta);
  assert.equal(state.cooldowns.some((c) => c.model === `${LUNA}#low`), false);
  assert.equal(state.cooldowns.some((c) => c.model === LUNA), true);
});

test('continuation keeps the same #low reference for a Luna session', (t) => {
  const { root, env } = fixture(t);
  installFounderOrder(env.XDG_CONFIG_HOME);
  const meta = idleMeta('variant-agent', root, 'fallback', 1);
  coolDownAgentModel(meta, FREE_ONE, 'quota_exhausted', NOW, MODEL_COOLDOWN_SECONDS);
  coolDownAgentModel(meta, FREE_TWO, 'quota_exhausted', NOW, MODEL_COOLDOWN_SECONDS);
  meta.native_session_id = 'ses_variant_test';
  const resumed = buildAgentCommand(meta, 'continue', true, env);
  assert.equal(modelArg(resumed), `${LUNA}#low`);
  assert.equal(resumed.includes('--session'), true);
  assert.equal(commandVariant(resumed), 'low');
});

test('a configured free model never gets a forced variant on fresh or resumed commands', (t) => {
  const { root, env } = fixture(t);
  installFounderOrder(env.XDG_CONFIG_HOME);
  const meta = idleMeta('variant-agent', root, 'fallback', 1);
  const fresh = buildAgentCommand(meta, 'work', false, env);
  assert.equal(modelArg(fresh), FREE_ONE);
  assert.equal(commandVariant(fresh), null);
  meta.native_session_id = 'ses_variant_test';
  const resumed = buildAgentCommand(meta, 'continue', true, env);
  assert.equal(modelArg(resumed), FREE_ONE);
  assert.equal(commandVariant(resumed), null);
});

test('variant-less configuration records no variant and old records remain valid', (t) => {
  const { root, config } = fixture(t);
  installFounderOrder(config, null);
  const meta = idleMeta('variant-agent', root, 'fallback', 1);
  assert.equal(persistedVariant(meta), undefined);
  assert.doesNotThrow(() => validateAgentMetadata(meta));
  assert.equal(modelArg(buildAgentCommand(meta, 'work', false, { XDG_CONFIG_HOME: config })), FREE_ONE);

  const legacy = { ...meta, variant: 'low' };
  assert.equal(persistedVariant(legacy), 'low');
  assert.doesNotThrow(() => validateAgentMetadata(legacy));
  const malformed = { ...meta, variant: '' };
  assert.throws(() => persistedVariant(malformed), /variant is malformed/);
});
