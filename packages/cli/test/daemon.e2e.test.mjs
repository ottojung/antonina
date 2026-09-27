import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { parseDaemonHostReport } from '../../core/dist/host-daemon.js';
import { daemonConfigDir } from '../../host-daemon/dist/packages/host-daemon/src/config.js';
import { daemonPaths } from '../../host-daemon/dist/packages/host-daemon/src/identity.js';

/**
 * One end-to-end lifecycle test against the real `antonina daemon start`.
 *
 * The heartbeat interval is a full second, so this is the only place where a
 * test waits on wall-clock time, and it waits on a process converging rather
 * than on a number appearing. `stopDaemon` is registered with `t.after` as well
 * as being called at the end, so the spawned process is signalled, reaped and
 * asserted gone even when an assertion above it fails: no test leaves a daemon
 * running.
 */

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 20_000;

/**
 * A timer that does not hold the event loop open. An unreferenced timer still
 * fires; it just never keeps a finished test alive, so a test that finishes
 * before its timeout does not wait for it.
 */
function sleep(milliseconds) {
  return new Promise((resolve_) => {
    setTimeout(resolve_, milliseconds).unref();
  });
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + description);
}

test('the daemon publishes while it runs and converges on SIGTERM', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-daemon-e2e-'));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    HOME: root,
  };
  const paths = daemonPaths({ env });
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(daemonConfigDir({ env }), { recursive: true });
  writeFileSync(join(daemonConfigDir({ env }), 'daemon.json'), JSON.stringify({
    hostId: 'e2e-host',
    heartbeatIntervalMs: 1_000,
    staleAfterMs: 60_000,
  }));

  const child = spawn(process.execPath, [CLI, 'daemon', 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  let reaped = false;

  const stopDaemon = async () => {
    if (reaped) return null;
    reaped = true;
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      sleep(STOP_TIMEOUT_MS).then(() => null),
    ]);
    if (result === null) {
      child.kill('SIGKILL');
      await exited;
      return null;
    }
    return result;
  };
  t.after(async () => {
    await stopDaemon();
    rmSync(root, { recursive: true, force: true });
  });

  const report = await waitFor(() => {
    if (!existsSync(paths.report)) return null;
    return parseDaemonHostReport(JSON.parse(readFileSync(paths.report, 'utf8')));
  }, 'the first published report');
  assert.equal(report.hostId, 'e2e-host');
  assert.equal(report.address, 'lubko://e2e-host');
  assert.equal(report.health, 'healthy');
  // The startup line is written after the first report, so it is waited for
  // rather than assumed: the report and the line it follows are two pipes, and
  // only one of them has a deadline attached to it.
  await waitFor(() => /reporting host e2e-host at lubko:\/\/e2e-host/.test(stdout), 'the startup line');

  const second = await waitFor(() => {
    const current = parseDaemonHostReport(JSON.parse(readFileSync(paths.report, 'utf8')));
    return current.heartbeatCount > report.heartbeatCount ? current : null;
  }, 'a second heartbeat');
  assert.equal(second.daemon.pid, child.pid, 'the report names the daemon process that published it');
  assert.ok(second.daemon.startTicks > 0, 'the pid is paired with a start time, so it names one process');

  const result = await stopDaemon();
  assert.deepEqual(result, { code: 0, signal: null }, 'the daemon exits cleanly on SIGTERM');
  assert.match(stdout, /stopped for host e2e-host/);
  assert.equal(stderr, '');
  assert.equal(existsSync(paths.report), false, 'a stopped daemon leaves nothing claiming to be alive');
  assert.equal(existsSync(paths.lock), false);
});
