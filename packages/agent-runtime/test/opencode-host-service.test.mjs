import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta, validateAgentMetadata } from '../dist/packages/agent-runtime/src/metadata.js';
import { opencodeBackendEnv, createAgentDirectory, removeAgentDirectory } from '../dist/packages/agent-runtime/src/store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-host-service-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_STATE_HOME: join(root, 'state'), OPENCODE_DB: join(root, 'external.db') };
  return { root, env };
}

test('independent agents share exactly one host database and service namespace', (t) => {
  const { env } = fixture(t);
  const a = idleMeta('shared-a', '/tmp/one', null, 1);
  const b = idleMeta('shared-b', '/tmp/two', null, 1);
  const first = opencodeBackendEnv(a, { env });
  const second = opencodeBackendEnv(b, { env });
  assert.deepEqual(first, second);
  assert.notEqual(first.OPENCODE_DB, env.OPENCODE_DB);
  assert.match(first.OPENCODE_DB, /opencode-service\/opencode\.db$/);
  assert.ok(existsSync(first.XDG_CONFIG_HOME));
  assert.ok(existsSync(first.XDG_STATE_HOME));
  assert.ok(existsSync(first.XDG_DATA_HOME));
  assert.ok(existsSync(first.XDG_CACHE_HOME));
});

test('different Antonina host state roots do not share a service or credentials', (t) => {
  const { env, root } = fixture(t);
  const a = idleMeta('shared-a', '/tmp/one', null, 1);
  const one = opencodeBackendEnv(a, { env });
  const two = opencodeBackendEnv(a, { env: { ...env, XDG_STATE_HOME: join(root, 'another-state') } });
  assert.notEqual(one.OPENCODE_DB, two.OPENCODE_DB);
  assert.notEqual(one.XDG_STATE_HOME, two.XDG_STATE_HOME);
});

test('canonical agent records carry no per-agent database field', () => {
  const meta = idleMeta('shared-a', '/tmp/one', null, 1);
  validateAgentMetadata(meta);
  assert.equal(Object.hasOwn(meta, 'opencode_db'), false);
  assert.throws(() => validateAgentMetadata({ ...meta, opencode_db: 'old-key' }), /fields are not canonical/);
});

test('deleting an agent cannot delete another session or the shared database', (t) => {
  const { env } = fixture(t);
  const a = idleMeta('shared-a', '/tmp/one', null, 1);
  const paths = { env };
  const db = opencodeBackendEnv(a, paths).OPENCODE_DB;
  writeFileSync(db, 'durable session data');
  createAgentDirectory('shared-a', paths);
  createAgentDirectory('shared-b', paths);
  removeAgentDirectory('shared-a', paths);
  assert.equal(readFileSync(db, 'utf8'), 'durable session data');
  removeAgentDirectory('shared-b', paths);
  assert.equal(readFileSync(db, 'utf8'), 'durable session data');
});
