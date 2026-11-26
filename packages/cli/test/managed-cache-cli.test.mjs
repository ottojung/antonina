import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decodeProcEscapedPath, runAgentCommand } from '../dist/packages/cli/src/agent.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

function fixture(t) {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-managed-cache-'));
  const work = join(root, 'work');
  nodeFs.mkdirSync(work, { recursive: true });
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    work,
    state: {
      env: { XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') },
      home: join(root, 'home'),
    },
  };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdoutRaw: (t) => out.push(t) } };
}

function context(work, state, io, extra = {}) {
  return { env: { ...state.env, PATH: '' }, home: state.home, cwd: work, io, ...extra };
}

function seed(id, work, state, mutate) {
  assert.equal(createAgentDirectory(id, state), true);
  const meta = idleMeta(id, work, null, 1);
  mutate?.(meta);
  writeMeta(id, meta, state);
}

test('agent cache --init refuses a delete-pending agent (init vs terminal deletion race)', async (t) => {
  const { work, state } = fixture(t);
  seed('cache-del', work, state, (meta) => { meta.delete_pending = true; });
  const out = capture();
  const code = await runAgentCommand(['cache', '--id', 'cache-del', '--init'], context(work, state, out.io));
  assert.notEqual(code, 0);
  assert.match(out.err.join('\n'), /being deleted/);
  const cachePath = join(state.env.XDG_STATE_HOME, 'antonina', 'build-cache', 'cache-del', 'target');
  assert.equal(nodeFs.existsSync(cachePath), false);
});

test('agent cache --init registers and prints dedicated path', async (t) => {
  const { work, state } = fixture(t);
  seed('cache-ok', work, state);
  const out = capture();
  const code = await runAgentCommand(['cache', '--id', 'cache-ok', '--init'], context(work, state, out.io));
  assert.equal(code, 0, out.err.join('\n'));
  const expected = join(state.env.XDG_STATE_HOME, 'antonina', 'build-cache', 'cache-ok', 'target');
  assert.equal(out.out.join('\n').trim(), expected);
  assert.equal(nodeFs.existsSync(expected), true);
  assert.equal(nodeFs.existsSync(join(state.env.XDG_STATE_HOME, 'antonina', 'build-cache', 'cache-ok', 'managed-cache.json')), true);
});

async function agedWithCache(t) {
  const { root, work, state } = fixture(t);
  const id = 'cache-aged';
  seed(id, work, state, (meta) => {
    Object.assign(meta, {
      state: 'clearexit', created_at: 1, finished_at: 1, exit_code: 0,
      active_runner: false, pending_prompt: null, delete_pending: false,
    });
  });
  const out = capture();
  const code = await runAgentCommand(['cache', '--id', id, '--init'], context(work, state, out.io));
  assert.equal(code, 0, out.err.join('\n'));
  const stateRoot = join(state.env.XDG_STATE_HOME, 'antonina');
  const cacheDir = join(stateRoot, 'build-cache', id);
  return {
    id, root, work, state,
    stateRoot,
    cacheDir,
    cachePath: join(cacheDir, 'target'),
    markerPath: join(cacheDir, 'managed-cache.json'),
    metaPath: join(stateRoot, 'agents', id, 'meta.json'),
  };
}

test('clean refusal preserves owner record and retryable cache state', async (t) => {
  const h = await agedWithCache(t);
  const out = capture();
  const code = await runAgentCommand(['clean', '--days', '1'], context(h.work, h.state, out.io, {
    liveReferenceProbe: () => ({ ok: true, references: [h.cachePath + '/debug'], unknownProcesses: [] }),
  }));
  assert.equal(code, 0, out.err.join('\n'));
  assert.match(out.out.join('\n'), /retained managed build cache/);
  assert.equal(nodeFs.existsSync(h.metaPath), true, 'owner record must survive a cache refusal');
  assert.equal(nodeFs.existsSync(h.cachePath), true);
  assert.equal(nodeFs.existsSync(h.markerPath), true);
  const meta = readMeta(h.id, h.state);
  assert.equal(meta.delete_pending, false, 'refusal must not tombstone the owner');
});

test('paused retirement preserves owner record and registered cache', async (t) => {
  const h = await agedWithCache(t);
  const paused = { ...h.state, env: { ...h.state.env, ANTONINA_AGENT_CACHE_RETIREMENT: '0' } };
  const out = capture();
  const code = await runAgentCommand(['clean', '--days', '1'], context(h.work, paused, out.io, {
    liveReferenceProbe: () => ({ ok: true, references: [], unknownProcesses: [] }),
  }));
  assert.equal(code, 0, out.err.join('\n'));
  assert.match(out.out.join('\n'), /retirement paused/);
  assert.equal(nodeFs.existsSync(h.metaPath), true, 'owner record must survive a pause');
  assert.equal(nodeFs.existsSync(h.cachePath), true);
  assert.equal(nodeFs.existsSync(h.markerPath), true);
  assert.equal(readMeta(h.id, h.state).delete_pending, false);
});

test('explicit delete refuses to orphan a registered managed cache', async (t) => {
  const h = await agedWithCache(t);
  const out = capture();
  const code = await runAgentCommand(['delete', '--id', h.id], context(h.work, h.state, out.io));
  assert.notEqual(code, 0);
  assert.match(out.err.join('\n'), /managed build cache/);
  assert.equal(nodeFs.existsSync(h.metaPath), true, 'owner record must survive a refused delete');
  assert.equal(nodeFs.existsSync(h.cachePath), true);
  assert.equal(nodeFs.existsSync(h.markerPath), true);
});

test('/proc escaped mount paths decode, malformed escapes fail closed', () => {
  assert.equal(decodeProcEscapedPath('/mnt/a\\040b/\\134c/\\011d'), '/mnt/a b/\\c/\td');
  assert.throws(() => decodeProcEscapedPath('/mnt/a\\4'), /invalid/);
});

test('clean retires registered cache, then removes owner and writes durable manifest', async (t) => {
  const h = await agedWithCache(t);
  const out = capture();
  const code = await runAgentCommand(['clean', '--days', '1'], context(h.work, h.state, out.io, {
    liveReferenceProbe: () => ({ ok: true, references: [], unknownProcesses: [] }),
  }));
  assert.equal(code, 0, out.err.join('\n'));
  assert.match(out.out.join('\n'), /retired managed build cache/);
  assert.equal(nodeFs.existsSync(h.cachePath), false);
  assert.equal(nodeFs.existsSync(h.markerPath), false);
  assert.equal(nodeFs.existsSync(h.metaPath), false, 'owner may only be removed after the cache is retired');
  const manifest = join(h.stateRoot, 'managed-cache-retirements.jsonl');
  const lines = nodeFs.readFileSync(manifest, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((record) => record.status), ['intent', 'retired']);
  assert.equal(lines[0].path, h.cachePath);
  assert.equal(lines[0].nonce, lines[1].nonce);
});
