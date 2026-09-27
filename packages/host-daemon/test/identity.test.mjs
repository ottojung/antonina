import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DAEMON_CONFIG,
  DaemonConfigError,
  daemonConfigDir,
  loadDaemonConfig,
  parseDaemonConfig,
} from '../dist/packages/host-daemon/src/config.js';
import {
  HostIdentityError,
  daemonPaths,
  ensureHostIdentity,
  hostIdFromHostname,
  hostIdFromMachineId,
  readDurableHostIdentity,
  resolveHostIdentity,
} from '../dist/packages/host-daemon/src/identity.js';

/**
 * Identity and configuration tests, against temporary roots only.
 *
 * `withRoots` hands each test its own `XDG_STATE_HOME` and `XDG_CONFIG_HOME`, so
 * no test can read or write the operator's real `daemon.json`, `trust.json` or
 * `credential.json`, and no test reads this machine's real machine id: the
 * machine-id files below are fixtures written into the temporary root.
 */
function withRoots(body) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-daemon-identity-'));
  const env = {
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    HOME: root,
  };
  try {
    return body({ root, env, config: env.XDG_CONFIG_HOME, paths: daemonPaths({ env }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixture(root, name, contents) {
  const path = join(root, name);
  writeFileSync(path, contents);
  return path;
}

const MACHINE_ID = '0123456789abcdef0123456789abcdef';

test('a configured host id is the override, and nothing is derived or recorded for it', () => {
  withRoots(({ root, paths }) => {
    const machineId = writeFixture(root, 'machine-id', MACHINE_ID);
    const config = parseDaemonConfig({ hostId: 'phoebe-dev' });
    const identity = ensureHostIdentity({ config, paths, nowMs: 0, machineIdFiles: [machineId] });
    assert.equal(identity.hostId, 'phoebe-dev');
    assert.equal(identity.source, 'configured');
    // A configured identity is read from the one file the operator can see and
    // change, so nothing is written behind their back.
    assert.equal(readDurableHostIdentity(paths.identity, { readFileSync }), null);
    assert.throws(() => readFileSync(paths.identity), { code: 'ENOENT' });
  });
});

test('an identity derived from the machine id is recorded once and never moves again', () => {
  withRoots(({ root, paths }) => {
    const machineId = writeFixture(root, 'machine-id', MACHINE_ID);
    const config = DEFAULT_DAEMON_CONFIG;

    const first = ensureHostIdentity({ config, paths, nowMs: 0, machineIdFiles: [machineId] });
    assert.equal(first.source, 'machine-id');
    assert.equal(first.hostId, 'host-' + MACHINE_ID);
    assert.equal(
      resolveHostIdentity({ config, identityPath: paths.identity, machineIdFiles: [machineId] }).hostId,
      first.hostId,
    );

    // A host whose machine id file is later replaced -- a reinstall, a clone, a
    // container image -- keeps the identity it already published. Changing it
    // would strand every resource registered against this host.
    const replaced = writeFixture(root, 'machine-id', 'f'.repeat(32));
    const second = ensureHostIdentity({ config, paths, nowMs: 10_000, machineIdFiles: [replaced] });
    assert.equal(second.hostId, first.hostId);
    assert.equal(second.source, 'durable-state');
    const recorded = readDurableHostIdentity(paths.identity, { readFileSync });
    assert.equal(recorded.recordedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(readFileSync(paths.identity, 'utf8').includes(root), false,
      'the record carries the identity, not the path it was derived from');
  });
});

test('the second machine-id file is used when the first is unreadable', () => {
  withRoots(({ root, paths }) => {
    const dbus = writeFixture(root, 'dbus-machine-id', 'a'.repeat(32));
    const identity = resolveHostIdentity({
      config: DEFAULT_DAEMON_CONFIG,
      identityPath: paths.identity,
      machineIdFiles: [join(root, 'absent-machine-id'), dbus],
    });
    assert.equal(identity.source, 'dbus-machine-id');
    assert.equal(identity.hostId, 'host-' + 'a'.repeat(32));
  });
});

test('a machine-id file holding something else is not an identity, and the hostname is the fallback', () => {
  withRoots(({ root, paths }) => {
    const junk = writeFixture(root, 'machine-id', 'not a machine id');
    const identity = resolveHostIdentity({
      config: DEFAULT_DAEMON_CONFIG,
      identityPath: paths.identity,
      machineIdFiles: [junk],
      hostname: 'Workstation-7',
    });
    assert.equal(identity.source, 'hostname');
    assert.equal(identity.hostId, 'workstation-7');
    assert.equal(hostIdFromMachineId('not a machine id'), null);
    assert.equal(hostIdFromMachineId(MACHINE_ID.toUpperCase()), 'host-' + MACHINE_ID);
  });
});

test('a host with no derivable identity is refused rather than given an invented one', () => {
  withRoots(({ root, paths }) => {
    assert.throws(
      () => resolveHostIdentity({
        config: DEFAULT_DAEMON_CONFIG,
        identityPath: paths.identity,
        machineIdFiles: [join(root, 'nothing-here')],
        hostname: '   ',
      }),
      HostIdentityError,
    );
  });
});

test('a long hostname is suffixed rather than truncated, so two of them cannot collide', () => {
  const prefix = 'a'.repeat(80);
  const left = hostIdFromHostname(prefix + '-one');
  const right = hostIdFromHostname(prefix + '-two');
  assert.notEqual(left, right);
  assert.equal(left.length <= 64, true);
  assert.equal(hostIdFromHostname(''), null);
  assert.equal(hostIdFromHostname('p.o-e-b-e   DEV'), 'p-o-e-b-e-dev');
});

test('a damaged identity record is refused rather than replaced by a second host', () => {
  withRoots(({ root, paths }) => {
    const machineId = writeFixture(root, 'machine-id', MACHINE_ID);
    mkdirSync(join(root, 'state', 'antonina', 'daemon'), { recursive: true });
    for (const contents of [
      '{"hostId":"host-other","source":"configured"',
      JSON.stringify({ hostId: 'Not A Slug', source: 'hostname', recordedAt: '1970-01-01T00:00:00.000Z' }),
      JSON.stringify({ hostId: 'host-x', source: 'invented', recordedAt: '1970-01-01T00:00:00.000Z' }),
      JSON.stringify({ source: 'hostname', recordedAt: '1970-01-01T00:00:00.000Z' }),
    ]) {
      writeFileSync(paths.identity, contents);
      assert.throws(
        () => resolveHostIdentity({
          config: DEFAULT_DAEMON_CONFIG,
          identityPath: paths.identity,
          machineIdFiles: [machineId],
        }),
        HostIdentityError,
        'expected ' + contents + ' to be refused',
      );
    }
  });
});

test('daemon configuration comes from daemon.json alone, with no environment override', () => {
  withRoots(({ env }) => {
    // An unconfigured host is the normal state of a fresh installation.
    assert.deepEqual(loadDaemonConfig({ env }), DEFAULT_DAEMON_CONFIG);

    const configPath = join(daemonConfigDir({ env }), 'daemon.json');
    mkdirSync(daemonConfigDir({ env }), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      hostId: 'phoebe-dev',
      workspaces: ['/workspace/b', '/workspace/a'],
      heartbeatIntervalMs: 5_000,
      staleAfterMs: 60_000,
    }));
    const config = loadDaemonConfig({ env });
    assert.equal(config.hostId, 'phoebe-dev');
    assert.deepEqual([...config.workspaces], ['/workspace/a', '/workspace/b']);
    assert.equal(config.heartbeatIntervalMs, 5_000);
    assert.equal(config.staleAfterMs, 60_000);

    // Nothing in the environment can name the host: the config file is the only
    // source, so an operator can always state where a value came from.
    assert.equal(loadDaemonConfig({ env: { ...env, ANTONINA_DAEMON_HOST_ID: 'someone-else' } }).hostId, 'phoebe-dev');
  });
});

test('a daemon configuration that is wrong is refused by path, not silently defaulted', () => {
  withRoots(({ env }) => {
    mkdirSync(daemonConfigDir({ env }), { recursive: true });
    const path = join(daemonConfigDir({ env }), 'daemon.json');

    for (const [contents, expected] of [
      ['{', 'must contain valid JSON'],
      [JSON.stringify({ unknownKey: 1 }), 'unknown keys'],
      [JSON.stringify({ workspaces: ['relative/path'] }), 'canonical absolute paths'],
      [JSON.stringify({ heartbeatIntervalMs: 0 }), 'heartbeatIntervalMs'],
      [JSON.stringify({ heartbeatIntervalMs: 5_000, staleAfterMs: 5_000 }), 'staleAfterMs must be greater'],
      [JSON.stringify({ hostId: 'Not A Slug' }), 'lowercase alphanumeric or dash slug'],
      [JSON.stringify({ address: 'phoebe-dev' }), 'lubko://'],
    ]) {
      writeFileSync(path, contents);
      assert.throws(() => loadDaemonConfig({ env }), (error) => {
        assert.ok(error instanceof DaemonConfigError, 'expected a daemon config error for ' + contents);
        assert.ok(error.message.includes(path), 'the refusal names the file: ' + error.message);
        assert.ok(error.message.includes(expected), 'expected ' + expected + ' in: ' + error.message);
        return true;
      });
    }
  });
});
