import assert from 'node:assert/strict';
import test from 'node:test';

import * as managed from '../dist/packages/agent-runtime/src/managed-build-cache.js';
import {
  MANAGED_CACHE_SCHEMA,
  initializeManagedCache,
  liveReferenceReason,
  managedCacheDir,
  managedCacheMarkerPath,
  managedCachePath,
  managedCacheRoot,
  readManagedCache,
  retireManagedCache,
} from '../dist/packages/agent-runtime/src/managed-build-cache.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

const ROOT = '/state/antonina/build-cache';
const OK_PROBE = () => ({ ok: true, references: [], unknownProcesses: [] });

/** Synthetic fs with real inode identity. Never touches ambient state. */
function fakeFs() {
  const nodes = new Map();
  const unreadable = new Set();
  let nextIno = 100;
  const mk = (path, kind) => {
    nodes.set(path, { kind, dev: 1, ino: nextIno++, content: '', bytes: 16 });
    return nodes.get(path);
  };
  const fs = {
    nodes, unreadable,
    mkdir(path) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      if (!nodes.has(path)) mk(path, 'dir');
    },
    lstat(path) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      const node = nodes.get(path);
      if (!node) return null;
      return {
        dev: node.dev, ino: node.ino,
        isDirectory: node.kind === 'dir',
        isFile: node.kind === 'file',
        isSymbolicLink: node.kind === 'link',
      };
    },
    readFile(path) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      const node = nodes.get(path);
      if (!node || node.kind !== 'file') throw new Error('ENOENT ' + path);
      return node.content;
    },
    writeFileExclusive(path, data) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      if (nodes.has(path)) {
        const error = new Error('EEXIST ' + path);
        error.code = 'EEXIST';
        throw error;
      }
      mk(path, 'file').content = data;
    },
    readdir(path) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      if (!nodes.has(path)) throw new Error('ENOENT ' + path);
      const prefix = path + '/';
      return [...nodes.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map((key) => key.slice(prefix.length));
    },
    removeTree(path) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      for (const key of [...nodes.keys()]) {
        if (key === path || key.startsWith(path + '/')) nodes.delete(key);
      }
    },
    removeFile(path) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      const node = nodes.get(path);
      if (!node) throw new Error('ENOENT ' + path);
      if (node.kind === 'dir') throw new Error('EISDIR ' + path);
      nodes.delete(path);
    },
    rmdir(path) {
      if (unreadable.has(path)) throw new Error('EACCES ' + path);
      const node = nodes.get(path);
      if (!node) throw new Error('ENOENT ' + path);
      if (node.kind !== 'dir') throw new Error('ENOTDIR ' + path);
      const prefix = path + '/';
      for (const key of nodes.keys()) {
        if (key.startsWith(prefix)) throw new Error('ENOTEMPTY ' + path);
      }
      nodes.delete(path);
    },
    allocatedBytes(path) { return nodes.get(path)?.bytes ?? 0; },
    setInode(path, ino) { nodes.get(path).ino = ino; },
    corruptMarker(path, mutation) {
      const node = nodes.get(path);
      const marker = JSON.parse(node.content);
      mutation(marker);
      node.content = JSON.stringify(marker);
    },
  };
  return fs;
}

function terminalMeta(id, cwd) {
  const meta = idleMeta(id, cwd, 'review', 1);
  meta.state = 'clearexit';
  meta.finished_at = 2;
  return meta;
}

function setup(id = 'agent-MjSl7ZkuNCdfJdEAUbNmdc-sees', cwd = '/workspace') {
  const fs = fakeFs();
  fs.mkdir('/state');
  fs.mkdir('/state/antonina');
  const created = initializeManagedCache(ROOT, id, fs, () => 1000);
  return { fs, id, cwd, created, meta: terminalMeta(id, cwd) };
}

function retire(overrides = {}) {
  const s = setup();
  return { ...s, ...overrides, result: retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: s.meta, probeLiveReferences: OK_PROBE, ...overrides,
  }) };
}

test('registration is explicit, idempotent, and lives only under the dedicated root', () => {
  const s = setup();
  assert.equal(managedCacheRoot('/state/antonina'), ROOT);
  assert.equal(s.created.path, ROOT + '/' + s.id + '/target');
  const again = initializeManagedCache(ROOT, s.id, s.fs, () => 1000);
  assert.equal(again.marker.nonce, s.created.marker.nonce);
  assert.equal(again.marker.schema, MANAGED_CACHE_SCHEMA);
  // A broad cwd is never consulted and is never scanned.
  assert.equal(s.fs.nodes.has('/workspace/target'), false);
  for (const name of Object.keys(managed)) {
    assert.doesNotMatch(name, /scan|discover|sweep|walk|cwd/i, name + ' must not scan workspaces');
  }
});

test('marker mismatch, missing marker and unreadable marker all fail closed', () => {
  const markerPath = ROOT + '/agent-marker/managed-cache.json';
  const a = setup('agent-marker');
  a.fs.corruptMarker(markerPath, (m) => { m.agent_id = 'agent-other'; });
  assert.throws(() => readManagedCache(ROOT, 'agent-marker', a.fs), /does not match/);
  const b = setup('agent-marker');
  b.fs.nodes.delete(markerPath);
  assert.throws(() => readManagedCache(ROOT, 'agent-marker', b.fs), /marker is missing/);
  const c = setup('agent-marker');
  c.fs.unreadable.add(markerPath);
  assert.throws(() => readManagedCache(ROOT, 'agent-marker', c.fs), /EACCES/);
});

test('a changed directory inode after registration blocks retirement', () => {
  const s = setup();
  s.fs.setInode(s.created.path, 999);
  const result = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: s.meta, probeLiveReferences: OK_PROBE,
  });
  assert.equal(result.removed, false);
  assert.match(result.reason, /inode changed/);
  assert.equal(s.fs.nodes.has(s.created.path), true);
});

test('an active or still-owned agent cannot retire its cache', () => {
  const s = setup();
  const active = terminalMeta(s.id, '/workspace');
  active.state = 'running';
  active.started_at = 10;
  const result = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: active, probeLiveReferences: OK_PROBE,
  });
  assert.equal(result.removed, false);
  assert.match(result.reason, /not terminal/);
  assert.equal(s.fs.nodes.has(s.created.path), true);

  const pending = terminalMeta(s.id, '/workspace');
  pending.pending_prompt = 'still accepted';
  const blocked = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: pending, probeLiveReferences: OK_PROBE,
  });
  assert.equal(blocked.removed, false);
  assert.match(blocked.reason, /accepted prompt/);
});

test('a shared cache claimed by another agent fails closed', () => {
  const s = setup();
  const other = setup('agent-other');
  // Give the second registration the exact same path/inode identity.
  other.fs.nodes.get(other.created.path).dev = s.created.marker.dev;
  other.fs.nodes.get(other.created.path).ino = s.created.marker.ino;
  const claims = managed.listManagedCacheClaims(s.fs === other.fs ? ROOT : ROOT, s.fs);
  assert.equal(claims.ok, true);
  const result = retireManagedCache({
    root: ROOT,
    agentId: s.id,
    fs: s.fs,
    meta: s.meta,
    probeLiveReferences: OK_PROBE,
    listClaims: () => ({
      ok: true,
      claims: [
        { agentId: s.id, path: s.created.path, dev: s.created.marker.dev, ino: s.created.marker.ino },
        { agentId: 'agent-other', path: s.created.path, dev: s.created.marker.dev, ino: s.created.marker.ino },
      ],
    }),
  });
  assert.equal(result.removed, false);
  assert.match(result.reason, /also claimed by agent agent-other/);
});

test('unknown process state and an unreadable mount probe fail closed', () => {
  const unknown = retire({
    probeLiveReferences: () => ({ ok: true, references: [], unknownProcesses: ['4242'] }),
  });
  assert.equal(unknown.result.removed, false);
  assert.match(unknown.result.reason, /unknown process/);
  const mounts = retire({
    probeLiveReferences: () => ({ ok: false, reason: '/proc/mounts unreadable', references: [], unknownProcesses: [] }),
  });
  assert.equal(mounts.result.removed, false);
  assert.match(mounts.result.reason, /unreadable/);
  assert.equal(unknown.fs.nodes.has(unknown.created.path), true);
  assert.equal(mounts.fs.nodes.has(mounts.created.path), true);
});

test('a live process reference under the cache path blocks removal', () => {
  const reason = liveReferenceReason('/root/id/target', {
    ok: true, references: ['/root/id/target/debug/deps/libfoo.rlib'], unknownProcesses: [],
  });
  assert.match(reason, /live process or mount reference/);
  assert.equal(liveReferenceReason('/root/id/target', {
    ok: true, references: ['/root/id/targeting/other'], unknownProcesses: [],
  }), null);
});

test('the reference probe is invoked freshly for each deletion', () => {
  const fs = fakeFs();
  fs.mkdir('/state');
  fs.mkdir('/state/antonina');
  const a = initializeManagedCache(ROOT, 'agent-a', fs, () => 1000);
  const b = initializeManagedCache(ROOT, 'agent-b', fs, () => 1000);
  let calls = 0;
  const probe = () => {
    calls += 1;
    return calls === 1
      ? { ok: true, references: [a.path + '/debug'], unknownProcesses: [] }
      : { ok: true, references: [], unknownProcesses: [] };
  };
  const first = retireManagedCache({
    root: ROOT, agentId: 'agent-a', fs, meta: terminalMeta('agent-a', '/workspace'), probeLiveReferences: probe,
  });
  const second = retireManagedCache({
    root: ROOT, agentId: 'agent-b', fs, meta: terminalMeta('agent-b', '/'), probeLiveReferences: probe,
  });
  assert.equal(calls, 2);
  assert.equal(first.removed, false);
  assert.match(first.reason, /live process/);
  assert.equal(second.removed, true);
  assert.equal(b.path.includes('/workspace'), false);
});

test('successful retirement writes a manifest with the pre-removal inode and bytes', () => {
  const s = setup();
  const lines = [];
  s.fs.nodes.get(s.created.path).bytes = 4096;
  const result = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: s.meta, probeLiveReferences: OK_PROBE,
    writeManifestLine: (line) => lines.push(line),
  });
  assert.equal(result.removed, true);
  assert.equal(result.record.allocated_bytes, 4096);
  assert.equal(result.record.dev, s.created.marker.dev);
  assert.equal(result.record.ino, s.created.marker.ino);
  assert.equal(result.record.nonce, s.created.marker.nonce);
  assert.equal(s.fs.nodes.has(s.created.path), false);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).schema, MANAGED_CACHE_SCHEMA);
});

test('the module exports no launch-admission or capacity-guard API', () => {
  for (const name of Object.keys(managed)) {
    assert.doesNotMatch(name, /refus|guard|admit|admission|threshold|allow|deny|decide|evaluate|check|caps?/i,
      name + ' reads like launch policy; this module only manages a registered cache');
  }
});

test('preexisting unmarked target is never adopted', () => {
  const fs = fakeFs();
  fs.mkdir('/state');
  fs.mkdir('/state/antonina');
  fs.mkdir(ROOT);
  fs.mkdir(ROOT + '/agent-unmarked');
  fs.mkdir(ROOT + '/agent-unmarked/target');
  fs.nodes.get(ROOT + '/agent-unmarked/target').bytes = 12345;
  assert.throws(
    () => initializeManagedCache(ROOT, 'agent-unmarked', fs, () => 1000),
    /preexisting unmarked/,
  );
  // The preexisting directory must remain untouched.
  assert.equal(fs.nodes.has(ROOT + '/agent-unmarked/target'), true);
  assert.equal(fs.nodes.has(ROOT + '/agent-unmarked/managed-cache.json'), false);
});

test('symlinked root or agent dir is rejected', () => {
  const fs = fakeFs();
  fs.mkdir('/state');
  fs.mkdir('/state/antonina');
  fs.nodes.set(ROOT, { kind: 'link', dev: 1, ino: 999, content: '/elsewhere', bytes: 0 });
  assert.throws(
    () => initializeManagedCache(ROOT, 'agent-sym', fs, () => 1000),
    /missing, not a plain directory|not a plain directory/,
  );

  const fs2 = fakeFs();
  fs2.mkdir('/state');
  fs2.mkdir('/state/antonina');
  fs2.mkdir(ROOT);
  fs2.nodes.set(ROOT + '/agent-sym', { kind: 'link', dev: 1, ino: 998, content: '/elsewhere', bytes: 0 });
  assert.throws(
    () => initializeManagedCache(ROOT, 'agent-sym', fs2, () => 1000),
    /not a plain directory/,
  );
});

test('successful retirement removes stale marker and allows a later claim', () => {
  const fs = fakeFs();
  fs.mkdir('/state');
  fs.mkdir('/state/antonina');
  const a = initializeManagedCache(ROOT, 'agent-a', fs, () => 1000);
  const b = initializeManagedCache(ROOT, 'agent-b', fs, () => 1000);
  const manifest = [];
  const first = retireManagedCache({
    root: ROOT, agentId: 'agent-a', fs, meta: terminalMeta('agent-a', '/workspace'),
    probeLiveReferences: OK_PROBE, writeManifestLine: (line) => manifest.push(line),
  });
  assert.equal(first.removed, true);
  assert.equal(fs.nodes.has(a.path), false);
  assert.equal(fs.nodes.has(managedCacheMarkerPath(ROOT, 'agent-a')), false);

  // Second retirement must not be blocked by the first agent's stale state.
  const second = retireManagedCache({
    root: ROOT, agentId: 'agent-b', fs, meta: terminalMeta('agent-b', '/other'),
    probeLiveReferences: OK_PROBE, writeManifestLine: (line) => manifest.push(line),
  });
  assert.equal(second.removed, true);
  assert.equal(fs.nodes.has(b.path), false);
  assert.equal(manifest.length, 2);
  assert.notEqual(JSON.parse(manifest[0]).agent_id, JSON.parse(manifest[1]).agent_id);
});

test('two sequential retirements on same root do not interfere', () => {
  const fs = fakeFs();
  fs.mkdir('/state');
  fs.mkdir('/state/antonina');
  initializeManagedCache(ROOT, 'agent-seq1', fs, () => 1000);
  initializeManagedCache(ROOT, 'agent-seq2', fs, () => 1000);
  const lines = [];
  const r1 = retireManagedCache({
    root: ROOT, agentId: 'agent-seq1', fs, meta: terminalMeta('agent-seq1', '/ws'),
    probeLiveReferences: OK_PROBE, writeManifestLine: (l) => lines.push(l),
  });
  const r2 = retireManagedCache({
    root: ROOT, agentId: 'agent-seq2', fs, meta: terminalMeta('agent-seq2', '/ws'),
    probeLiveReferences: OK_PROBE, writeManifestLine: (l) => lines.push(l),
  });
  assert.equal(r1.removed, true);
  assert.equal(r2.removed, true);
  assert.equal(fs.nodes.has(managedCachePath(ROOT, 'agent-seq1')), false);
  assert.equal(fs.nodes.has(managedCachePath(ROOT, 'agent-seq2')), false);
  assert.equal(fs.nodes.has(managedCacheMarkerPath(ROOT, 'agent-seq1')), false);
  assert.equal(fs.nodes.has(managedCacheMarkerPath(ROOT, 'agent-seq2')), false);
  assert.equal(lines.length, 2);
});

test('stale marker with missing target is tolerated by claims and cleaned by retirement', () => {
  const fs = fakeFs();
  fs.mkdir('/state');
  fs.mkdir('/state/antonina');
  const a = initializeManagedCache(ROOT, 'agent-stale', fs, () => 1000);
  // Simulate a crash after target removal but before marker cleanup.
  fs.removeTree(a.path);
  assert.equal(fs.nodes.has(managedCacheMarkerPath(ROOT, 'agent-stale')), true);

  const claims = managed.listManagedCacheClaims(ROOT, fs);
  assert.equal(claims.ok, true);
  assert.deepEqual(claims.claims, []);

  const result = retireManagedCache({
    root: ROOT, agentId: 'agent-stale', fs, meta: terminalMeta('agent-stale', '/ws'),
    probeLiveReferences: OK_PROBE,
  });
  assert.equal(result.removed, true);
  assert.equal(fs.nodes.has(managedCacheMarkerPath(ROOT, 'agent-stale')), false);
});

test('durable pre-removal manifest preserves retryable state on removal failure', () => {
  const s = setup();
  const lines = [];
  const originalRemoveTree = s.fs.removeTree;
  s.fs.removeTree = (path) => {
    if (path === s.created.path) throw new Error('simulated removal failure');
    return originalRemoveTree(path);
  };
  const result = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: s.meta, probeLiveReferences: OK_PROBE,
    writeManifestLine: (line) => lines.push(line),
  });
  assert.equal(result.removed, false);
  assert.match(result.reason, /removal failed/);
  // Manifest was durably written before removal attempt.
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).path, s.created.path);
  // Target and marker remain, so a later retry can succeed.
  assert.equal(s.fs.nodes.has(s.created.path), true);
  assert.equal(s.fs.nodes.has(managedCacheMarkerPath(ROOT, s.id)), true);

  // Retry succeeds.
  s.fs.removeTree = originalRemoveTree;
  const retry = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: s.meta, probeLiveReferences: OK_PROBE,
    writeManifestLine: (line) => lines.push(line),
  });
  assert.equal(retry.removed, true);
  assert.equal(s.fs.nodes.has(s.created.path), false);
});

test('retention refusal preserves retryable state', () => {
  const s = setup();
  const lines = [];
  const refused = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: s.meta,
    probeLiveReferences: () => ({ ok: true, references: [s.created.path + '/debug'], unknownProcesses: [] }),
    writeManifestLine: (line) => lines.push(line),
  });
  assert.equal(refused.removed, false);
  assert.match(refused.reason, /live process/);
  assert.equal(lines.length, 0);
  assert.equal(s.fs.nodes.has(s.created.path), true);
  assert.equal(s.fs.nodes.has(managedCacheMarkerPath(ROOT, s.id)), true);

  const retry = retireManagedCache({
    root: ROOT, agentId: s.id, fs: s.fs, meta: s.meta, probeLiveReferences: OK_PROBE,
    writeManifestLine: (line) => lines.push(line),
  });
  assert.equal(retry.removed, true);
  assert.equal(lines.length, 1);
});
