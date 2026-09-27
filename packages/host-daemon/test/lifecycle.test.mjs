import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hostBytes, parseDaemonHostReport } from '../../core/dist/host-daemon.js';
import { parseDaemonConfig } from '../dist/packages/host-daemon/src/config.js';
import { daemonPaths, ensureHostIdentity } from '../dist/packages/host-daemon/src/identity.js';
import { DaemonAlreadyRunningError, readDaemonLock } from '../dist/packages/host-daemon/src/lock.js';
import { readHostReport } from '../dist/packages/host-daemon/src/state.js';
import { healthOf, startDaemon } from '../dist/packages/host-daemon/src/service.js';

/**
 * Daemon lifecycle tests.
 *
 * Every test owns a temporary `XDG_STATE_HOME`, so no daemon, lock or report is
 * written under the operator's real state root, and no test reads the operator's
 * real `daemon.json`. Heartbeats are driven by an injected scheduler and an
 * injected clock rather than by wall-clock waiting, so nothing here depends on
 * how fast or how loaded the machine is. Each daemon a test starts is stopped
 * before the test returns, and `t.after` removes the temporary tree even when an
 * assertion fails.
 */

/** A scheduler that runs a beat only when a test asks for one. */
function manualScheduler() {
  let pending = null;
  return {
    scheduler: {
      schedule(fn) {
        pending = fn;
        return 1;
      },
      cancel() {
        pending = null;
      },
    },
    beat() {
      const fn = pending;
      pending = null;
      assert.ok(fn !== null, 'a beat was requested while no heartbeat was scheduled');
      fn();
    },
    scheduled() {
      return pending !== null;
    },
  };
}

const GIB = 1024 ** 3;

function healthyFacts(nowMs) {
  return {
    nowMs,
    totalMemoryBytes: () => hostBytes(64 * GIB, 'os.totalmem'),
    availableMemoryBytes: () => hostBytes(32 * GIB, 'os.freemem'),
    logicalCores: () => 8,
    cpuModel: () => 'Test CPU',
    loadAverage: () => [0.1, 0.2, 0.3],
    uptimeSeconds: () => 3600,
    filesystemCapacity: (path) => ({
      total: hostBytes(512 * GIB, 'fs.statfs(' + path + ').blocks'),
      available: hostBytes(128 * GIB, 'fs.statfs(' + path + ').bavail'),
    }),
  };
}

async function withHost(body) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-daemon-lifecycle-'));
  const env = { XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), HOME: root };
  const started = [];
  try {
    return await body({
      root,
      env,
      paths: daemonPaths({ env }),
      track: (handle) => {
        started.push(handle);
        return handle;
      },
    });
  } finally {
    // Every daemon this test started converges before the temporary tree goes.
    for (const handle of started.reverse()) await handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function config(overrides = {}) {
  return parseDaemonConfig({ heartbeatIntervalMs: 1_000, staleAfterMs: 60_000, ...overrides });
}

test('a started daemon publishes immediately and again on every beat', async () => {
  await withHost(async ({ env, paths, track }) => {
    const timer = manualScheduler();
    let now = 1_000_000;
    const handle = track(startDaemon({
      config: config({ hostId: 'phoebe-dev', workspaces: ['/workspace'] }),
      env,
      paths,
      scheduler: timer.scheduler,
      now: () => now,
      facts: (nowMs) => healthyFacts(nowMs),
      version: '9.9.9',
    }));

    // The first report exists before any timer fires: a host is reported as soon
    // as its daemon is up, not one interval later.
    const first = readHostReport({ paths });
    assert.equal(first.hostId, 'phoebe-dev');
    assert.equal(first.address, 'lubko://phoebe-dev');
    assert.equal(first.health, 'healthy');
    assert.equal(first.heartbeatCount, 1);
    assert.equal(first.daemon.version, '9.9.9');
    assert.equal(first.daemon.pid, process.pid);
    assert.deepEqual(first.telemetry.problems, []);
    assert.deepEqual(first.telemetry.filesystems.map((entry) => entry.path), ['/', '/workspace']);
    assert.deepEqual(first.telemetry.problems, readHostReport({ paths }).telemetry.problems,
      'what is written is what a reader parses back');

    now += 30_000;
    timer.beat();
    const second = readHostReport({ paths });
    assert.equal(second.heartbeatCount, 2);
    assert.notEqual(second.observedAt, first.observedAt);
    // The published report is exactly what the shared parser accepts, so a
    // board view and a CLI read cannot disagree about it.
    assert.deepEqual(parseDaemonHostReport(JSON.parse(readFileSync(paths.report, 'utf8'))), second);

    now += 30_000;
    timer.beat();
    assert.equal(readHostReport({ paths }).heartbeatCount, 3);
    assert.equal(timer.scheduled(), true, 'a beat is rescheduled after each heartbeat');
  });
});

test('a host with an unreadable workspace reports itself degraded, and still reports the rest', async () => {
  await withHost(async ({ env, paths, track }) => {
    const handle = track(startDaemon({
      config: config({ hostId: 'phoebe-dev', workspaces: ['/no/such/workspace'] }),
      env,
      paths,
      scheduler: manualScheduler().scheduler,
      now: () => 2_000_000,
      facts: (nowMs) => ({
        ...healthyFacts(nowMs),
        filesystemCapacity: (path) => {
          if (path === '/no/such/workspace') {
            throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
          }
          return healthyFacts(nowMs).filesystemCapacity(path);
        },
      }),
    }));
    const report = readHostReport({ paths });
    assert.equal(report.health, 'degraded');
    assert.equal(healthOf(report.telemetry.problems), 'degraded');
    assert.equal(healthOf([]), 'healthy');
    assert.equal(report.telemetry.memory.total.ok, true);
    assert.deepEqual(report.telemetry.problems, [
      '/no/such/workspace available is unavailable (unreadable)',
      '/no/such/workspace total is unavailable (unreadable)',
    ]);
    assert.equal(handle.lastReport().health, 'degraded');
  });
});

test('a stopped daemon leaves nothing claiming to be alive, and the identity survives', async () => {
  await withHost(async ({ env, paths, track }) => {
    const handle = track(startDaemon({
      config: config({ hostId: 'phoebe-dev' }),
      env,
      paths,
      scheduler: manualScheduler().scheduler,
      now: () => 3_000_000,
      facts: (nowMs) => healthyFacts(nowMs),
    }));
    assert.equal(existsSync(paths.report), true);
    assert.equal(existsSync(paths.lock), true);

    await handle.stop();
    // A graceful stop is not a crash: the host reads as offline now rather than
    // staying online until its last report ages out. A daemon that dies without
    // stopping leaves the report behind, and that one is what reads as stale.
    assert.equal(existsSync(paths.report), false);
    assert.equal(readHostReport({ paths }), null);
    assert.equal(existsSync(paths.lock), false, 'the lock is released, so the host can be restarted');
    assert.equal(existsSync(paths.identity), false, 'a configured identity is never recorded');

    // Stopping twice is not an error: a supervisor that signals twice must not
    // crash the daemon on its way down.
    await handle.stop();
  });
});

test('a derived identity is kept across a restart, so a restarted daemon is the same host', async () => {
  await withHost(async ({ root, env, paths, track }) => {
    // Derived once from a machine-id fixture, never from this machine's real one.
    const machineId = join(root, 'machine-id');
    writeFileSync(machineId, 'b'.repeat(32));
    const identity = ensureHostIdentity({
      config: config(),
      paths,
      nowMs: 0,
      machineIdFiles: [machineId],
    });
    assert.equal(identity.hostId, 'host-' + 'b'.repeat(32));

    const start = (nowMs) => startDaemon({
      config: config(),
      env,
      paths,
      scheduler: manualScheduler().scheduler,
      now: () => nowMs,
      facts: (nowMsValue) => healthyFacts(nowMsValue),
      startTicks: 1234,
    });
    const first = track(start(4_000_000));
    assert.equal(readHostReport({ paths }).hostId, identity.hostId);
    assert.equal(readHostReport({ paths }).daemon.startTicks, 1234);
    await first.stop();

    const second = track(start(5_000_000));
    const report = readHostReport({ paths });
    assert.equal(report.hostId, identity.hostId, 'a restarted daemon is the same host, not a new one');
    assert.equal(report.heartbeatCount, 1, 'a restarted daemon is a new process, so its count starts again');
  });
});

test('a second daemon is refused while one is running, and may start once it has stopped', async () => {
  await withHost(async ({ env, paths, track }) => {
    const options = {
      config: config({ hostId: 'phoebe-dev' }),
      env,
      paths,
      scheduler: manualScheduler().scheduler,
      now: () => 6_000_000,
      facts: (nowMs) => healthyFacts(nowMs),
    };
    const first = track(startDaemon(options));
    const lock = readDaemonLock({ paths });
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.hostId, 'phoebe-dev');

    // Two daemons publishing into one report would alternate heartbeats and make
    // a live host look unreliable, so the second is refused by name.
    assert.throws(() => startDaemon(options), (error) => {
      assert.ok(error instanceof DaemonAlreadyRunningError);
      assert.equal(error.record.pid, process.pid);
      assert.match(error.message, /already running/);
      return true;
    });
    assert.equal(readHostReport({ paths }).heartbeatCount, 1, 'the refused daemon published nothing');

    await first.stop();
    const second = track(startDaemon(options));
    assert.equal(readHostReport({ paths }).heartbeatCount, 1);
    assert.equal(readDaemonLock({ paths }).pid, process.pid);
  });
});

test('a lock left by a process that no longer exists is reclaimed, and a live one is not', async () => {
  await withHost(async ({ env, paths, track }) => {
    // A pid that cannot be running: the start time a lock recorded for it is
    // judged against the process table, and there is no such process.
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lock, JSON.stringify({
      hostId: 'phoebe-dev',
      pid: 2_147_480_000,
      startTicks: 1,
      acquiredAt: '2026-09-25T12:00:00.000Z',
    }, null, 2));
    const handle = track(startDaemon({
      config: config({ hostId: 'phoebe-dev' }),
      env,
      paths,
      scheduler: manualScheduler().scheduler,
      now: () => 7_000_000,
      facts: (nowMs) => healthyFacts(nowMs),
    }));
    assert.equal(readDaemonLock({ paths }).pid, process.pid, 'the dead owner was replaced');
    assert.equal(readHostReport({ paths }).hostId, 'phoebe-dev');
    void handle;
  });
});

test('a damaged published report is refused by path rather than read as a host that is fine', async () => {
  await withHost(async ({ env, paths }) => {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.report, '{"hostId":"phoebe-dev","heartbeatCount":');
    assert.throws(() => readHostReport({ paths }), (error) => {
      assert.match(error.message, /host\.json/);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
    // The failure is reported rather than swallowed: "offline because the file
    // is damaged" and "offline because the daemon is gone" want opposite
    // responses, and only one of them is true here.
    void env;
  });
});
