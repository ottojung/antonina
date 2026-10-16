import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardApi } from '../dist/api.js';
import {
  DEFAULT_STALE_AFTER_MS,
  MalformedDaemonHostReportError,
  daemonHostReportDefect,
  daemonHostViews,
  formatHostBytes,
  hostBytes,
  hostLiveness,
  measurementDefect,
  parseDaemonHostReport,
  unavailableHostBytes,
  DAEMON_REPORT_SCHEMA_VERSION,
} from '../dist/host-daemon.js';

const STAMP = '2026-09-25T12:00:00.000Z';
const MINUTE = 60_000;

function telemetry(overrides = {}) {
  return {
    uptimeSeconds: 86_400,
    memory: { total: hostBytes(64 * 1024 ** 3, 'os.totalmem'), available: hostBytes(32 * 1024 ** 3, 'os.freemem') },
    filesystems: [{
      path: '/',
      total: hostBytes(512 * 1024 ** 3, 'fs.statfs(/).blocks'),
      available: hostBytes(128 * 1024 ** 3, 'fs.statfs(/).bavail'),
    }],
    cpu: { logicalCores: 16, model: 'Test CPU', loadAverage: [0.5, 0.4, 0.3] },
    problems: [],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    schemaVersion: DAEMON_REPORT_SCHEMA_VERSION,
    hostId: 'phoebe-dev',
    address: 'lubko://phoebe-dev',
    health: 'healthy',
    observedAt: STAMP,
    heartbeatCount: 1,
    daemon: { pid: 4242, startTicks: 99, startedAt: '2026-09-25T11:00:00.000Z', version: '0.1.0' },
    telemetry: telemetry(),
    ...overrides,
  };
}

test('a report round-trips through the shared parser and is judged consistent', () => {
  const parsed = parseDaemonHostReport(report());
  assert.equal(parsed.hostId, 'phoebe-dev');
  assert.equal(parsed.address, 'lubko://phoebe-dev');
  assert.equal(parsed.daemon.pid, 4242);
  assert.equal(parsed.telemetry.memory.available.bytes, 32 * 1024 ** 3);
  assert.equal(parsed.telemetry.cpu.loadAverage[1], 0.4);
  assert.equal(daemonHostReportDefect(parsed), null);
});

test('a report that cannot be trusted is refused by name, one field at a time', () => {
  // A half-written or hand-edited state file must be refused rather than
  // half-accepted: a reader that took some of it would report numbers the host
  // never claimed.
  for (const [label, mutate] of [
    ['a missing field', (value) => { delete value.hostId; }],
    ['an unknown field', (value) => { value.extra = true; }],
    ['a non-slug host id', (value) => { value.hostId = 'Phoebe Dev'; }],
    ['a non-canonical address', (value) => { value.address = 'phoebe-dev'; }],
    ['an unknown health', (value) => { value.health = 'mostly-fine'; }],
    ['an unparseable observation time', (value) => { value.observedAt = 'yesterday'; }],
    ['a zero pid', (value) => { value.daemon.pid = 0; }],
    ['a missing start time', (value) => { delete value.daemon.startTicks; }],
    ['zero heartbeats', (value) => { value.heartbeatCount = 0; }],
    ['a wrong schema version', (value) => { value.schemaVersion = 99; }],
    ['a negative byte count', (value) => { value.telemetry.memory.total = { ok: true, bytes: -1, source: 'os.totalmem' }; }],
    ['a measurement without a source', (value) => { value.telemetry.memory.total = { ok: true, bytes: 8, source: '' }; }],
    ['an unknown measurement reason', (value) => { value.telemetry.filesystems[0].total = { ok: false, reason: 'nope', detail: '' }; }],
    ['a relative filesystem path', (value) => { value.telemetry.filesystems[0].path = 'relative/path'; }],
  ]) {
    const value = report();
    mutate(value);
    assert.throws(
      () => parseDaemonHostReport(value),
      MalformedDaemonHostReportError,
      'expected ' + label + ' to be refused',
    );
  }
});

test('a measurement is judged on its own shape, so an absent one is never read as zero', () => {
  assert.equal(measurementDefect({ ok: true, bytes: 0, source: 'os.totalmem' }), null);
  assert.equal(measurementDefect({ ok: false, reason: 'unreadable', detail: 'EACCES' }), null);
  assert.notEqual(measurementDefect({ ok: true, bytes: 1.5, source: 'os.totalmem' }), null);
  assert.notEqual(measurementDefect({ ok: false, reason: 'unreadable' }), null);
  assert.notEqual(measurementDefect({ ok: 'yes' }), null);
  assert.equal(unavailableHostBytes('unreadable', 'EACCES').ok, false);
});

test('a host with no report is offline, and a report past the threshold is stale', () => {
  const nowMs = Date.parse(STAMP);
  assert.deepEqual(
    { status: hostLiveness(null, { nowMs }).status, age: hostLiveness(null, { nowMs }).ageMs },
    { status: 'offline', age: null },
  );

  const fresh = parseDaemonHostReport(report());
  const freshLiveness = hostLiveness(fresh, { nowMs, staleAfterMs: DEFAULT_STALE_AFTER_MS });
  assert.equal(freshLiveness.status, 'online');
  assert.equal(freshLiveness.ageMs, 0);

  const justInside = hostLiveness(fresh, { nowMs: nowMs + DEFAULT_STALE_AFTER_MS, staleAfterMs: DEFAULT_STALE_AFTER_MS });
  assert.equal(justInside.status, 'online', 'the threshold itself is still online');

  const late = hostLiveness(fresh, { nowMs: nowMs + DEFAULT_STALE_AFTER_MS + 1 });
  assert.equal(late.status, 'stale');
  assert.match(late.reason, /stale threshold/);
});

test('a report dated far in the future is stale rather than fresh', () => {
  // A clock that jumped, or a file written by a host whose clock disagrees, must
  // not be able to make a silent host look like a live one.
  const ahead = parseDaemonHostReport(report({ observedAt: new Date(Date.parse(STAMP) + 10 * MINUTE).toISOString() }));
  const liveness = hostLiveness(ahead, { nowMs: Date.parse(STAMP), staleAfterMs: 2 * MINUTE });
  assert.equal(liveness.status, 'stale');
  assert.match(liveness.reason, /future/);
});

test('an unusable observation time is offline, never assumed to be now', () => {
  // The model refuses this report, so a caller can hand it the parsed shape only
  // by skipping the parser; the liveness answer is still fail-closed.
  const damaged = report();
  damaged.observedAt = 'not-a-time';
  const liveness = hostLiveness(damaged, { nowMs: Date.parse(STAMP) });
  assert.equal(liveness.status, 'offline');
  assert.match(liveness.reason, /unusable observation time/);
});

test('host reports remain useful without enrollment in a target catalog', () => {
  const views = daemonHostViews([
    parseDaemonHostReport(report({ hostId: 'zeta-host', address: 'lubko://zeta-host' })),
    parseDaemonHostReport(report()),
    parseDaemonHostReport(report({ heartbeatCount: 9 })),
  ], { nowMs: Date.parse(STAMP) });
  assert.deepEqual(views.map((view) => view.hostId), ['phoebe-dev', 'zeta-host']);
  assert.equal(views[0].heartbeatCount, 9);
  assert.equal(views[0].liveness.status, 'online');
  assert.equal(views[0].telemetry.memory.total.bytes, 64 * 1024 ** 3);
  assert.equal(Object.hasOwn(views[0], 'targetId'), false);
});

test('host telemetry is available without a board credential', async () => {
  const client = new BoardApi({
    fetch: async () => new Response(null, { status: 404 }),
    now: () => new Date(STAMP),
  });
  const views = await client.daemonHosts([parseDaemonHostReport(report())], { nowMs: Date.parse(STAMP) });
  assert.equal(views.length, 1);
  assert.equal(views[0].hostId, 'phoebe-dev');
  assert.equal(views[0].liveness.status, 'online');
  assert.equal(client.hasWriteAccess(), false);
  assert.equal(client.getCredential(), null);
});

test('a byte count is printed at one scale everywhere it is printed', () => {
  // The CLI and the board view render the same measurement; a second copy of
  // this loop is how they would start disagreeing about the same number.
  assert.equal(formatHostBytes(0), '0 B');
  assert.equal(formatHostBytes(1023), '1023 B');
  assert.equal(formatHostBytes(1024), '1.0 KiB');
  assert.equal(formatHostBytes(1024 ** 3), '1.0 GiB');
  assert.equal(formatHostBytes(1024 ** 5 * 2), '2.0 PiB');
  assert.equal(formatHostBytes(1024 ** 6 * 3), '3072.0 PiB', 'the scale stops at the largest unit');
});
