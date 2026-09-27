import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPACITY_OVERRIDE_ENV,
  DEFAULT_MIN_HEADROOM_BYTES,
  MIN_HEADROOM_ENV,
  PRESSURE_WARNING_AVG10,
  checkHostLaunchCapacity,
  capacityOverrideRequested,
  derivedMinHeadroomBytes,
  evaluateLaunchCapacity,
  formatBytes,
  readHostCapacity,
  readOomCounters,
  resolveMinHeadroomBytes,
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

test('a. a cgroup with headroom below the threshold refuses, and one above it is accepted', () => {
  // 30 GiB limit, 1 GiB used => 29 GiB headroom: well above the 2 GiB default.
  const roomy = checkHostLaunchCapacity({ readText: fakeCgroup(), env: {} });
  assert.equal(roomy.outcome, 'ok');
  assert.equal(roomy.capacity.headroomBytes, 29 * GIB);
  assert.equal(roomy.capacity.limitBytes, 30 * GIB);

  // Same limit, 29.9 GiB used => ~0.1 GiB headroom: below the threshold.
  const tight = checkHostLaunchCapacity({
    readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': String(30 * GIB - Math.floor(0.1 * GIB)) }),
    env: {},
  });
  assert.equal(tight.outcome, 'refused');
  assert.ok(tight.capacity.headroomBytes < DEFAULT_MIN_HEADROOM_BYTES);
});

test('a. the decision compares against the measured headroom, not a guess', () => {
  // Exactly at the threshold is accepted; one byte under it is refused. This is
  // the boundary a bad comparison (<= instead of <) would get wrong.
  const limit = 10 * GIB;
  const at = evaluateLaunchCapacity(
    readHostCapacity({
      readText: fakeCgroup({
        '/sys/fs/cgroup/memory.max': String(limit),
        '/sys/fs/cgroup/memory.current': String(limit - 2 * GIB),
      }),
    }),
    { thresholdBytes: 2 * GIB, env: {} },
  );
  assert.equal(at.outcome, 'ok');

  const under = evaluateLaunchCapacity(
    readHostCapacity({
      readText: fakeCgroup({
        '/sys/fs/cgroup/memory.max': String(limit),
        '/sys/fs/cgroup/memory.current': String(limit - 2 * GIB + 1),
      }),
    }),
    { thresholdBytes: 2 * GIB, env: {} },
  );
  assert.equal(under.outcome, 'refused');
});

test('b. the threshold is configurable, in bytes and with a unit suffix', () => {
  const capacity = readHostCapacity({
    readText: fakeCgroup({
      '/sys/fs/cgroup/memory.max': String(30 * GIB),
      '/sys/fs/cgroup/memory.current': String(30 * GIB - 4 * GIB),
    }),
  });
  // 4 GiB of headroom: refused at a 8 GiB threshold, accepted at 2 GiB.
  assert.equal(evaluateLaunchCapacity(capacity, { thresholdBytes: 8 * GIB, env: {} }).outcome, 'refused');
  assert.equal(evaluateLaunchCapacity(capacity, { thresholdBytes: 2 * GIB, env: {} }).outcome, 'ok');

  assert.equal(resolveMinHeadroomBytes({}).bytes, DEFAULT_MIN_HEADROOM_BYTES);
  assert.equal(resolveMinHeadroomBytes({}).configured, false);
  assert.deepEqual(resolveMinHeadroomBytes({ [MIN_HEADROOM_ENV]: '536870912' }), { bytes: 512 * 1024 * 1024, configured: true });
  assert.deepEqual(resolveMinHeadroomBytes({ [MIN_HEADROOM_ENV]: '2G' }), { bytes: 2 * GIB, configured: true });
  assert.deepEqual(resolveMinHeadroomBytes({ [MIN_HEADROOM_ENV]: '512M' }), { bytes: 512 * 1024 * 1024, configured: true });
  assert.deepEqual(resolveMinHeadroomBytes({ [MIN_HEADROOM_ENV]: '0' }), { bytes: 0, configured: true });
});

test('b. a misconfigured threshold is refused loudly instead of silently defaulted', () => {
  // A typo that quietly fell back to the default would be a guard that cannot
  // fail, which is the exact defect class this change exists to remove.
  assert.throws(() => resolveMinHeadroomBytes({ [MIN_HEADROOM_ENV]: 'lots' }), /MIN_HEADROOM|must be a whole number/);
  assert.throws(() => resolveMinHeadroomBytes({ [MIN_HEADROOM_ENV]: '-1' }), /must be a whole number/);
  assert.throws(() => resolveMinHeadroomBytes({ [MIN_HEADROOM_ENV]: '1.5G' }), /must be a whole number/);
});

test('b. a zero threshold disables the refusal without disabling the reading', () => {
  const decision = checkHostLaunchCapacity({
    readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': String(30 * GIB - 1) }),
    env: { [MIN_HEADROOM_ENV]: '0' },
  });
  assert.equal(decision.outcome, 'ok');
  assert.equal(decision.thresholdBytes, 0);
  // The measurement is still reported; only the refusal is off.
  assert.equal(decision.capacity.headroomBytes, 1);
  assert.match(decision.reason, /1 B/);
});

test('c. memory.max reading "max" degrades to a stated reason and never a number', () => {
  const capacity = readHostCapacity({ readText: fakeCgroup({ '/sys/fs/cgroup/memory.max': 'max\n' }) });
  assert.equal(capacity.source, 'degraded');
  assert.equal(capacity.degradedReason, 'no_limited_cgroup');
  assert.equal(capacity.headroomBytes, null);
  assert.equal(capacity.limitBytes, null);
  assert.match(capacity.reason, /"max"/);
  assert.match(capacity.reason, /no hard memory limit/);

  const decision = evaluateLaunchCapacity(capacity, { thresholdBytes: 2 * GIB, env: {} });
  // Not a refusal: refusing a host whose model could not be read would make the
  // guard permanently unlaunchable rather than safer.
  assert.equal(decision.outcome, 'unknown');
  assert.equal(decision.reason, capacity.reason);
});

test('c. a missing cgroup v2 hierarchy degrades with the path it tried', () => {
  const noV2 = readHostCapacity({
    readText: fakeCgroup({ '/proc/self/cgroup': '12:pids:/user.slice\n11:cpu,cpuacct:/\n' }),
  });
  assert.equal(noV2.source, 'degraded');
  assert.equal(noV2.degradedReason, 'cgroup_v2_unavailable');
  assert.equal(noV2.headroomBytes, null);
  assert.match(noV2.reason, /no cgroup v2 line/);
  assert.equal(evaluateLaunchCapacity(noV2, { env: {} }).outcome, 'unknown');
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

test('d. the refusal names the measured headroom, the threshold and the escape hatch', () => {
  const decision = checkHostLaunchCapacity({
    readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': String(30 * GIB - Math.floor(0.53 * GIB)) }),
    env: {},
  });
  assert.equal(decision.outcome, 'refused');
  // The headroom number must be the one that was measured, not a rounded or
  // remembered one.
  const headroom = decision.capacity.headroomBytes;
  assert.ok(Math.abs(headroom - 0.53 * GIB) < 1024 * 1024);
  assert.match(decision.reason, new RegExp(`headroom ${escape(formatBytes(headroom))}`));
  assert.match(decision.reason, /below the required minimum 2\.00 GiB/);
  // The escape hatch is named in the message, with the value to use.
  assert.match(decision.reason, new RegExp(`${CAPACITY_OVERRIDE_ENV}=1`));
  // And the boundary is stated, so an operator does not think the guard stole
  // somebody else's memory to make room.
  assert.match(decision.reason, /nothing was killed, throttled, or reordered/);
  // The supporting readings are in the message too.
  assert.match(decision.reason, /memory\.max 30\.00 GiB/);
  assert.match(decision.reason, /pressure full avg10=/);
});

test('4. the escape hatch proceeds on operator request and says it was used', () => {
  assert.equal(capacityOverrideRequested({}), false);
  assert.equal(capacityOverrideRequested({ [CAPACITY_OVERRIDE_ENV]: '1' }), true);
  assert.equal(capacityOverrideRequested({ [CAPACITY_OVERRIDE_ENV]: 'true' }), true);
  assert.equal(capacityOverrideRequested({ [CAPACITY_OVERRIDE_ENV]: 'maybe' }), false);

  const decision = checkHostLaunchCapacity({
    readText: fakeCgroup({ '/sys/fs/cgroup/memory.current': String(30 * GIB - 1) }),
    env: { [CAPACITY_OVERRIDE_ENV]: '1' },
  });
  assert.equal(decision.outcome, 'ok');
  assert.equal(decision.overrideApplied, true);
  assert.match(decision.reason, new RegExp(CAPACITY_OVERRIDE_ENV));
  assert.match(decision.reason, /on operator request/);
});

test('4. transient pressure with adequate headroom warns but still launches', () => {
  // Refusing here would make a momentarily busy host permanently unlaunchable,
  // which is the failure mode the issue warns about.
  const decision = checkHostLaunchCapacity({
    readText: fakeCgroup({ '/proc/pressure/memory': 'some avg10=30.00\nfull avg10=25.03 avg60=10.0 avg300=1.0\n' }),
    env: {},
  });
  assert.equal(decision.outcome, 'warning');
  assert.equal(decision.capacity.pressureFullAvg10, 25.03);
  assert.ok(25.03 >= PRESSURE_WARNING_AVG10);
  assert.match(decision.reason, /transient memory pressure/);

  // Below the PSI warning line, the same host is simply ok.
  const quiet = checkHostLaunchCapacity({
    readText: fakeCgroup({ '/proc/pressure/memory': 'some avg10=0.10\nfull avg10=0.05\n' }),
    env: {},
  });
  assert.equal(quiet.outcome, 'ok');
});

test('a low-headroom refusal is still a refusal under heavy pressure, and the override still wins', () => {
  const args = {
    readText: fakeCgroup({
      '/sys/fs/cgroup/memory.current': String(30 * GIB - 1024),
      '/proc/pressure/memory': 'some avg10=90.00\nfull avg10=88.00\n',
    }),
  };
  assert.equal(checkHostLaunchCapacity({ ...args, env: {} }).outcome, 'refused');
  assert.equal(checkHostLaunchCapacity({ ...args, env: { [CAPACITY_OVERRIDE_ENV]: '1' } }).outcome, 'ok');
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
  assert.equal(evaluateLaunchCapacity(capacity, { env: {} }).outcome, 'refused');
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
    const decision = evaluateLaunchCapacity(capacity, { env: {} });
    assert.equal(decision.outcome, 'unknown');
    assert.ok(decision.reason.length > 20);
  }
});

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


test('b. the default threshold is derived from the limit, not from a fixed constant', () => {
  // 30 GiB limit: the ceiling still applies, so the derived default is 2 GiB
  // and behaviour on a host of this size is unchanged.
  assert.equal(derivedMinHeadroomBytes(30 * GIB), DEFAULT_MIN_HEADROOM_BYTES);
  // Below the size where 1/8 of the limit is under 2 GiB, the limit decides.
  // This is the case a fixed 2 GiB default got wrong: on a 1 GiB container it
  // could never be satisfied, so the guard refused every launch and the operator
  // override became the only way to start an agent.
  assert.equal(derivedMinHeadroomBytes(GIB), Math.floor(GIB / 8));
  assert.equal(derivedMinHeadroomBytes(4 * GIB), Math.floor(4 * GIB / 8));
  assert.ok(derivedMinHeadroomBytes(GIB) < GIB, 'a small host must stay launchable');
  // The large-host end: a pure fraction would demand 32 GiB free on a 256 GiB
  // build host and refuse launches on exactly the machines that run builds.
  assert.equal(derivedMinHeadroomBytes(256 * GIB), DEFAULT_MIN_HEADROOM_BYTES);
  // No readable limit is not a licence to invent one, and the ceiling stands.
  assert.equal(derivedMinHeadroomBytes(null), DEFAULT_MIN_HEADROOM_BYTES);
});

test('b. a small host is launchable at a fixed threshold would have refused it', () => {
  // The regression this whole change exists for, asserted through the decision
  // rather than through the helper: a 1 GiB cgroup at zero occupancy must be
  // accepted, because a 2 GiB default is unreachable there.
  const empty = readHostCapacity({
    readText: fakeCgroup({
      '/sys/fs/cgroup/memory.max': String(GIB),
      '/sys/fs/cgroup/memory.current': '0',
    }),
  });
  const decision = evaluateLaunchCapacity(empty, { env: {} });
  assert.equal(decision.outcome, 'ok');
  assert.equal(decision.thresholdBytes, Math.floor(GIB / 8));
  assert.equal(decision.thresholdDerived, true);
  assert.equal(decision.thresholdUnsatisfiable, false);
  // The number in force is accounted for rather than silently different.
  assert.match(decision.reason, /derived as 1\/8 of the 1\.00 GiB cgroup limit/);
});

test('b. a small host still refuses on its own measurements', () => {
  // The other half: deriving the default must not make the guard permissive.
  // 1 GiB cgroup, 900 MiB used leaves ~124 MiB, under the derived 128 MiB.
  const capacity = readHostCapacity({
    readText: fakeCgroup({
      '/sys/fs/cgroup/memory.max': String(GIB),
      '/sys/fs/cgroup/memory.current': String(900 * 1024 * 1024),
    }),
  });
  const decision = evaluateLaunchCapacity(capacity, { env: {} });
  assert.equal(decision.thresholdBytes, Math.floor(GIB / 8));
  assert.equal(decision.outcome, 'refused');
  assert.equal(decision.overrideApplied, false);
  // And a refusal on a derived threshold still names the hatch.
  assert.match(decision.reason, new RegExp(CAPACITY_OVERRIDE_ENV));
});

test('b. a threshold above the limit is reported, not silently changed', () => {
  // A configured value is the operator's decision. Overriding it would make a
  // deliberately unlaunchable host quietly launchable, and would break the
  // determinism the CLI suite builds on when it forces a refusal with a huge
  // threshold. So the number stands and the impossibility is stated.
  const capacity = readHostCapacity({
    readText: fakeCgroup({
      '/sys/fs/cgroup/memory.max': String(30 * GIB),
      '/sys/fs/cgroup/memory.current': String(30 * GIB - 4 * GIB),
    }),
  });
  const decision = evaluateLaunchCapacity(capacity, { env: { [MIN_HEADROOM_ENV]: '1T' } });
  // `T` is 1024^4, so this is 1 TiB, which is the number the reason string
  // below asserts on. Written the other way round it would read as 1 PiB and
  // pin a value the parser never produces.
  assert.equal(decision.thresholdBytes, 1024 * GIB);
  assert.equal(decision.thresholdConfigured, true);
  assert.equal(decision.thresholdDerived, false);
  assert.equal(decision.thresholdUnsatisfiable, true);
  assert.equal(decision.outcome, 'refused');
  assert.match(decision.reason, /at or above the 30\.00 GiB cgroup limit/);
  // The value the operator set is still what the refusal names.
  assert.match(decision.reason, /below the required minimum 1\.00 TiB/);
});

test('b. a deliberate threshold this host can reach is left exactly as configured', () => {
  // 8 GiB on a 30 GiB cgroup is a real choice and must survive untouched; the
  // headroom here is 4 GiB, so it refuses on the operator's number.
  const capacity = readHostCapacity({
    readText: fakeCgroup({
      '/sys/fs/cgroup/memory.max': String(30 * GIB),
      '/sys/fs/cgroup/memory.current': String(30 * GIB - 4 * GIB),
    }),
  });
  const decision = evaluateLaunchCapacity(capacity, { env: { [MIN_HEADROOM_ENV]: '8G' } });
  assert.equal(decision.thresholdBytes, 8 * GIB);
  assert.equal(decision.thresholdDerived, false);
  assert.equal(decision.thresholdUnsatisfiable, false);
  assert.equal(decision.outcome, 'refused');
  assert.doesNotMatch(decision.reason, /at or above the .* cgroup limit/);
  assert.doesNotMatch(decision.reason, /derived as 1\/8/);
});

test('b. a large host keeps the portable default rather than a fraction of its limit', () => {
  // 256 GiB, 40 GiB used: 216 GiB free. A pure 1/8 fraction would demand 32 GiB
  // and this would still pass, but the point of the ceiling is that the default
  // does not drift upward on bigger machines.
  const capacity = readHostCapacity({
    readText: fakeCgroup({
      '/sys/fs/cgroup/memory.max': String(256 * GIB),
      '/sys/fs/cgroup/memory.current': String(40 * GIB),
    }),
  });
  const decision = evaluateLaunchCapacity(capacity, { env: {} });
  assert.equal(decision.thresholdBytes, DEFAULT_MIN_HEADROOM_BYTES);
  assert.equal(decision.thresholdDerived, false);
  assert.equal(decision.outcome, 'ok');
  assert.doesNotMatch(decision.reason, /derived as 1\/8/);
});
