// A prompt received from a private file must reach OpenCode through the
// backend's piped stdin: never in argv, never in an environment variable.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { mintRunnerReservationOwnerToken, idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { installModelFixture, withModelProbe } from './support/model-fixture.mjs';

process.env.XDG_STATE_HOME = '/nonexistent-antonina-transport-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-transport-config';

const root = mkdtempSync(join(tmpdir(), 'antonina-transport-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a file-sourced 270 KiB prompt reaches the backend only by stdin', async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc start ticks');
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  const cwd = join(root, 'cwd');
  const stdinPath = join(root, 'stdin.out');
  const argvPath = join(root, 'argv.out');
  const envPath = join(root, 'env.out');
  const backend = join(root, 'fake-opencode');
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  installModelFixture(configHome);
  writeFileSync(backend, withModelProbe(`#!/bin/sh
if [ "$1" != "run" ]; then exit 0; fi
cat >${JSON.stringify(stdinPath)}
printf '%s\\n' "$*" >${JSON.stringify(argvPath)}
env | sort >${JSON.stringify(envPath)}
exit 0
`), { mode: 0o755 });

  const prompt = 'FILE-PROMPT-MARKER\n'.repeat(15_000);
  assert.ok(Buffer.byteLength(prompt) > 250 * 1024);
  const token = mintRunnerReservationOwnerToken();
  const options = {
    env: {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
      ANTONINA_OPENCODE_BIN: backend,
      ANTONINA_RUNNER_OWNER_TOKEN: token,
    },
  };
  const saved = { ...process.env };
  Object.assign(process.env, options.env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const id = 'a11d';
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  Object.assign(meta, {
    state: 'running',
    pending_prompt: prompt,
    prompt_transport: 'stdin',
    active_runner: true,
    runner_gen: 7,
    runner_reservation: {
      state: 'reserved', gen: 7, mode: 'new', owner_pid: process.pid,
      owner_start_ticks: procStartTicks(process.pid), owner_token: token, reserved_at: 1,
    },
  });
  writeMeta(id, meta, options);

  await runManagedRunner(id, 'new', 7, options);

  assert.equal(readFileSync(stdinPath, 'utf8'), prompt);
  const argv = readFileSync(argvPath, 'utf8');
  const env = readFileSync(envPath, 'utf8');
  assert.doesNotMatch(argv, /FILE-PROMPT-MARKER/);
  assert.doesNotMatch(env, /FILE-PROMPT-MARKER/);
  assert.doesNotMatch(env, /^ANTONINA_PROMPT=/m);
  assert.equal(readMeta(id, options).state, 'clearexit');
});
