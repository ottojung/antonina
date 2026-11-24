import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAgentCommand } from '../dist/packages/cli/src/agent.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { recordSharedModelCooldown } from '../dist/packages/agent-runtime/src/model-cooldowns.js';
import { coolDownAgentModel, PERMANENT_EXCLUSION_UNTIL } from '../dist/packages/agent-runtime/src/model-failover.js';

const MOCK = 'example.test/mock';
const SPARE = 'example.test/spare';

function fixture(t) {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-cli-breaker-'));
  const work = join(root, 'work');
  nodeFs.mkdirSync(work);
  const configHome = join(root, 'config');
  nodeFs.mkdirSync(join(configHome, 'antonina'), { recursive: true });
  nodeFs.writeFileSync(join(configHome, 'antonina', 'config.json'), JSON.stringify({ models: [
    { model: MOCK, comment: 'isolated fixture' }, { model: SPARE, comment: 'isolated fixture' },
  ] }));
  const mockOpenCode = join(root, 'mock-opencode');
  nodeFs.writeFileSync(mockOpenCode, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  const state = {
    env: { XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: configHome, ANTONINA_OPENCODE_BIN: mockOpenCode },
    home: join(root, 'home'),
  };
  const out = [];
  const err = [];
  const context = {
    env: { ...state.env, PATH: '' }, home: state.home, cwd: work,
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), stdoutRaw: (text) => out.push(text) },
  };
  return { work, state, context, out, err };
}

test('run refuses, and writes nothing, when every configured model is cooling down', async (t) => {
  const { work, state, context, err } = fixture(t);
  assert.equal(createAgentDirectory('b0a7', state), true);
  const meta = idleMeta('b0a7', work, null, 1);
  // One limit this agent hit itself, one another agent on the host recorded.
  coolDownAgentModel(meta, SPARE, 'quota_exhausted');
  writeMeta('b0a7', meta, state);
  const until = Date.now() / 1000 + 3_600;
  recordSharedModelCooldown('some-other-agent', MOCK, 'rate_limited', until, state);
  const before = JSON.stringify(readMeta('b0a7', state));

  const code = await runAgentCommand(
    ['run', '--id', 'b0a7', '--prompt', 'do the work', '--cwd', work, '--detach'], context);

  assert.notEqual(code, 0);
  const message = err.join('\n');
  assert.match(message, /no model available, nothing was dispatched/);
  assert.match(message, /example\.test\/mock rate_limited until /);
  assert.match(message, /example\.test\/spare quota_exhausted until /);
  assert.ok(message.includes(new Date(until * 1000).toISOString()), 'names when the earliest model returns');
  assert.match(message, /--wait-for-model/);
  assert.equal(JSON.stringify(readMeta('b0a7', state)), before, 'no prompt, reservation or state change was recorded');
});

test('a soft transient penalty on every model does not trip the breaker', async (t) => {
  const { work, state, context, err } = fixture(t);
  assert.equal(createAgentDirectory('50f7', state), true);
  const meta = idleMeta('50f7', work, null, 1);
  coolDownAgentModel(meta, MOCK, 'transient_backend');
  coolDownAgentModel(meta, SPARE, 'transient_backend');
  writeMeta('50f7', meta, state);
  // An unusable entry script stops the launch after acceptance; the breaker is
  // what this asserts, so only its refusal text matters.
  await runAgentCommand(['run', '--id', '50f7', '--prompt', 'do the work', '--cwd', work, '--detach'],
    { ...context, entryScript: join(work, 'missing-entry.js') }).catch(() => 1);
  assert.doesNotMatch(err.join('\n'), /no model available/);
});

test('explicit run clears stale model_unavailable without lifting auth or quota exclusions', async (t) => {
  const { work, state, context } = fixture(t);
  assert.equal(createAgentDirectory('c1ea', state), true);
  const meta = idleMeta('c1ea', work, null, 1);
  coolDownAgentModel(meta, MOCK, 'model_unavailable');
  coolDownAgentModel(meta, SPARE, 'provider_authentication_failed');
  writeMeta('c1ea', meta, state);
  // Missing entry script stops the launch after acceptance; the assertion is
  // about which exclusions the explicit run cleared before that point.
  await runAgentCommand(
    ['run', '--id', 'c1ea', '--prompt', 'do the work', '--cwd', work, '--detach'],
    { ...context, entryScript: join(work, 'missing-entry.js') },
  ).catch(() => 1);
  const after = readMeta('c1ea', state);
  const reasons = after.model_failover.cooldowns.map((entry) => entry.reason);
  assert.ok(!reasons.includes('model_unavailable'), 'stale no-route exclusion was retried');
  assert.ok(reasons.includes('provider_authentication_failed'), 'provider auth exclusion was kept');
  assert.equal(after.model_failover.cooldowns.find((entry) => entry.model === SPARE).until,
    PERMANENT_EXCLUSION_UNTIL);
});
