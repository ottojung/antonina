import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAgentCommand } from '../dist/packages/cli/src/agent.js';
import {
  agentDir,
  createAgentDirectory,
  readMeta,
  writeMeta,
} from '../dist/packages/agent-runtime/src/store.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

function fixture(t) {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-cli-fault-'));
  const work = join(root, 'work');
  nodeFs.mkdirSync(work);
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    work,
    state: { env: { XDG_STATE_HOME: join(root, 'state') }, home: join(root, 'home') },
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

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      stdoutRaw: (text) => out.push(text),
    },
  };
}

function context(work, state, captureIo, fs) {
  return {
    env: { ...state.env, PATH: '' },
    home: state.home,
    cwd: work,
    io: captureIo,
    ...(fs === undefined ? {} : { storeFs: fs }),
  };
}

function seed(id, work, state) {
  assert.equal(createAgentDirectory(id, state), true);
  writeMeta(id, idleMeta(id, work, null, 1), state);
}

test('prompt does not accept work when the metadata lock cannot be acquired', async (t) => {
  const { work, state } = fixture(t);
  seed('a11d', work, state);
  const output = capture();
  const failingFs = storeFs({
    openSync(path, flags, mode) {
      if (String(path).endsWith('.lock')) throw ioError('EACCES', 'injected lock-open failure');
      return nodeFs.openSync(path, flags, mode);
    },
  });

  const code = await runAgentCommand(
    ['prompt', '--id', 'a11d', '--detach', 'must-not-run'],
    context(work, state, output.io, failingFs),
  );

  assert.equal(code, 1);
  assert.match(output.err.join('\n'), /failed to acquire metadata lock/);
  const meta = readMeta('a11d', state);
  assert.equal(meta?.prompt_count, 0);
  assert.equal(meta?.active_runner, false);
  assert.equal(meta?.pending_prompt ?? null, null);
});

test('delete does not remove state when its deletion tombstone cannot be persisted', async (t) => {
  const { work, state } = fixture(t);
  seed('beef', work, state);
  const output = capture();
  const failingFs = storeFs({
    openSync(path, flags, mode) {
      if (String(path).endsWith('.lock')) throw ioError('EACCES', 'injected lock-open failure');
      return nodeFs.openSync(path, flags, mode);
    },
  });

  const code = await runAgentCommand(
    ['delete', '--id', 'beef'],
    context(work, state, output.io, failingFs),
  );

  assert.equal(code, 1);
  assert.match(output.err.join('\n'), /failed to acquire metadata lock/);
  assert.equal(nodeFs.existsSync(agentDir('beef', state)), true);
  assert.equal(readMeta('beef', state)?.delete_pending, false);
});

test('new reports persistence failure and removes its uncommitted state directory', async (t) => {
  const { work, state } = fixture(t);
  const output = capture();
  const failingFs = storeFs({
    renameSync() {
      throw ioError('EIO', 'injected metadata replace failure');
    },
  });

  const code = await runAgentCommand(
    ['new', '--id', 'cafe', '--cwd', work],
    context(work, state, output.io, failingFs),
  );

  assert.equal(code, 1);
  assert.match(output.err.join('\n'), /failed to persist metadata/);
  assert.equal(nodeFs.existsSync(agentDir('cafe', state)), false);
});
