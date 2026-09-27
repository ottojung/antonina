import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DAEMON_REPORT_SCHEMA_VERSION, hostBytes } from '../../core/dist/host-daemon.js';
import { daemonConfigDir } from '../../host-daemon/dist/packages/host-daemon/src/config.js';
import { daemonPaths } from '../../host-daemon/dist/packages/host-daemon/src/identity.js';
import { runDaemonCommand } from '../dist/packages/cli/src/daemon.js';

/**
 * CLI adapter tests.
 *
 * Every command runs against a temporary `XDG_STATE_HOME` and
 * `XDG_CONFIG_HOME`, so no test can read or write the operator's real
 * `daemon.json`, `trust.json` or `credential.json`, and none of them starts a
 * process: the daemon lifecycle is covered in the `host-daemon` package against
 * an injected clock and scheduler. The clock here is injected too, so what
 * `status` prints about freshness is a function of the test rather than of when
 * it ran.
 */

const STAMP = '2026-09-25T12:00:00.000Z';
const STAMP_MS = Date.parse(STAMP);

async function withRoots(body) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-daemon-cli-'));
  const env = {
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    HOME: root,
  };
  const out = [];
  const err = [];
  const context = {
    env,
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    now: () => STAMP_MS,
  };
  try {
    return await body({ root, env, context, out, err, paths: daemonPaths({ env }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(context, args) {
  return runDaemonCommand(args, context);
}

function report(overrides = {}) {
  return {
    schemaVersion: DAEMON_REPORT_SCHEMA_VERSION,
    hostId: 'phoebe-dev',
    address: 'lubko://phoebe-dev',
    health: 'healthy',
    observedAt: STAMP,
    heartbeatCount: 4,
    daemon: { pid: 4242, startTicks: 99, startedAt: '2026-09-25T11:00:00.000Z', version: '0.1.0' },
    telemetry: {
      uptimeSeconds: 3600,
      memory: { total: hostBytes(64 * 1024 ** 3, 'os.totalmem'), available: hostBytes(32 * 1024 ** 3, 'os.freemem') },
      filesystems: [{
        path: '/',
        total: hostBytes(512 * 1024 ** 3, 'fs.statfs(/).blocks'),
        available: hostBytes(128 * 1024 ** 3, 'fs.statfs(/).bavail'),
      }],
      cpu: { logicalCores: 8, model: 'Test CPU', loadAverage: [0.1, 0.2, 0.3] },
      problems: [],
    },
    ...overrides,
  };
}

function writeConfig(env, contents) {
  mkdirSync(daemonConfigDir({ env }), { recursive: true });
  writeFileSync(join(daemonConfigDir({ env }), 'daemon.json'), JSON.stringify(contents));
}

test('identity names the host, its source and its address, and reads no environment override', async () => {
  await withRoots(async ({ env, context, out }) => {
    writeConfig(env, { hostId: 'phoebe-dev' });
    assert.equal(await run(context, ['identity']), 0);
    assert.deepEqual(out, [
      'host: phoebe-dev',
      'derived from: configured',
      'address: lubko://phoebe-dev',
    ]);

    out.length = 0;
    assert.equal(await run(context, ['identity', '--json']), 0);
    assert.deepEqual(JSON.parse(out.join('\n')), {
      address: 'lubko://phoebe-dev',
      hostId: 'phoebe-dev',
      source: 'configured',
    });
  });
});

test('a host with nothing published yet reads as offline, and says why', async () => {
  await withRoots(async ({ env, context, out }) => {
    writeConfig(env, { hostId: 'phoebe-dev' });
    assert.equal(await run(context, ['status']), 0);
    assert.deepEqual(out, [
      'offline: the host has never published a daemon report',
      'daemon lock: free (no daemon lock is present)',
    ]);
  });
});

test('status prints the last report and the liveness a clock makes of it', async () => {
  await withRoots(async ({ env, context, out, paths }) => {
    writeConfig(env, { hostId: 'phoebe-dev', staleAfterMs: 60_000 });
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.report, JSON.stringify(report(), null, 2));

    assert.equal(await run(context, ['status']), 0);
    const text = out.join('\n');
    assert.match(text, /^host: phoebe-dev$/m);
    assert.match(text, /^address: lubko:\/\/phoebe-dev$/m);
    assert.match(text, /^health: healthy$/m);
    assert.match(text, /^heartbeats: 4$/m);
    assert.match(text, /^memory: 65536 MiB total, 32768 MiB available$/m);
    assert.match(text, /^cpu: 8 cores \(Test CPU\) load 0.1\/0.2\/0.3$/m);
    assert.match(text, /^liveness: the host published a report inside the stale threshold$/m);
    assert.match(text, /^filesystem \/: 524288 MiB total, 131072 MiB available$/m);
  });
});

test('a report past the stale threshold is reported as stale rather than as a live host', async () => {
  await withRoots(async ({ env, context, out, err, paths }) => {
    writeConfig(env, { hostId: 'phoebe-dev', staleAfterMs: 60_000 });
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.report, JSON.stringify(report({ observedAt: '2026-09-25T11:58:00.000Z' }), null, 2));

    const code = await run(context, ['status']);
    assert.equal(code, 0, 'stderr: ' + err.join(' '));
    assert.match(out.join('\n'), /^liveness: the last report is 120000ms old, past the 60000ms stale threshold$/m);

    out.length = 0;
    assert.equal(await run(context, ['status', '--json']), 0, 'stderr: ' + err.join(' '));
    const document = JSON.parse(out.join('\n'));
    assert.equal(document.liveness.status, 'stale');
    assert.equal(document.liveness.ageMs, 120_000);
    assert.equal(document.hostId, 'phoebe-dev');
    assert.equal(document.address, 'lubko://phoebe-dev');
    assert.equal(document.lock.held, false);
  });
});

test('telemetry the host could not read is printed as unavailable, with the reason', async () => {
  await withRoots(async ({ env, context, out, paths }) => {
    writeConfig(env, { hostId: 'phoebe-dev' });
    mkdirSync(paths.dir, { recursive: true });
    const value = report();
    value.telemetry.filesystems.push({
      path: '/workspace',
      total: { ok: false, reason: 'unreadable', detail: 'EACCES' },
      available: { ok: false, reason: 'unreadable', detail: 'EACCES' },
    });
    value.telemetry.problems = ['/workspace total is unavailable (unreadable)'];
    value.health = 'degraded';
    writeFileSync(paths.report, JSON.stringify(value, null, 2));

    assert.equal(await run(context, ['status']), 0);
    const text = out.join('\n');
    assert.match(text, /^health: degraded$/m);
    assert.match(text, /^filesystem \/workspace: unavailable \(unreadable\) total, unavailable \(unreadable\) available$/m);
    assert.match(text, /^problem: \/workspace total is unavailable \(unreadable\)$/m);
  });
});

test('a damaged report is refused by path instead of being reported as a healthy host', async () => {
  await withRoots(async ({ env, context, err, paths }) => {
    writeConfig(env, { hostId: 'phoebe-dev' });
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.report, '{"hostId":"phoebe-dev","health":"probably-fine"}');
    assert.equal(await run(context, ['status']), 1);
    assert.match(err.join('\n'), /host\.json/);
    assert.match(err.join('\n'), /malformed/);
  });
});

test('a daemon configuration that is wrong is refused with a pointer to the file to fix', async () => {
  await withRoots(async ({ env, context, err }) => {
    mkdirSync(daemonConfigDir({ env }), { recursive: true });
    writeFileSync(join(daemonConfigDir({ env }), 'daemon.json'), JSON.stringify({ workspaces: ['nope'] }));
    assert.equal(await run(context, ['status']), 1);
    assert.match(err.join('\n'), /daemon\.json/);
    assert.match(err.join('\n'), /canonical absolute paths/);
    assert.match(err.join('\n'), /XDG_CONFIG_HOME\/antonina\/daemon\.json/);
  });
});

test('an unknown daemon command explains itself rather than doing something', async () => {
  await withRoots(async ({ context }) => {
    assert.equal(await run(context, ['teleport']), 2);
    assert.equal(await run(context, []), 2);
    assert.equal(await run(context, ['help']), 0);
  });
});
