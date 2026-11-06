import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta, validateAgentMetadata } from '../dist/packages/agent-runtime/src/metadata.js';
import { opencodeBackendEnv, createAgentDirectory, removeAgentDirectory, stateRoot } from '../dist/packages/agent-runtime/src/store.js';
import { modelConfigPath } from '../dist/packages/agent-runtime/src/model-config.js';
import { boardConfigDir } from '../../cli/dist/packages/cli/src/board-config.js';
import { daemonConfigDir } from '../../host-daemon/dist/packages/host-daemon/src/config.js';
import { daemonStateRoot } from '../../host-daemon/dist/packages/host-daemon/src/identity.js';

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

test('nested Antonina invocations keep the host registry and credentials roots', (t) => {
  const { env, root } = fixture(t);
  env.XDG_CONFIG_HOME = join(root, 'config');
  const meta = idleMeta('nested-child', '/tmp/child', null, 1);
  const hostState = stateRoot({ env, home: root });
  const hostConfig = join(env.XDG_CONFIG_HOME, 'antonina');

  const first = opencodeBackendEnv(meta, { env, home: root });
  const inheritedByManagedChild = { ...env, ...first };
  const second = opencodeBackendEnv(meta, { env: inheritedByManagedChild, home: root });
  assert.deepEqual(second, first, 're-entering from the service environment must be idempotent');
  assert.equal(stateRoot({ env: inheritedByManagedChild, home: root }), hostState);
  assert.equal(daemonStateRoot({ env: inheritedByManagedChild, home: root }), hostState);
  assert.equal(boardConfigDir({ env: inheritedByManagedChild, home: root }), hostConfig);
  assert.equal(modelConfigPath(inheritedByManagedChild), join(hostConfig, 'config.json'));
  assert.equal(daemonConfigDir({ env: inheritedByManagedChild, home: root }), hostConfig);
  const explicitState = join(root, 'explicit-state');
  const explicitConfig = join(root, 'explicit-config');
  const callerOverride = { ...inheritedByManagedChild, XDG_STATE_HOME: explicitState, XDG_CONFIG_HOME: explicitConfig };
  assert.equal(stateRoot({ env: callerOverride, home: root }), join(explicitState, 'antonina'));
  assert.equal(daemonStateRoot({ env: callerOverride, home: root }), join(explicitState, 'antonina'));
  assert.equal(boardConfigDir({ env: callerOverride, home: root }), join(explicitConfig, 'antonina'));
  assert.equal(modelConfigPath(callerOverride), join(explicitConfig, 'antonina', 'config.json'));
  assert.equal(modelConfigPath({ ...inheritedByManagedChild, XDG_CONFIG_HOME: explicitConfig }), join(explicitConfig, 'antonina', 'config.json'));
  assert.equal(daemonConfigDir({ env: callerOverride, home: root }), join(explicitConfig, 'antonina'));
});

test('unset and empty host XDG roots use the established home fallbacks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-host-service-fallback-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const env of [{ HOME: root }, { HOME: root, XDG_STATE_HOME: '', XDG_CONFIG_HOME: '' }]) {
    const result = opencodeBackendEnv(idleMeta('fallback', '/tmp/fallback', null, 1), { env, home: root });
    assert.equal(result.ANTONINA_HOST_XDG_STATE_HOME, join(root, '.local', 'state'));
    assert.equal(result.ANTONINA_HOST_XDG_CONFIG_HOME, join(root, '.config'));
  }

  const markersWithoutServiceRoots = {
    HOME: root,
    ANTONINA_HOST_XDG_STATE_HOME: join(root, 'marked-state'),
    ANTONINA_HOST_XDG_CONFIG_HOME: join(root, 'marked-config'),
  };
  assert.equal(stateRoot({ env: markersWithoutServiceRoots, home: root }), join(root, '.local', 'state', 'antonina'));
  assert.equal(daemonStateRoot({ env: markersWithoutServiceRoots, home: root }), join(root, '.local', 'state', 'antonina'));
  assert.equal(boardConfigDir({ env: markersWithoutServiceRoots, home: root }), join(root, '.config', 'antonina'));
  assert.equal(modelConfigPath(markersWithoutServiceRoots), join(root, '.config', 'antonina', 'config.json'));
  assert.equal(daemonConfigDir({ env: markersWithoutServiceRoots, home: root }), join(root, '.config', 'antonina'));
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
