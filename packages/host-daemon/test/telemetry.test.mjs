import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hostBytes, unavailableHostBytes } from '../../core/dist/host-daemon.js';
import {
  collectTelemetry,
  platformHostFacts,
  readMemAvailableBytes,
  reportedPaths,
} from '../dist/packages/host-daemon/src/telemetry.js';

/**
 * Telemetry tests run entirely over an injected seam of platform facts, so no
 * assertion here depends on the numbers this machine happens to have. The one
 * test that touches the real platform only checks that a reading is well formed
 * and read-only.
 */

const GIB = 1024 ** 3;

/** A complete, healthy set of facts, for tests that then break one of them. */
function facts(overrides = {}) {
  return {
    nowMs: 1_000,
    totalMemoryBytes: () => hostBytes(64 * GIB, 'os.totalmem'),
    availableMemoryBytes: () => hostBytes(32 * GIB, 'os.freemem'),
    logicalCores: () => 16,
    cpuModel: () => 'Test CPU',
    loadAverage: () => [0.5, 0.4, 0.3],
    uptimeSeconds: () => 86_400,
    filesystemCapacity: (path) => ({
      total: hostBytes(512 * GIB, 'fs.statfs(' + path + ').blocks'),
      // Blocks reserved for the superuser are not capacity a job can use.
      available: hostBytes(128 * GIB, 'fs.statfs(' + path + ').bavail'),
    }),
    ...overrides,
  };
}

test('a reading keeps what the host said and names the platform fact behind it', () => {
  const telemetry = collectTelemetry(facts(), ['/', '/workspace']);
  assert.deepEqual(telemetry.problems, []);
  assert.equal(telemetry.memory.total.bytes, 64 * GIB);
  assert.equal(telemetry.memory.total.source, 'os.totalmem');
  assert.equal(telemetry.memory.available.bytes, 32 * GIB);
  assert.equal(telemetry.uptimeSeconds, 86_400);
  assert.equal(telemetry.cpu.logicalCores, 16);
  assert.equal(telemetry.cpu.model, 'Test CPU');
  assert.deepEqual([...telemetry.cpu.loadAverage], [0.5, 0.4, 0.3]);
  assert.deepEqual(telemetry.filesystems.map((entry) => entry.path), ['/', '/workspace']);
  assert.equal(telemetry.filesystems[0].available.source, 'fs.statfs(/).bavail');
  assert.equal(telemetry.filesystems[0].available.ok, true);
});

test('a path repeated in the configuration is measured once', () => {
  const telemetry = collectTelemetry(facts(), ['/', '/workspace', '/']);
  assert.deepEqual(telemetry.filesystems.map((entry) => entry.path), ['/', '/workspace']);
  assert.deepEqual(reportedPaths({ filesystems: ['/'], workspaces: ['/workspace', '/'] }), ['/', '/workspace']);
});

test('a fact that throws costs only its own measurement', () => {
  // One unreadable workspace must not cost the host its memory figures: a
  // degraded reading is useful, a missing one is not.
  const telemetry = collectTelemetry(facts({
    availableMemoryBytes: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); },
    filesystemCapacity: (path) => {
      if (path !== '/') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return {
        total: hostBytes(512 * GIB, 'fs.statfs(' + path + ').blocks'),
        available: hostBytes(128 * GIB, 'fs.statfs(' + path + ').bavail'),
      };
    },
  }), ['/', '/workspace']);

  assert.equal(telemetry.memory.total.ok, true);
  assert.deepEqual(telemetry.memory.available, {
    ok: false,
    reason: 'unreadable',
    detail: 'available memory could not be read (ENOENT: no such file)',
  });
  assert.deepEqual(telemetry.problems, [
    '/workspace available is unavailable (unreadable)',
    '/workspace total is unavailable (unreadable)',
    'available memory is unavailable (unreadable)',
  ]);
  assert.deepEqual(telemetry.problems, [...telemetry.problems].sort(), 'problems are sorted, so two readings compare');
});

test('a fact that answers with something that is not a measurement is called malformed, not believed', () => {
  const telemetry = collectTelemetry(facts({
    totalMemoryBytes: () => ({ ok: true, bytes: -5, source: 'os.totalmem' }),
    logicalCores: () => 'sixteen',
    loadAverage: () => [0.5, 0.4],
    uptimeSeconds: () => -1,
    cpuModel: () => '',
  }), ['/']);

  assert.equal(telemetry.memory.total.ok, false);
  assert.equal(telemetry.memory.total.reason, 'malformed');
  assert.equal(telemetry.cpu.logicalCores, null);
  assert.equal(telemetry.cpu.model, null);
  assert.equal(telemetry.cpu.loadAverage, null);
  assert.equal(telemetry.uptimeSeconds, null);
  assert.deepEqual(telemetry.problems, [
    'cpu cores are unavailable (malformed)',
    'host uptime is unavailable (malformed)',
    'load average is unavailable (malformed)',
    'total memory is unavailable (malformed)',
  ]);
  // A measurement that is genuinely absent is reported as absent, never as zero.
  assert.notEqual(telemetry.memory.total.ok === true && telemetry.memory.total.bytes === 0, true);
});

test('a fact that answers with nothing at all is absent, not a default', () => {
  const telemetry = collectTelemetry(facts({ logicalCores: () => null, cpuModel: () => null }), ['/']);
  assert.equal(telemetry.cpu.logicalCores, null);
  assert.equal(telemetry.cpu.model, null);
  // Nothing the host declined to say is a problem it named; a Linux host with no
  // load average is a fact about the platform, not a fault.
  assert.deepEqual(telemetry.problems, []);
});

test('an unavailable measurement names one of the known reasons', () => {
  for (const reason of ['not-configured', 'unreadable', 'malformed', 'unsupported']) {
    const telemetry = collectTelemetry(facts({
      filesystemCapacity: () => ({
        total: unavailableHostBytes(reason, 'because'),
        available: unavailableHostBytes(reason, 'because'),
      }),
    }), ['/']);
    assert.equal(telemetry.filesystems[0].total.reason, reason);
    assert.equal(telemetry.problems.length, 2);
  }
});

function withFixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-daemon-meminfo-'));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the kernel figure for available memory is parsed, and junk in it falls back', () => {
  withFixture((root) => {
    const good = join(root, 'meminfo');
    writeFileSync(good, 'MemTotal:       65536000 kB\nMemFree:        1000 kB\nMemAvailable:   32768000 kB\n');
    assert.equal(readMemAvailableBytes(good), 32_768_000 * 1024);

    // A platform with no MemAvailable line, an unparseable one, and an
    // unreadable file are three different absences, and all of them are `null`
    // so the caller falls back rather than guessing.
    const noLine = join(root, 'meminfo-no-line');
    writeFileSync(noLine, 'MemTotal: 65536000 kB\n');
    const badLine = join(root, 'meminfo-bad');
    writeFileSync(badLine, 'MemAvailable:   lots kB\n');
    assert.equal(readMemAvailableBytes(noLine), null);
    assert.equal(readMemAvailableBytes(badLine), null);
    assert.equal(readMemAvailableBytes(join(root, 'absent')), null);
  });
});

test('the real platform produces a well-formed, read-only reading', () => {
  const factsFromPlatform = platformHostFacts({ nowMs: 0, memInfoPath: join(tmpdir(), 'no-meminfo-here') });
  const telemetry = collectTelemetry(factsFromPlatform, ['/']);
  assert.equal(telemetry.memory.total.ok, true, 'os.totalmem answers everywhere Antonina runs');
  assert.equal(telemetry.memory.total.source, 'os.totalmem');
  assert.equal(telemetry.memory.available.source, 'os.freemem',
    'without /proc/meminfo the reading falls back to the platform figure and says so');
  assert.equal(telemetry.filesystems[0].total.ok, true);
  assert.equal(telemetry.filesystems[0].available.ok, true);
  assert.equal(telemetry.cpu.logicalCores > 0, true);
  assert.equal(telemetry.uptimeSeconds > 0, true);

  // A path that cannot exist is reported as absent, and the rest of the reading
  // survives it.
  const withMissing = collectTelemetry(factsFromPlatform, ['/no/such/path']);
  assert.equal(withMissing.filesystems[0].total.ok, false);
  assert.equal(withMissing.filesystems[0].total.reason, 'unreadable');
  assert.equal(withMissing.memory.total.ok, true);
});
