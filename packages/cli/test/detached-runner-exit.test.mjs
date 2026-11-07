import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');

test('finished private runner exits even when an imported dependency retains a live handle', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-runner-exit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const state = join(root, 'state');
  mkdirSync(config);
  mkdirSync(state);
  // Simulate a backend dependency that retains a socket/timer after the
  // invocation terminates. No agent record exists in this isolated root, so
  // the runner returns without any backend or external side effects.
  const preload = join(root, 'open-handle.mjs');
  writeFileSync(preload, 'setInterval(() => {}, 60_000);\n');
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    ANTONINA_RUNNER_OWNER_TOKEN: 'test-only-token',
  };
  const result = spawnSync(process.execPath, [
    '--import', preload, CLI, '_runner', 'no-such-agent', 'new', '1',
  ], { env, encoding: 'utf8', timeout: 2500 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});
