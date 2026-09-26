import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import {
  AgentStateMissingError,
  MetadataLockError,
  MetadataReadError,
  MetadataWriteError,
  agentDir,
  createAgentDirectory,
  readMeta,
  stateRoot,
  updateMeta,
  withAgentLock,
  writeMeta,
} from '../dist/packages/agent-runtime/src/store.js';

function root(t) {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-store-'));
  t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
  return {
    env: { XDG_STATE_HOME: dir, XDG_CONFIG_HOME: join(dir, 'config') },
    home: join(dir, 'home'),
  };
}

function storeFs(overrides = {}) {
  return {
    closeSync: nodeFs.closeSync,
    fsyncSync: nodeFs.fsyncSync,
    mkdirSync: nodeFs.mkdirSync,
    openSync: nodeFs.openSync,
    readFileSync: nodeFs.readFileSync,
    renameSync: nodeFs.renameSync,
    rmSync: nodeFs.rmSync,
    unlinkSync: nodeFs.unlinkSync,
    writeFileSync: nodeFs.writeFileSync,
    ...overrides,
  };
}

function ioError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

// A lock record is only reclaimable when the process it names is provably gone.
// "Provably dead" and "still running" are only distinguishable from "waited out
// the whole retry budget" if the budget is bounded here, so this double refuses
// a further attempt at the lock path and lets the caller say which of the two
// happened.
function boundedLockAttempts(options, lockPath, budget) {
  const state = { attempts: 0, installed: [] };
  const fs = storeFs({
    openSync(path, flags, mode) {
      if (String(path) === lockPath) {
        state.attempts += 1;
        if (state.attempts > budget) {
          throw Object.assign(new Error(`lock at ${lockPath} unresolved after ${budget} attempts`), {
            code: 'ELOCKBUDGET',
          });
        }
      }
      return nodeFs.openSync(path, flags, mode);
    },
    writeFileSync(fd, ...rest) {
      if (typeof fd === 'number' && rest[0] !== undefined) state.installed.push(String(rest[0]));
      return nodeFs.writeFileSync(fd, ...rest);
    },
  });
  return { options: { ...options, fs }, state };
}

test('state root follows XDG_STATE_HOME with home fallback', () => {
  assert.equal(stateRoot({ env: { XDG_STATE_HOME: '/x/state' }, home: '/home/u' }), '/x/state/antonina');
  assert.equal(stateRoot({ env: {}, home: '/home/u' }), '/home/u/.local/state/antonina');
});

test('metadata round-trips and mismatched durable identity fails closed', (t) => {
  const options = root(t);
  assert.equal(createAgentDirectory('a11d', options), true);
  assert.equal(createAgentDirectory('a11d', options), false);
  writeMeta('a11d', idleMeta('a11d', '/tmp', null, 5), options);
  assert.equal(readMeta('a11d', options)?.id, 'a11d');

  nodeFs.writeFileSync(join(agentDir('a11d', options), 'meta.json'), JSON.stringify({ id: 'beef' }));
  assert.throws(() => readMeta('a11d', options), MetadataReadError);
});

test('read and write boundaries reject old incomplete or extended schemas', (t) => {
  const options = root(t);
  createAgentDirectory('a12', options);
  const canonical = idleMeta('a12', '/tmp', null, 5);
  writeMeta('a12', canonical, options);

  const old = { ...canonical, agent_version: 3 };
  assert.throws(
    () => writeMeta('a12', old, options),
    /refusing to persist incompatible or malformed metadata/,
  );

  const missing = { ...canonical };
  delete missing.active_runner;
  assert.throws(
    () => writeMeta('a12', missing, options),
    /refusing to persist incompatible or malformed metadata/,
  );

  const extended = { ...canonical, legacy: true };
  assert.throws(
    () => writeMeta('a12', extended, options),
    /refusing to persist incompatible or malformed metadata/,
  );

  nodeFs.writeFileSync(join(agentDir('a12', options), 'meta.json'), JSON.stringify(old));
  assert.throws(() => readMeta('a12', options), /unsupported managed-agent metadata version: 3/);

  nodeFs.writeFileSync(join(agentDir('a12', options), 'meta.json'), JSON.stringify(missing));
  assert.throws(() => readMeta('a12', options), /metadata fields are not canonical/);
});

test('missing metadata is absence only when the agent directory is gone', (t) => {
  const options = root(t);
  assert.equal(readMeta('a11d', options), null);

  createAgentDirectory('a11d', options);
  assert.throws(() => readMeta('a11d', options), /metadata file is missing/);
  nodeFs.writeFileSync(join(agentDir('a11d', options), 'meta.json'), '{');
  assert.throws(() => readMeta('a11d', options), /malformed JSON/);

  const failing = {
    ...options,
    fs: storeFs({
      readFileSync(path, encoding) {
        if (String(path).endsWith('meta.json')) throw ioError('EIO', 'injected read failure');
        return nodeFs.readFileSync(path, encoding);
      },
    }),
  };
  assert.throws(() => readMeta('a11d', failing), (error) =>
    error instanceof MetadataReadError && error.cause?.code === 'EIO');
});

test('updateMeta commits a locked metadata transition', async (t) => {
  const options = root(t);
  createAgentDirectory('aa', options);
  writeMeta('aa', idleMeta('aa', '/tmp', null, 5), options);
  const updated = await updateMeta('aa', (meta) => {
    meta.prompt_count = 1;
    meta.pending_prompt = 'hello';
  }, options);
  assert.equal(updated?.prompt_count, 1);
  assert.equal(readMeta('aa', options)?.pending_prompt, 'hello');
});

test('lock-open failure propagates and does not run the authoritative mutation', async (t) => {
  const options = root(t);
  createAgentDirectory('ab', options);
  writeMeta('ab', idleMeta('ab', '/tmp', null, 5), options);
  let mutated = false;
  const failing = {
    ...options,
    fs: storeFs({
      openSync(path, flags, mode) {
        if (String(path).endsWith('.lock')) throw ioError('EACCES', 'injected lock-open failure');
        return nodeFs.openSync(path, flags, mode);
      },
    }),
  };
  await assert.rejects(
    updateMeta('ab', () => { mutated = true; }, failing),
    MetadataLockError,
  );
  assert.equal(mutated, false);
  assert.equal(readMeta('ab', options)?.prompt_count, 0);
});

test('lock initialization failure propagates and removes the partial lock file', async (t) => {
  const options = root(t);
  createAgentDirectory('a0', options);
  writeMeta('a0', idleMeta('a0', '/tmp', null, 5), options);
  let mutated = false;
  const failing = {
    ...options,
    fs: storeFs({
      fsyncSync() {
        throw ioError('EIO', 'injected lock fsync failure');
      },
    }),
  };
  await assert.rejects(
    updateMeta('a0', () => { mutated = true; }, failing),
    MetadataLockError,
  );
  assert.equal(mutated, false);
  assert.equal(nodeFs.existsSync(join(agentDir('a0', options), '.lock')), false);
  assert.equal(readMeta('a0', options)?.prompt_count, 0);
});

test('persistence failure propagates instead of reporting a committed mutation', async (t) => {
  const options = root(t);
  createAgentDirectory('ac', options);
  writeMeta('ac', idleMeta('ac', '/tmp', null, 5), options);
  const failing = {
    ...options,
    fs: storeFs({
      renameSync() {
        throw ioError('EIO', 'injected rename failure');
      },
    }),
  };
  await assert.rejects(
    updateMeta('ac', (meta) => { meta.prompt_count = 1; }, failing),
    MetadataWriteError,
  );
  assert.equal(readMeta('ac', options)?.prompt_count, 0);
});

test('agent-directory creation failure cleans up uncommitted state', (t) => {
  const options = root(t);
  const failing = {
    ...options,
    fs: storeFs({
      fsyncSync() {
        throw ioError('EIO', 'injected directory sync failure');
      },
    }),
  };
  assert.throws(
    () => createAgentDirectory('a1', failing),
    MetadataWriteError,
  );
  assert.equal(nodeFs.existsSync(agentDir('a1', options)), false);
});

test('late update after deletion is the only missing-state no-op and never recreates state', async (t) => {
  const options = root(t);
  createAgentDirectory('ad', options);
  writeMeta('ad', idleMeta('ad', '/tmp', null, 5), options);
  nodeFs.rmSync(agentDir('ad', options), { recursive: true, force: true });

  let mutated = false;
  const result = await updateMeta('ad', () => { mutated = true; }, options);
  assert.equal(result, null);
  assert.equal(mutated, false);
  assert.equal(nodeFs.existsSync(agentDir('ad', options)), false);
});

test('stale lock files are reclaimed without native flock support', async (t) => {
  const options = root(t);
  createAgentDirectory('bb', options);
  writeMeta('bb', idleMeta('bb', '/tmp', null, 5), options);
  nodeFs.writeFileSync(join(agentDir('bb', options), '.lock'), JSON.stringify({ pid: 99999999, startTicks: 1 }));
  const result = await withAgentLock('bb', () => 'ok', options);
  assert.equal(result, 'ok');
});

test('reclaiming a stale lock never deletes a lock installed by another owner', async (t) => {
  const options = root(t);
  createAgentDirectory('d11', options);
  writeMeta('d11', idleMeta('d11', '/tmp', null, 5), options);
  const lockPath = join(agentDir('d11', options), '.lock');
  nodeFs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startTicks: 1 }));

  const staleRaw = JSON.stringify({ pid: 99999999, startTicks: 1 });
  const foreignRaw = JSON.stringify({ pid: process.pid, startTicks: null });
  // A competing owner reclaims the same stale lock and installs its own live lock
  // after this process observes the stale owner but before it unlinks.
  let reads = 0;
  let hijackOn = 0;
  let hijacked = false;
  let seenForeign = false;
  const unlinked = [];
  const hijacking = storeFs({
    readFileSync: (path, ...rest) => {
      if (String(path).endsWith('.lock')) {
        const raw = nodeFs.readFileSync(path, 'utf8');
        if (hijackOn === reads) {
          // The other owner installs its own lock as this process reads the stale one.
          nodeFs.writeFileSync(path, foreignRaw);
          hijacked = true;
          hijackOn = -1;
        } else if (hijacked && seenForeign) {
          // This re-read sees the foreign lock; retire it so the reclaimer can finish.
          seenForeign = false;
          nodeFs.writeFileSync(path, staleRaw);
        } else if (hijacked) {
          seenForeign = true;
        }
        reads += 1;
        return raw;
      }
      return nodeFs.readFileSync(path, ...rest);
    },
    unlinkSync: (path) => {
      if (String(path).endsWith('.lock')) unlinked.push(nodeFs.readFileSync(path, 'utf8'));
      return nodeFs.unlinkSync(path);
    },
  });

  const result = await withAgentLock('d11', () => 'ok', { ...options, fs: hijacking });
  assert.equal(result, 'ok');
  assert.equal(hijacked, true);
  assert.equal(unlinked.includes(foreignRaw), false);
});

test('releasing a lock never deletes a lock another owner installed at the same path', async (t) => {
  const options = root(t);
  createAgentDirectory('d12', options);
  writeMeta('d12', idleMeta('d12', '/tmp', null, 5), options);
  const lockPath = join(agentDir('d12', options), '.lock');
  const foreignRaw = JSON.stringify({ pid: process.pid, startTicks: (procStartTicks(process.pid) ?? 0) + 1 });

  // The agent directory is deleted and re-created (a supported delete/new cycle)
  // while this owner is inside the critical section, and the new directory's
  // lock belongs to another live owner. Releasing must not unlink it.
  const unlinked = [];
  const replacing = storeFs({
    closeSync: (fd) => {
      // The agent directory was deleted and re-created by another owner while
      // this owner was inside the critical section; the file at the path is now
      // the new owner's live lock, not the one this descriptor was opened on.
      nodeFs.writeFileSync(lockPath, foreignRaw);
      return nodeFs.closeSync(fd);
    },
    unlinkSync: (path, ...rest) => {
      if (String(path).endsWith('.lock')) unlinked.push(nodeFs.readFileSync(path, 'utf8'));
      return nodeFs.unlinkSync(path, ...rest);
    },
  });

  const result = await withAgentLock('d12', () => 'ok', { ...options, fs: replacing });
  assert.equal(result, 'ok');
  assert.deepEqual(unlinked, []);
  assert.equal(nodeFs.readFileSync(lockPath, 'utf8'), foreignRaw);
  t.after(() => nodeFs.rmSync(lockPath, { force: true }));
});

test('releasing a lock never deletes a replacement lock held by the same process', async (t) => {
  const options = root(t);
  createAgentDirectory('d13', options);
  writeMeta('d13', idleMeta('d13', '/tmp', null, 5), options);
  const lockPath = join(agentDir('d13', options), '.lock');

  // A second acquisition by this same still-live process replaces the lock while
  // this owner is still inside the critical section. Releasing must not unlink it.
  let replacementRaw = null;
  const unlinked = [];
  const replacing = storeFs({
    closeSync: (fd) => {
      const mine = JSON.parse(nodeFs.readFileSync(lockPath, 'utf8'));
      // The replacement is a second acquisition by this same still-live process:
      // same pid, same start ticks, and a different acquisition identity. The
      // only field allowed to differ is the one naming the acquisition itself, so
      // if that field is missing the replacement is byte-identical -- exactly the
      // case the release path must still refuse to unlink.
      const replacement = { ...mine };
      for (const key of Object.keys(replacement)) {
        if (key !== 'pid' && key !== 'startTicks') replacement[key] = 'b'.repeat(32);
      }
      replacementRaw = JSON.stringify(replacement);
      assert.equal(replacement.pid, mine.pid);
      assert.equal(replacement.startTicks, mine.startTicks);
      nodeFs.writeFileSync(lockPath, replacementRaw);
      return nodeFs.closeSync(fd);
    },
    unlinkSync: (path, ...rest) => {
      if (String(path).endsWith('.lock')) unlinked.push(nodeFs.readFileSync(path, 'utf8'));
      return nodeFs.unlinkSync(path, ...rest);
    },
  });

  const result = await withAgentLock('d13', () => 'ok', { ...options, fs: replacing });
  assert.equal(result, 'ok');
  assert.deepEqual(unlinked, []);
  assert.equal(nodeFs.readFileSync(lockPath, 'utf8'), replacementRaw);
  t.after(() => nodeFs.rmSync(lockPath, { force: true }));
});

test('reclaiming a stale lock never unlinks a different tokenless record sharing pid and start ticks', async (t) => {
  const options = root(t);
  createAgentDirectory('d14', options);
  writeMeta('d14', idleMeta('d14', '/tmp', null, 5), options);
  const lockPath = join(agentDir('d14', options), '.lock');

  // A legacy record carries no acquisition token, so its only identity is its
  // exact content. pid/startTicks name the process, not the acquisition: another
  // acquisition can share them while differing in content, and unlinking it on
  // pid/startTicks alone would remove a lock this process never observed.
  const staleRaw = JSON.stringify({ pid: 99999999, startTicks: 1 });
  const otherRaw = JSON.stringify({ pid: 99999999, startTicks: 1, legacy: 'other-acquisition' });
  nodeFs.writeFileSync(lockPath, staleRaw);

  const unlinked = [];
  let reads = 0;
  const swapping = storeFs({
    readFileSync: (path, ...rest) => {
      if (String(path).endsWith('.lock')) {
        reads += 1;
        // The re-read after the stale observation sees a different acquisition's
        // record; only the retry after that restores the observed stale content.
        const raw = reads === 2 ? otherRaw : staleRaw;
        nodeFs.writeFileSync(path, raw);
        return raw;
      }
      return nodeFs.readFileSync(path, ...rest);
    },
    unlinkSync: (path, ...rest) => {
      if (String(path).endsWith('.lock')) unlinked.push(nodeFs.readFileSync(path, 'utf8'));
      return nodeFs.unlinkSync(path, ...rest);
    },
  });

  const result = await withAgentLock('d14', () => 'ok', { ...options, fs: swapping });
  assert.equal(result, 'ok');
  assert.equal(reads >= 3, true);
  assert.equal(unlinked.includes(otherRaw), false);
  assert.equal(unlinked.includes(staleRaw), true);
  t.after(() => nodeFs.rmSync(lockPath, { force: true }));
});

test('lock initialization failure never unlinks another owner\'s create-before-write window', async (t) => {
  const options = root(t);
  createAgentDirectory('a0b', options);
  writeMeta('a0b', idleMeta('a0b', '/tmp', null, 5), options);
  const lockPath = join(agentDir('a0b', options), '.lock');

  // A malformed file at the lock path is indistinguishable from another owner's
  // create-before-write window, so the failed initialization must leave it alone
  // rather than assume it is its own partial record.
  const foreignRaw = '{"pid":4242';
  const failing = {
    ...options,
    fs: storeFs({
      fsyncSync: (fd) => {
        if (fd === undefined) throw ioError('EIO', 'injected lock fsync failure');
        nodeFs.writeFileSync(lockPath, foreignRaw);
        throw ioError('EIO', 'injected lock fsync failure');
      },
    }),
  };

  await assert.rejects(withAgentLock('a0b', () => 'ok', failing), MetadataLockError);
  assert.equal(nodeFs.readFileSync(lockPath, 'utf8'), foreignRaw);
  t.after(() => nodeFs.rmSync(lockPath, { force: true }));
});

test('concurrent in-process updates serialize through the lock file', async (t) => {
  const options = root(t);
  createAgentDirectory('cc', options);
  writeMeta('cc', idleMeta('cc', '/tmp', null, 5), options);
  const order = [];
  const first = withAgentLock('cc', async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push('first-end');
  }, options);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = withAgentLock('cc', () => { order.push('second'); }, options);
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('a lock is reclaimed only when the process it names is provably not this one', async (t) => {
  const selfTicks = procStartTicks(process.pid);
  if (selfTicks === null) {
    t.skip('liveness is decided on /proc/<pid>/stat start ticks, unreadable on this host');
    return;
  }
  const options = root(t);

  // A recycled pid: the pid is live but the start time in the record is not this
  // process's. Ownership may never be inferred from a bare pid, so the record is
  // dead authority and must be reclaimed instead of blocking the waiter.
  createAgentDirectory('d20', options);
  writeMeta('d20', idleMeta('d20', '/tmp', null, 5), options);
  const recycledPath = join(agentDir('d20', options), '.lock');
  const recycledRaw = JSON.stringify({ pid: process.pid, startTicks: selfTicks + 1 });
  nodeFs.writeFileSync(recycledPath, recycledRaw);

  const recycled = boundedLockAttempts(options, recycledPath, 2);
  const reclaimed = await withAgentLock('d20', () => 'ok', recycled.options).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  assert.equal(
    reclaimed.error,
    undefined,
    `a record whose start time disagrees must be reclaimed, not retried `
      + `(attempts=${recycled.state.attempts}): ${reclaimed.error}`,
  );
  assert.equal(reclaimed.value, 'ok');
  assert.equal(recycled.state.attempts, 2, 'reclaiming costs one observation and one retry');
  assert.deepEqual(recycled.state.installed.length, 1, 'exactly one acquisition installed a record');
  assert.equal(
    JSON.parse(recycled.state.installed[0]).pid,
    process.pid,
    'the recycled record must be replaced by this process\'s own acquisition',
  );
  assert.equal(nodeFs.existsSync(recycledPath), false, 'the reclaimed lock was released');

  // A live record whose start time is unreadable proves no ownership and grants
  // no licence to steal either. A waiter must keep waiting, leaving the owner's
  // record exactly as it found it.
  createAgentDirectory('d21', options);
  writeMeta('d21', idleMeta('d21', '/tmp', null, 5), options);
  const heldPath = join(agentDir('d21', options), '.lock');
  const heldRaw = JSON.stringify({ pid: process.pid, startTicks: null });
  nodeFs.writeFileSync(heldPath, heldRaw);

  const held = boundedLockAttempts(options, heldPath, 3);
  await assert.rejects(
    withAgentLock('d21', () => 'ok', held.options),
    MetadataLockError,
    'a live owner\'s lock must not be reclaimed on the pid alone',
  );
  assert.equal(
    nodeFs.readFileSync(heldPath, 'utf8'),
    heldRaw,
    'a refused takeover must leave the owner\'s record byte-identical',
  );
  assert.equal(held.state.attempts > 1, true, 'the waiter must retry rather than steal');
});

test('metadata is published by an exclusive, fsynced sequence that never recreates state', (t) => {
  const options = root(t);

  // A missing agent directory means deletion won the race. Publishing must fail
  // rather than resurrect the durable authority that was just removed.
  createAgentDirectory('e20', options);
  const removed = idleMeta('e20', '/tmp', null, 5);
  writeMeta('e20', removed, options);
  nodeFs.rmSync(agentDir('e20', options), { recursive: true, force: true });
  assert.throws(() => writeMeta('e20', removed, options), AgentStateMissingError);
  assert.equal(
    nodeFs.existsSync(agentDir('e20', options)),
    false,
    'a write must not recreate a deleted agent directory',
  );

  // The temporary file is created exclusively, so a path that already exists
  // belongs to someone else and must not be truncated or renamed into place.
  const squatted = 'e21';
  createAgentDirectory(squatted, options);
  const squattedDir = agentDir(squatted, options);
  const squatterContents = '{"pid":31337,"startTicks":null}\n';
  const realNow = Date.now;
  const realRandom = Math.random;
  try {
    // The temporary name is derived from the pid, the clock and Math.random, so
    // freezing the latter two is what lets the test place a squatter exactly
    // where the next write will look.
    Date.now = () => 1700000000000;
    Math.random = () => 0.5;
    const squatterPath = join(
      squattedDir,
      `.meta-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    nodeFs.writeFileSync(squatterPath, squatterContents);
    assert.throws(
      () => writeMeta(squatted, idleMeta(squatted, '/tmp', null, 5), options),
      MetadataWriteError,
      'a pre-existing temporary path must not be adopted',
    );
    assert.equal(
      nodeFs.existsSync(join(squattedDir, 'meta.json')),
      false,
      'the squatted record must not be renamed over metadata this write never durably produced',
    );
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }

  // Durability is the temp contents, then the rename, then the directory entry.
  const published = 'e22';
  createAgentDirectory(published, options);
  const publishedDir = agentDir(published, options);
  const shorten = (path) => String(path).replace(publishedDir, '<dir>');
  const opened = new Map();
  const events = [];
  const observed = {
    ...options,
    fs: storeFs({
      openSync(path, flags, mode) {
        const fd = nodeFs.openSync(path, flags, mode);
        opened.set(fd, shorten(path));
        events.push(`open:${flags}:${shorten(path)}`);
        return fd;
      },
      writeFileSync(fd, ...rest) {
        events.push(`write:${opened.get(fd)}`);
        return nodeFs.writeFileSync(fd, ...rest);
      },
      fsyncSync(fd) {
        events.push(`fsync:${opened.get(fd)}`);
        return nodeFs.fsyncSync(fd);
      },
      closeSync(fd) {
        events.push(`close:${opened.get(fd)}`);
        return nodeFs.closeSync(fd);
      },
      renameSync(from, to) {
        events.push(`rename:${shorten(from)}->${shorten(to)}`);
        return nodeFs.renameSync(from, to);
      },
    }),
  };
  writeMeta(published, idleMeta(published, '/tmp', null, 5), observed);

  const tempFsync = events.findIndex((event) => /^fsync:<dir>\/\.meta-.*\.tmp$/.test(event));
  const dirFsync = events.findIndex((event) => event === 'fsync:<dir>');
  const rename = events.findIndex((event) => event.startsWith('rename:'));
  assert.equal(
    tempFsync >= 0,
    true,
    `the temporary file must be fsynced before it is published: ${events.join(' -> ')}`,
  );
  assert.equal(
    dirFsync > rename && rename > tempFsync,
    true,
    `fsync temp, then rename, then fsync directory, in that order: ${events.join(' -> ')}`,
  );
  assert.equal(readMeta(published, options)?.id, published);
});
