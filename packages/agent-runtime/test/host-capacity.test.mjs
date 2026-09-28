import assert from 'node:assert/strict';
import test from 'node:test';

import * as hostCapacity from '../dist/packages/agent-runtime/src/host-capacity.js';
import {
  describeHostCapacity,
  formatBytes,
  readHostCapacity,
  readOomCounters,
} from '../dist/packages/agent-runtime/src/host-capacity.js';

const GIB = 1024 * 1024 * 1024;

// A synthetic /sys/fs/cgroup. Every reading in this file goes through this map,
// so no case depends on the host's live memory counters.
function cgroupFiles(overrides = {}) {
  return new Map(Object.entries({
    '/sys/fs/cgroup/memory.max': '32212254720',
    '/sys/fs/cgroup/memory.current': String(1 * GIB),
    '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 2476825\noom 39\noom_kill 3\noom_group_kill 0\n',
    '/proc/self/cgroup': '0::/\n',
    '/proc/pressure/memory': 'some avg10=1.16 avg60=0.56 avg300=0.70 total=5600622157\nfull avg10=1.16 avg60=0.56 avg300=0.63 total=4874730146\n',
    ...overrides,
  }));
}

// A null override deletes the file, which is how an unreadable or absent file is
// expressed without pretending it holds a value.
function fakeCgroup(overrides = {}) {
  const files = cgroupFiles(overrides);
  for (const [path, value] of [...files]) {
    if (value === undefined || value === null) files.delete(path);
  }
  return (path) => files.get(path) ?? null;
}
test('c. memory.max reading "max" degrades to a stated reason and never a number', () => {
  const capacity = readHostCapacity({ readText: fakeCgroup({ '/sys/fs/cgroup/memory.max': 'max\n' }) });
  assert.equal(capacity.source, 'degraded');
  assert.equal(capacity.degradedReason, 'no_limited_cgroup');
  assert.equal(capacity.headroomBytes, null);
  assert.equal(capacity.limitBytes, null);
  assert.match(capacity.reason, /"max"/);
  assert.match(capacity.reason, /no hard memory limit/);

  // Not a refusal: refusing a host whose model could not be read would make the
  // guard permanently unlaunchable rather than safer.
});

test('c. a missing cgroup v2 hierarchy degrades with the path it tried', () => {
  const noV2 = readHostCapacity({
    readText: fakeCgroup({ '/proc/self/cgroup': '12:pids:/user.slice\n11:cpu,cpuacct:/\n' }),
  });
  assert.equal(noV2.source, 'degraded');
  assert.equal(noV2.degradedReason, 'cgroup_v2_unavailable');
  assert.equal(noV2.headroomBytes, null);
  assert.match(noV2.reason, /no cgroup v2 line/);
});

test('c. unreadable cgroup files degrade to a stated reason rather than a guess', () => {
  const cases = [
    ['/proc/self/cgroup', 'proc_self_cgroup_unreadable', /cannot read/],
    ['/sys/fs/cgroup/memory.max', 'memory_max_unreadable', /memory\.max is unreadable/],
    ['/sys/fs/cgroup/memory.current', 'memory_current_unreadable', /memory\.current is unreadable/],
  ];
  for (const [missing, reason, pattern] of cases) {
    const capacity = readHostCapacity({ readText: fakeCgroup({ [missing]: null }) });
    assert.equal(capacity.source, 'degraded', `${missing} should degrade`);
    assert.equal(capacity.degradedReason, reason);
    assert.equal(capacity.headroomBytes, null);
    assert.match(capacity.reason, pattern);
  }
});

test('c. a cgroup path that does not exist is named, not treated as unlimited', () => {
  // A nonexistent cgroup and an unreadable memory.max are indistinguishable
  // through a reader, so the record must name the path it tried rather than
  // claim to know which of the two it was.
  const capacity = readHostCapacity({
    readText: fakeCgroup({ '/proc/self/cgroup': '0::/does-not-exist\n' }),
  });
  assert.equal(capacity.source, 'degraded');
  assert.equal(capacity.degradedReason, 'memory_max_unreadable');
  assert.match(capacity.reason, /\/does-not-exist\/memory\.max/);
  assert.equal(capacity.headroomBytes, null);
});

test('c. a malformed byte count is never coerced to a limit', () => {
  for (const [raw, reason] of [['not-a-number\n', 'memory_max_malformed'], ['92233720368547758079999\n', 'memory_max_malformed']]) {
    const capacity = readHostCapacity({ readText: fakeCgroup({ '/sys/fs/cgroup/memory.max': raw }) });
    assert.equal(capacity.degradedReason, reason);
    assert.equal(capacity.limitBytes, null);
  }
  const current = readHostCapacity({ readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': 'lots\n' }) });
  assert.equal(current.degradedReason, 'memory_current_malformed');
  assert.equal(current.headroomBytes, null);
});

test('c. a nested cgroup is read at its own path, not at the root', () => {
  const files = new Map([
    ['/proc/self/cgroup', '0::/user.slice/session.scope\n'],
    ['/sys/fs/cgroup/user.slice/session.scope/memory.max', `${8 * GIB}\n`],
    ['/sys/fs/cgroup/user.slice/session.scope/memory.current', `${7 * GIB}\n`],
    ['/sys/fs/cgroup/user.slice/session.scope/memory.events', 'oom 4\noom_kill 1\n'],
    ['/sys/fs/cgroup/memory.max', `${64 * GIB}\n`],
    ['/sys/fs/cgroup/memory.current', '0\n'],
  ]);
  const capacity = readHostCapacity({ readText: (path) => files.get(path) ?? null });
  assert.equal(capacity.cgroupPath, '/sys/fs/cgroup/user.slice/session.scope');
  assert.equal(capacity.limitBytes, 8 * GIB);
  assert.equal(capacity.headroomBytes, 1 * GIB);
  assert.equal(capacity.oom, 4);
  assert.equal(capacity.oomKill, 1);
});

test('OOM counters are read for the death bracket, and their absence is reported as null', () => {
  assert.deepEqual(readOomCounters({ readText: fakeCgroup(), env: {} }), { oom: 39, oomKill: 3 });

  const noEvents = fakeCgroup({ '/sys/fs/cgroup/memory.events': null });
  assert.equal(readOomCounters({ readText: noEvents, env: {} }), null);

  // "No events file" must not read as "zero OOM kills".
  const capacity = readHostCapacity({ readText: noEvents });
  assert.equal(capacity.oom, null);
  assert.equal(capacity.oomKill, null);
});

test('a missing PSI file leaves pressure unknown without degrading the cgroup reading', () => {
  const capacity = readHostCapacity({ readText: fakeCgroup({ '/proc/pressure/memory': null }) });
  assert.equal(capacity.source, 'cgroup_v2');
  assert.equal(capacity.headroomBytes, 29 * GIB);
  assert.equal(capacity.pressureFullAvg10, null);
});

test('usage above the limit clamps headroom to zero rather than going negative', () => {
  const capacity = readHostCapacity({
    readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': String(30 * GIB + 5 * GIB) }),
  });
  assert.equal(capacity.headroomBytes, 0);
});

test('every degraded capacity produces a non-empty stated reason', () => {
  const fixtures = [
    fakeCgroup({ '/proc/self/cgroup': null }),
    fakeCgroup({ '/proc/self/cgroup': '11:cpu:/\n' }),
    fakeCgroup({ '/sys/fs/cgroup/memory.max': null }),
    fakeCgroup({ '/sys/fs/cgroup/memory.max': 'max\n' }),
    fakeCgroup({ '/sys/fs/cgroup/memory.max': 'junk\n' }),
    fakeCgroup({ '/sys/fs/cgroup/memory.current': null }),
    fakeCgroup({ '/sys/fs/cgroup/memory.current': 'junk\n' }),
  ];
  for (const readText of fixtures) {
    const capacity = readHostCapacity({ readText });
    assert.equal(capacity.source, 'degraded');
    assert.notEqual(capacity.degradedReason, null);
    assert.ok(capacity.reason.length > 20, `reason too short: ${capacity.reason}`);
    assert.equal(capacity.headroomBytes, null);
  }
});

// The intent record "Agent launch is not host-capacity policy" makes a claim
// about this module's *shape*, not only about a call site's behaviour, so the
// tests below pin the shape. A guard can be reintroduced by adding one export,
// and every behavioural test in this file would still pass, because none of them
// asserts that the admission API is absent.

test('the module exposes no launch-admission API', () => {
  // Each of these was the entry point by which a valid launch could be refused,
  // delayed or suppressed on a host-capacity heuristic. Their absence is the
  // intent record's requirement, so it is asserted directly rather than inferred
  // from the behaviour of some caller.
  for (const name of [
    'evaluateLaunchCapacity',
    'checkHostLaunchCapacity',
    'capacityRefusalMessage',
    'capacityOverrideRequested',
    'resolveMinHeadroomBytes',
    'derivedMinHeadroomBytes',
    'thresholdUnsatisfiable',
    'HostCapacityRefusalError',
    'DEFAULT_MIN_HEADROOM_BYTES',
    'MIN_HEADROOM_LIMIT_DIVISOR',
    'MIN_HEADROOM_ENV',
    'CAPACITY_OVERRIDE_ENV',
    'PRESSURE_WARNING_AVG10',
  ]) {
    assert.equal(name in hostCapacity, false, `${name} must not be exported: it is launch-admission policy`);
  }
});

test('no exported symbol takes or returns a launch decision', () => {
  // A guard could be reintroduced under a new name. The property that cannot be
  // reintroduced under any name is that nothing here decides: every export is a
  // reading, a rendering, or a description of a reading.
  for (const [name, value] of Object.entries(hostCapacity)) {
    if (typeof value !== 'function') continue;
    assert.doesNotMatch(
      name,
      /refus|guard|admit|admission|threshold|allow|deny|decide|evaluate|check/i,
      `${name} reads like a launch decision; this module must only observe`,
    );
  }
});

test('a completely full host is reported accurately and no worse than an empty one', () => {
  // The host this issue was written on. memory.current equals memory.max, so
  // headroom is zero: the reading must say exactly that, because the whole
  // purpose of keeping this module is that an operator can see the state a
  // SIGKILL happened in.
  const full = readHostCapacity({
    readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': '32212254720' }),
  });
  assert.equal(full.source, 'cgroup_v2');
  assert.equal(full.headroomBytes, 0);
  assert.equal(full.limitBytes, 30 * GIB);

  // The reading differs between a full and an empty host, which is the only
  // thing a diagnostic is required to do. Nothing here can act on the
  // difference, which is the property the intent record requires.
  const empty = readHostCapacity({
    readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': '0' }),
  });
  assert.equal(empty.headroomBytes, 30 * GIB);
  assert.notEqual(full.headroomBytes, empty.headroomBytes);
});

test('describeHostCapacity names the readings behind a death', () => {
  const described = describeHostCapacity(readHostCapacity({ readText: fakeCgroup() }));
  assert.match(described, /memory\.max 30\.00 GiB/);
  assert.match(described, /memory\.current 1\.00 GiB/);
  assert.match(described, /headroom 29\.00 GiB/);
  assert.match(described, /oom 39/);
  assert.match(described, /oom_kill 3/);
});

test('a degraded host describes itself by its reason and never by a number', () => {
  const degraded = describeHostCapacity(readHostCapacity({
    readText: fakeCgroup({ '/proc/self/cgroup': '12:pids:/user.slice\n' }),
  }));
  assert.match(degraded, /no cgroup v2/);
  assert.doesNotMatch(degraded, /headroom \d/);
});

test('formatBytes renders an unknown reading as unknown rather than as zero', () => {
  // A formatted 0 reads as a measurement. It is not one, and the earlier
  // capacity refusal text depended on the difference.
  assert.equal(formatBytes(null), 'unknown');
  assert.equal(formatBytes(Number.NaN), 'unknown');
  assert.equal(formatBytes(0), '0 B');
});
