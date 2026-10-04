// Board 167, A/A2 shape: refused signal plus a non-signal non-zero exit.
// Same refused-signal mechanism as runner-refused-signal-note.test.mjs, but the
// backend dies with a NON-ZERO EXIT and NO SIGNAL (the A/A2 shape the board
// recorded: exit_code=1, exit_signal=null, error=null, stop_reason=stop|kill).
// The shipped fixture only covers the signal-death shape, so this one checks
// whether the non-signal shape is still reachable with error: null.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const LIFETIME_MS = Number(process.env.ANTONINA_TEST_FIXTURE_LIFETIME_MS ?? 60000);

function cgroup(usedGiB) {
  const gib = 1024 * 1024 * 1024;
  const files = new Map([
    ['/sys/fs/cgroup/memory.max', String(30 * gib)],
    ['/sys/fs/cgroup/memory.current', String(Math.round(usedGiB * gib))],
    ['/sys/fs/cgroup/memory.events', 'oom 39\noom_kill 3\n'],
    ['/proc/self/cgroup', '0::/\n'],
  ]);
  return (path) => files.get(path) ?? null;
}

function fixture(t, id, options, intent, exitCode) {
  const root = mkdtempSync(join(tmpdir(), 'harvest167-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const signalled = join(root, 'was-signalled');
  const helper = join(root, 'refuse.mjs');
  writeFileSync(helper, [
    "import { writeFileSync } from 'node:fs';",
    'const [storeUrl, agentId, intent, signalled, stateHome, configHome, exitCode] = process.argv.slice(2);',
    'const { readMeta, updateMeta } = await import(storeUrl);',
    'const options = { env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome } };',
    'const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };',
    'const backendArgv = process.argv.slice(9);',
    'if (backendArgv[0] === "session" || backendArgv[0] === "models") process.exit(0);',
    'if (backendArgv[0] !== "run") process.exit(4);',
    'process.on("SIGTERM", () => { try { writeFileSync(signalled, "sigterm\\n"); } catch {} process.exit(0); });',
    'process.on("SIGINT", () => { try { writeFileSync(signalled, "sigint\\n"); } catch {} process.exit(0); });',
    'const deadline = Date.now() + 30000;',
    'let meta = null;',
    'while (Date.now() < deadline) {',
    '  try { meta = readMeta(agentId, options); } catch { meta = null; }',
    '  if (meta !== null && meta.pid !== null && meta.pid !== undefined) break;',
    '  sleep(2);',
    '}',
    'if (meta === null || meta.pid === null || meta.pid === undefined) process.exit(3);',
    'await updateMeta(agentId, (current) => {',
    '  if (current.pid === null || current.pid === undefined) process.exit(3);',
    '  current.intent = intent;',
    '  current.stop_reason = intent;',
    '  current.start_time = (current.start_time + 4242) % 1000000;',
    '}, options);',
    'sleep(1200);',
    `process.exit(Number(exitCode));`,
  ].join('\n'));
  const storeUrl = new URL('../dist/packages/agent-runtime/src/store.js', import.meta.url).href;
  const argv = [
    'node', helper, storeUrl, id, intent, signalled,
    options.env.XDG_STATE_HOME, options.env.XDG_CONFIG_HOME, String(exitCode),
  ].map((v) => JSON.stringify(v)).join(' ');
  const bin = join(root, 'opencode');
  writeFileSync(bin, `#!/bin/sh\necho "starting"\nexec ${argv} "$@"\n`, { mode: 0o755 });
  return { bin, signalledPath: signalled };
}

for (const intent of ['stop', 'kill']) {
  for (const exitCode of [1, 2]) {
    test(`harvest167. ${intent} refused then backend exits ${exitCode} with no signal records a reason`, { timeout: 120000 }, async (t) => {
      if (procStartTicks(process.pid) === null) { t.skip('no /proc'); return; }
      const root = mkdtempSync(join(tmpdir(), 'harvest167-home-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const stateHome = join(root, 'state');
      const configHome = join(root, 'config');
      const saved = { ...process.env };
      process.env.XDG_STATE_HOME = stateHome;
      process.env.XDG_CONFIG_HOME = configHome;
      t.after(() => { Object.assign(process.env, saved); });
      const options = { env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome } };

      const id = 'a11d';
      const cwd = mkdtempSync(join(tmpdir(), 'harvest167-cwd-'));
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      assert.equal(createAgentDirectory(id, options), true);
      const meta = idleMeta(id, cwd, null, 1);
      meta.runner_gen = 7;
      meta.runner_reservation = { state: 'reserved', gen: 7, mode: 'new', reserved_at: 1, owner_pid: process.pid, owner_start_ticks: procStartTicks(process.pid) };
      meta.pending_prompt = 'work';
      writeMeta(id, meta, options);

      const fx = fixture(t, id, options, intent, exitCode);
      const run = { ...options, env: { ...options.env, ANTONINA_OPENCODE_BIN: fx.bin } };
      await runManagedRunner(id, 'new', 7, { ...run, capacity: { readText: cgroup(1) } });

      const after = readMeta(id, run);
      t.diagnostic(JSON.stringify({ intent, exitCode, state: after.state, exit_code: after.exit_code, exit_signal: after.exit_signal, stop_reason: after.stop_reason, error: after.error, backend_error: after.backend_error }));

      assert.equal(existsSync(fx.signalledPath), false, 'fixture was signalled, so not a refused-signal run');
      assert.equal(after.exit_code, exitCode);
      assert.equal(after.exit_signal, null);
      assert.equal(after.stop_reason, intent);
      assert.equal(after.state, intent === 'stop' ? 'stopped' : 'killed');
      assert.notEqual(after.error, null, 'unexplained non-zero exit with an undelivered operator signal must record a reason');
      assert.notEqual(after.backend_error, null);
      assert.equal(after.active_runner, false);
      assert.equal(after.intent, null);
    });
  }
}
