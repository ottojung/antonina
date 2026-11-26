// Cache-only retirement sweep tests. Every state root here is disposable and
// test-owned; no ambient Antonina state is read. The default host probe is
// replaced only where a live reference is the thing under test.
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAgentCommand } from '../dist/packages/cli/src/agent.js';
import { createAgentDirectory, logPath, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

function fixture(t) {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-cache-clean-'));
  const work = join(root, 'work');
  const home = join(root, 'home');
  nodeFs.mkdirSync(work, { recursive: true });
  nodeFs.mkdirSync(home, { recursive: true });
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') };
  return { root, work, home, env, state: { env, home } };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdoutRaw: (t) => out.push(t) } };
}

function context(f, io, extra = {}) {
  return { env: { ...f.env, PATH: '' }, home: f.home, cwd: f.work, io, ...extra };
}

function seed(id, f, mutate) {
  assert.equal(createAgentDirectory(id, f.state), true);
  const meta = idleMeta(id, f.work, null, 1);
  mutate?.(meta);
  writeMeta(id, meta, f.state);
}

function terminal(meta) {
  Object.assign(meta, {
    state: 'clearexit', created_at: 1, finished_at: 1, exit_code: 0,
    active_runner: false, pending_prompt: null, delete_pending: false,
  });
}

function paths(id, f) {
  const stateRoot = join(f.env.XDG_STATE_HOME, 'antonina');
  return {
    stateRoot,
    cacheDir: join(stateRoot, 'build-cache', id),
    cachePath: join(stateRoot, 'build-cache', id, 'target'),
    markerPath: join(stateRoot, 'build-cache', id, 'managed-cache.json'),
    metaPath: join(stateRoot, 'agents', id, 'meta.json'),
    logPath: logPath(id, { env: f.env, home: f.home }),
    manifestPath: join(stateRoot, 'managed-cache-retirements.jsonl'),
  };
}

async function registered(t, id, overrides) {
  const f = fixture(t);
  seed(id, f, (meta) => { terminal(meta); overrides?.(meta); });
  const init = capture();
  assert.equal(await runAgentCommand(['cache', '--id', id, '--init'], context(f, init.io)), 0, init.err.join('\n'));
  return { ...f, ...paths(id, f), id, init };
}

async function sweep(f, extra = {}) {
  const io = capture();
  // Unit tests use a quiet probe so concurrent suites cannot inject a transient
  // host process into an ownership decision. Real-probe behaviour is covered by
  // mountinfo-probe.test.mjs and the isolated staged smoke.
  const probe = () => ({ ok: true, references: [], unknownProcesses: [] });
  const code = await runAgentCommand(['cache-clean'], context(f, io.io, { liveReferenceProbe: probe, ...extra }));
  return { code, out: io.out.join('\n'), err: io.err.join('\n') };
}

test('cache-clean retires a registered terminal cache and leaves the owner record and log byte-identical', async (t) => {
  const h = await registered(t, 'cc-terminal');
  nodeFs.writeFileSync(h.logPath, 'preexisting log line\n');
  const metaBefore = nodeFs.readFileSync(h.metaPath);
  const logBefore = nodeFs.readFileSync(h.logPath);

  const result = await sweep(h);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /retired managed build cache/);
  assert.equal(nodeFs.existsSync(h.cachePath), false);
  assert.equal(nodeFs.existsSync(h.markerPath), false);
  assert.equal(nodeFs.existsSync(h.metaPath), true, 'cache-clean must never delete the owner record');
  assert.deepEqual(nodeFs.readFileSync(h.metaPath), metaBefore);
  assert.deepEqual(nodeFs.readFileSync(h.logPath), logBefore);
  assert.notEqual(readMeta(h.id, h.state), null);
  const manifest = nodeFs.readFileSync(h.manifestPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(manifest.map((line) => line.status), ['intent', 'retired']);
});

test('--dry-run reports candidates and changes nothing', async (t) => {
  const h = await registered(t, 'cc-dry');
  const io = capture();
  const code = await runAgentCommand(['cache-clean', '--dry-run'], context(h, io.io));
  assert.equal(code, 0, io.err.join('\n'));
  assert.match(io.out.join('\n'), /would retire managed build cache/);
  assert.equal(nodeFs.existsSync(h.cachePath), true);
  assert.equal(nodeFs.existsSync(h.markerPath), true);
  assert.equal(nodeFs.existsSync(h.manifestPath), false);
  assert.notEqual(readMeta(h.id, h.state), null);
});

test('live, idle and pending owners retain their caches', async (t) => {
  const f = fixture(t);
  for (const id of ['cc-live', 'cc-idle', 'cc-pending']) seed(id, f);
  const init = capture();
  for (const id of ['cc-live', 'cc-idle', 'cc-pending']) {
    assert.equal(await runAgentCommand(['cache', '--id', id, '--init'], context(f, init.io)), 0, init.err.join('\n'));
  }
  const live = readMeta('cc-live', f.state);
  live.state = 'running';
  writeMeta('cc-live', live, f.state);
  const pending = readMeta('cc-pending', f.state);
  terminal(pending);
  pending.pending_prompt = 'awaiting operator';
  writeMeta('cc-pending', pending, f.state);

  const result = await sweep(f);
  assert.equal(result.code, 0, result.err);
  for (const id of ['cc-live', 'cc-idle', 'cc-pending']) {
    assert.equal(nodeFs.existsSync(paths(id, f).cachePath), true, id + ' must be retained');
    assert.notEqual(readMeta(id, f.state), null, id + ' record must remain');
  }
  assert.equal(nodeFs.existsSync(f.state.env.XDG_STATE_HOME + '/antonina/managed-cache-retirements.jsonl'), false);
});

test('paused switch and live reference retain the cache', async (t) => {
  const paused = await registered(t, 'cc-paused');
  const pauseEnv = { ...paused.env, ANTONINA_AGENT_CACHE_RETIREMENT: '0' };
  const pausedRun = await sweep({ ...paused, env: pauseEnv });
  assert.equal(pausedRun.code, 0, pausedRun.err);
  assert.match(pausedRun.out, /retirement paused/);
  assert.equal(nodeFs.existsSync(paused.cachePath), true);

  const referenced = await registered(t, 'cc-ref');
  const refRun = await sweep(referenced, {
    liveReferenceProbe: () => ({ ok: true, references: [referenced.cachePath + '/debug'], unknownProcesses: [] }),
  });
  assert.equal(refRun.code, 0, refRun.err);
  assert.match(refRun.out, /retained managed build cache/);
  assert.equal(nodeFs.existsSync(referenced.cachePath), true);
});

test('a reference appearing at the final recheck race retains the cache', async (t) => {
  const h = await registered(t, 'cc-race');
  let calls = 0;
  const result = await sweep(h, {
    liveReferenceProbe: () => {
      calls += 1;
      return { ok: true, references: calls >= 2 ? [h.cachePath] : [], unknownProcesses: [] };
    },
  });
  assert.equal(result.code, 0, result.err);
  assert.ok(calls >= 2, 'probe must be taken again immediately before removal');
  assert.match(result.out, /final check/);
  assert.equal(nodeFs.existsSync(h.cachePath), true);
  assert.notEqual(readMeta(h.id, h.state), null);
});

test('symlinked or non-plain registration evidence refuses the whole sweep', async (t) => {
  for (const kind of ['symlink', 'directory']) {
    const h = await registered(t, kind === 'symlink' ? 'cc-link' : 'cc-dir');
    nodeFs.rmSync(h.markerPath, kind === 'symlink' ? { force: true } : { recursive: true, force: true });
    if (kind === 'symlink') nodeFs.symlinkSync(join(h.root, 'outside.json'), h.markerPath);
    else nodeFs.mkdirSync(h.markerPath);
    const result = await sweep(h);
    assert.notEqual(result.code, 0, kind + ' evidence must refuse');
    assert.match(result.err, /retained every managed cache/);
    assert.equal(nodeFs.existsSync(h.cachePath), true, kind + ' cache must remain');
    assert.notEqual(readMeta(h.id, h.state), null);
  }
});

test('a refused cache is retried by the next sweep without metadata deletion', async (t) => {
  const h = await registered(t, 'cc-retry');
  const first = await sweep(h, {
    liveReferenceProbe: () => ({ ok: true, references: [h.cachePath], unknownProcesses: [] }),
  });
  assert.equal(first.code, 0, first.err);
  assert.equal(nodeFs.existsSync(h.cachePath), true);
  assert.equal(nodeFs.existsSync(h.manifestPath), false, 'a refusal must not write a completion line');

  const second = await sweep(h);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /retired managed build cache/);
  assert.equal(nodeFs.existsSync(h.cachePath), false);
  assert.equal(nodeFs.existsSync(h.metaPath), true);
  const manifest = nodeFs.readFileSync(h.manifestPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(manifest.map((line) => line.status), ['intent', 'retired']);
});

test('no path outside the registered cache root is scanned or removed', async (t) => {
  const h = await registered(t, 'cc-scope');
  const decoy = join(h.work, 'target');
  nodeFs.mkdirSync(decoy, { recursive: true });
  nodeFs.writeFileSync(join(decoy, 'keep.txt'), 'unique result\n');
  const other = join(h.stateRoot, 'receipts');
  nodeFs.mkdirSync(other, { recursive: true });
  nodeFs.writeFileSync(join(other, 'receipt.json'), '{}');

  const result = await sweep(h);
  assert.equal(result.code, 0, result.err);
  assert.equal(nodeFs.readFileSync(join(decoy, 'keep.txt'), 'utf8'), 'unique result\n');
  assert.equal(nodeFs.readFileSync(join(other, 'receipt.json'), 'utf8'), '{}');
  assert.equal(nodeFs.existsSync(h.cachePath), false, 'the registered cache itself is still retired');
});
