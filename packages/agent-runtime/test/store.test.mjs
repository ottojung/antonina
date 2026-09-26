import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/metadata.js';
import {
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
} from '../dist/store.js';

function root(t) {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-store-'));
  t.after(() => nodeFs.rmSync(dir, { recursive: true, force: true }));
  return { env: { XDG_STATE_HOME: dir }, home: join(dir, 'home') };
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
