// Source-only tests for the per-process /proc/<pid>/mountinfo live-reference
// probe. The fixture lines were captured verbatim from this host's real
// /proc/243/mountinfo (optional field shared:430, bind-mount root), /proc/1's
// mountinfo (root path /workspace, block-device source) and /proc/self's
// mountinfo. No ambient Antonina state is read or written: every probe is
// driven through an injected fake proc root under a test-owned temp dir.
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as cli from '../dist/packages/cli/src/agent.js';
import { liveReferenceReason } from '../dist/packages/agent-runtime/src/managed-build-cache.js';

const fixtureText = nodeFs.readFileSync(new URL('./fixtures/mountinfo.real.txt', import.meta.url), 'utf8');
const fixtureLines = fixtureText.trimEnd().split('\n');

function fakeProc(t) {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-mountinfo-probe-'));
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  nodeFs.writeFileSync(join(root, 'mounts'), 'tmpfs /dev/shm tmpfs rw 0 0\n');
  return root;
}

function fakePid(root, pid, options = {}) {
  const dir = join(root, pid);
  nodeFs.mkdirSync(dir, { recursive: true });
  if (options.stat !== undefined) nodeFs.writeFileSync(join(dir, 'stat'), options.stat);
  if (options.cwd !== undefined) nodeFs.symlinkSync(options.cwd, join(dir, 'cwd'));
  if (options.fds !== undefined) {
    const fdDir = join(dir, 'fd');
    nodeFs.mkdirSync(fdDir);
    for (const [fd, target] of Object.entries(options.fds)) nodeFs.symlinkSync(target, join(fdDir, fd));
  }
  if (options.mountinfo === 'directory') {
    nodeFs.mkdirSync(join(dir, 'mountinfo'));
  } else if (options.mountinfo !== undefined) {
    nodeFs.writeFileSync(join(dir, 'mountinfo'), options.mountinfo);
  }
}

const runningStat = '4242 (antonina-test) R 1 1001 1001 0 -1 4194560 0 0 0 0 20 0 10 0 0 0 0 0\n';

test('strict mountinfo parser handles real optional fields and separator position', () => {
  assert.equal(typeof cli.parseProcMountinfo, 'function', 'strict mountinfo parser must be exported');
  assert.equal(typeof cli.parseProcMountinfoLine, 'function', 'strict line parser must be exported');

  // The old probe asserted fields[5] === '-', which is the mount-options
  // field; every real fixture line fails that check.
  for (const line of fixtureLines) {
    assert.notEqual(line.trim().split(/\s+/)[5], '-');
  }

  const bind = cli.parseProcMountinfoLine(fixtureLines[0]);
  assert.equal(bind.root, '/user/1001/netns', 'root (field 4, 1-based) is the bind-mount underlying path');
  assert.equal(bind.mountPoint, '/run/user/1001/netns');
  assert.equal(bind.source, null, 'source is separator+2 (tmpfs), not the optional field at index 6');

  const device = cli.parseProcMountinfoLine(fixtureLines[1]);
  assert.equal(device.root, '/workspace');
  assert.equal(device.mountPoint, '/workspace');
  assert.equal(device.source, '/dev/loop9', 'source is read at the separator, not at a fixed index');

  const refs = cli.parseProcMountinfo(fixtureText);
  for (const expected of ['/user/1001/netns', '/run/user/1001/netns', '/dev/loop9', '/workspace', '/gnu/store', '/proc', '/sys/fs/cgroup']) {
    assert.ok(refs.includes(expected), `missing decoded reference ${expected}`);
  }
  assert.ok(liveReferenceReason('/user/1001/netns', { ok: true, references: refs, unknownProcesses: [] }) !== null,
    'a bind-mount root must be treated as a live reference');
});

test('strict mountinfo parser decodes escaped paths and rejects malformed lines', () => {
  const escaped = fixtureLines[1].replace('/workspace /workspace', '/work\\040space /workspace');
  assert.ok(cli.parseProcMountinfo(escaped).includes('/work space'));

  const bad = [
    '1882 1855 7:9 /workspace /workspace rw,relatime ext4 /dev/loop9 rw', // no separator
    '1882 1855 7:9 /workspace /workspace rw,relatime - ext4 /dev/loop9', // missing super options
    'x 1855 7:9 /workspace /workspace rw,relatime - ext4 /dev/loop9 rw', // non-numeric id
    '1882 1855 7:9 /workspace /workspace rw,relatime shared: - ext4 /dev/loop9 rw', // malformed optional field (empty value)
    '1882 1855 7:9 /bad\\4 /workspace rw,relatime - ext4 /dev/loop9 rw', // malformed escape
  ];
  for (const line of bad) {
    assert.throws(() => cli.parseProcMountinfoLine(line), /malformed|invalid/, `must reject: ${line}`);
  }
});

test('ENOENT/ESRCH verdict is conservative: only a gone or dead process is released', () => {
  assert.equal(typeof cli.procReleaseVerdict, 'function');
  assert.equal(cli.procReleaseVerdict(null), 'released', 'missing /proc entry means the process exited');
  assert.equal(cli.procReleaseVerdict(runningStat), 'alive', 'a vanished fd of a live process stays unknown');
  assert.equal(cli.procReleaseVerdict(runningStat.replace(' R ', ' Z ')), 'released', 'a zombie holds no fds or mounts');
  assert.equal(cli.procReleaseVerdict(undefined), 'unknown', 'unreadable stat must not be treated as gone');
  assert.equal(cli.procReleaseVerdict('not a stat line'), 'unknown', 'malformed stat must fail closed');
});

test('injected probe reads mountinfo references without false unknown pids', (t) => {
  assert.equal(typeof cli.hostLiveReferenceProbe, 'function', 'host probe must be exported');
  const root = fakeProc(t);
  fakePid(root, '1234', {
    stat: runningStat,
    cwd: '/tmp/antonina-probe-cwd',
    fds: { '3': '/state/antonina/build-cache/agentX/target' },
    mountinfo: fixtureText,
  });

  const result = cli.hostLiveReferenceProbe(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.unknownProcesses, []);
  for (const expected of ['/user/1001/netns', '/dev/loop9', '/tmp/antonina-probe-cwd', '/state/antonina/build-cache/agentX/target', '/dev/shm']) {
    assert.ok(result.references.includes(expected), `probe missed ${expected}`);
  }
  assert.notEqual(liveReferenceReason('/user/1001/netns', result), null, 'bind-mount root reference must block retirement');
  assert.notEqual(liveReferenceReason('/state/antonina/build-cache/agentX/target', result), null, 'fd reference must block retirement');
});

test('unreadable mountinfo marks the pid unknown and the caller fails closed', (t) => {
  const root = fakeProc(t);
  fakePid(root, '2345', {
    stat: runningStat,
    cwd: '/tmp/antonina-probe-cwd',
    fds: { '3': '/tmp/antonina-probe-fd' },
    mountinfo: 'directory',
  });

  const result = cli.hostLiveReferenceProbe(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.unknownProcesses, ['2345']);
  assert.notEqual(liveReferenceReason('/state/antonina/build-cache/agentX/target', result), null,
    'an unknown pid must refuse deletion regardless of the collected references');
});

test('ENOENT for a vanished pid is ignored, but ENOENT for a live pid is unknown', (t) => {
  const root = fakeProc(t);
  // No stat/cwd/fd/mountinfo: the /proc entry went away mid-enumeration.
  fakePid(root, '3456', {});
  // Stat says the process is alive, but its fd directory vanished mid-probe.
  fakePid(root, '4567', { stat: runningStat, cwd: '/tmp/antonina-probe-cwd' });

  const result = cli.hostLiveReferenceProbe(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.unknownProcesses, ['4567']);
});
