// Board issue 159: per-agent backend session store.
//
// The fault this pins against is a SQLite write-lock timeout in the external
// OpenCode backend's single shared session store, which killed six fronts on
// 2026-10-02 with `Failed to execute statement`. The property under test is
// that a managed agent's backend invocations read and write a store named by
// its own sidecar, and that the cases which must keep sharing still share.
//
// Store identity lives in `<agents>/<id>/backend/store-owner`, NOT in
// `meta.json`. That is review finding F1, and the reason is not cosmetic:
// `meta.json` has a closed `TOP_LEVEL_FIELDS` schema, and the binary already
// installed on the host rejects any record that does not match it exactly. A
// record with one extra field is unreadable by that binary forever -- `status`,
// `run`, `stop`, `kill`, `delete`, `wait` all fail closed and cannot be
// recovered by downgrading, because the old binary can neither read nor
// rewrite the record. Test 1 is the guard against ever doing that again.
//
// What is asserted here, and why each one is a possible regression:
//
//   1. `meta.json`'s closed top-level schema is exactly what it was before board
//      159, and it still rejects an unknown field. If a field is added here, the
//      installed binary cannot read any record written after that moment.
//   2. The sidecar is an agent id, never a path, is validated as one, and its
//      absence means "the operator's ambient store" rather than a failure.
//   3. `backendStoreEnv` is the single place that resolves an id to a path, it
//      resolves under the caller's own `XDG_STATE_HOME`, and it creates the
//      directory it names.
//   4. The invocation spawn sets `OPENCODE_DB` from the sidecar, last, so no
//      ambient value can win -- and two agents get two different stores.
//   5. An agent with no sidecar gets no `OPENCODE_DB` at all: agents created
//      before board 159 keep using the operator's ambient store, because that is
//      the only store whose file contains their recorded session.
//   6. A fork inherits the source's sidecar, so `native_session_id` resolves.
//   7. Session discovery reads the same store the invocation will write -- at the
//      helper level, through the real runner for both the continue-mode
//      discovery (runner.ts `buildAgentCommand`) and the post-run discovery
//      (runner.ts `rememberFreshSession`). These three are the seams review F2
//      showed were unpinned: deleting the store argument from either leaves the
//      discovery reading the ambient store, silently, with no failing test.
//   8. The model preflight probe opens no durable store at all.
//
// The CLI's own session-recovery seam (`packages/cli/src/agent.ts`, the
// `discoverSessionId` call in `cmdRun`) is driven end-to-end through the shipped
// executable instead, in `packages/cli/test/agent.e2e.test.mjs`
// ("the CLI session recovery seam reads this agent's own store") -- it cannot be
// reached from here without forking a runner subprocess the CLI then detaches.
//
// Everything runs against a fake `opencode` executable in a temp directory and a
// throwaway `XDG_STATE_HOME`/`XDG_CONFIG_HOME`, so no test here can read or
// write the operator's live agent state or `trust.json`/`credential.json`, and
// nothing opens the real shared backend database. No spawned process outlives
// its test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';

import {
  OPENCODE_DB_ENV,
  THROWAWAY_STORE_DB,
  backendStoreEnv,
  backendStoreOwnerPath,
  backendStorePath,
  buildAgentCommand,
  claimBackendStore,
  configuredModelAvailable,
  discoverSessionId,
  readBackendStoreOwner,
} from '../dist/packages/agent-runtime/src/backend.js';
import { forkAgent } from '../dist/packages/agent-runtime/src/fork.js';
import { idleMeta, validateAgentMetadata } from '../dist/packages/agent-runtime/src/metadata.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { agentDir, createAgentDirectory, metaPath, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-STORE-FIXTURE-EXEC-OK';

/**
 * The canonical top-level field set of `meta.json` as the binary installed on
 * this host understands it, written out here rather than imported so that
 * widening `TOP_LEVEL_FIELDS` in `metadata.ts` fails this test instead of
 * silently making every new record unreadable to that binary.
 */
const INSTALLED_BINARY_TOP_LEVEL_FIELDS = [
  'active_runner', 'agent_version', 'backend_error', 'created_at', 'cwd', 'delete_pending',
  'error', 'exit_code', 'exit_signal', 'finished_at', 'id', 'intent', 'invocation_id',
  'last_activity_at', 'last_prompt', 'native_session_id', 'pending_prompt', 'pid', 'pgid',
  'prompt_count', 'runner_gen', 'runner_pid', 'runner_reservation', 'runner_start_time',
  'start_time', 'started_at', 'state', 'steer_queue', 'steer_seq', 'stop_reason', 'title',
  'variant',
].sort();

function execProbe(parent, name) {
  const dir = mkdtempSync(join(parent, name));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "${PROBE_SENTINEL}"\n`, { mode: 0o755 });
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  if (result.error) return { ok: false, reason: String(result.error.code ?? result.error.message) };
  if (result.status !== 0) return { ok: false, reason: `probe exited with status ${result.status}` };
  if (result.stdout.trim() !== PROBE_SENTINEL) return { ok: false, reason: 'probe produced no sentinel' };
  return { ok: true, reason: 'exec ok' };
}

function pruneFixtureParent(t) {
  try {
    rmdirSync(REPO_FIXTURE_PARENT);
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

/**
 * A fake backend that records the `OPENCODE_DB` it was given, one line per
 * invocation, into `$ANTONINA_STORE_PROBE`, and exits 0. `session list` answers
 * with one row titled for the agent so discovery has something to find; `models`
 * answers with the configured model.
 *
 * Review O2: when no exec-capable fixture directory exists this throws a named
 * error instead of skipping. The suite is the fault regression for board 159;
 * on a `noexec` TMPDIR a `t.skip` here would make it vanish from the run
 * silently, which is how a regression suite stops being one.
 */
function fakeBackend(t) {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    let root;
    try {
      mkdirSync(parent, { recursive: true });
      root = mkdtempSync(join(parent, 'antonina-store-'));
    } catch (error) {
      failures.push(`${parent}: ${error.message}`);
      continue;
    }
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      pruneFixtureParent(t);
    });
    if (execProbe(root, 'probe-').ok) {
      const bin = join(root, 'opencode');
      writeFileSync(bin, [
        '#!/bin/sh',
        'printf "%s|%s\\n" "$1" "${OPENCODE_DB-unset}" >> "$ANTONINA_STORE_PROBE"',
        'if [ "$1" = "session" ]; then printf \'[{"id":"sess-1","title":"antonina-a11d","created":1}]\\n\'; fi',
        'if [ "$1" = "models" ]; then printf \'opencode/space-bunny-free\\n\'; fi',
        'exit 0',
        '',
      ].join('\n'), { mode: 0o755 });
      return { bin, probe: join(root, 'probe.log') };
    }
    failures.push(`${root}: fixture is not exec-capable`);
  }
  const error = new Error(
    `no exec-capable fixture directory for the fake opencode backend; tried: ${failures.join('; ')}`,
  );
  error.code = 'ANTONINA_FIXTURE_NOEXEC';
  throw error;
}

function scratch(t, backend) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-store-'));
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  mkdirSync(stateHome);
  mkdirSync(configHome);
  const env = {
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: configHome,
    ANTONINA_OPENCODE_BIN: backend.bin,
    ANTONINA_STORE_PROBE: backend.probe,
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });
  return { env };
}

function probeLines(backend) {
  if (!existsSync(backend.probe)) return [];
  return readFileSync(backend.probe, 'utf8').split('\n').filter(Boolean).map((line) => {
    const split = line.lastIndexOf('|');
    return { argv0: line.slice(0, split), db: line.slice(split + 1) };
  });
}

function reservation(overrides = {}) {
  return {
    state: 'reserved',
    gen: 7,
    mode: 'new',
    reserved_at: 1,
    owner_pid: process.pid,
    owner_start_ticks: 0,
    ...overrides,
  };
}

/**
 * Create an agent the way `antonina agent new` does: directory, canonical
 * record, and -- unless `legacy` says otherwise -- a claimed store sidecar.
 * `legacy: true` is an agent created before board 159: a record and nothing
 * else, so it keeps using the operator's ambient store.
 */
function agent(t, options, overrides = {}) {
  const id = overrides.id ?? 'a11d';
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-store-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  const { id: _ignoredId, legacy = false, ...fields } = overrides;
  void _ignoredId;
  for (const [key, value] of Object.entries(fields)) meta[key] = value;
  writeMeta(id, meta, options);
  if (!legacy) claimBackendStore(id, options);
  return { id, meta, cwd };
}

function storePathFor(id, options) {
  return join(agentDir(id, options), 'backend', 'opencode.db');
}

test('meta.json keeps its pre-board-159 shape, and the closed schema keeps its teeth', () => {
  const meta = idleMeta('a11d', '/tmp/work', null, 100.5);
  // Review F1. A record written now must be readable by the binary already
  // installed on this host, in both directions and forever: a field the old
  // validator does not know is a record no command can read, including the ones
  // an operator needs to stop a live front.
  assert.deepEqual(Object.keys(meta).sort(), INSTALLED_BINARY_TOP_LEVEL_FIELDS);
  assert.equal(Object.keys(meta).length, 32);
  assert.doesNotThrow(() => validateAgentMetadata(meta));

  // Nothing about the store leaks into the record: no field name, and no
  // property whose name mentions one. (`backend_error` is a field of its own and
  // predates this issue.)
  assert.deepEqual(Object.keys(meta).filter((field) => /backend/.test(field)), ['backend_error']);

  // The teeth: an unknown field is still rejected, so the schema is closed in
  // both directions. This is the check that has to keep holding if anyone
  // proposes to move the store identity back into the record.
  for (const field of ['backend_store', 'store_owner', 'backend']) {
    assert.throws(
      () => validateAgentMetadata({ ...meta, [field]: 'a11d' }),
      /fields are not canonical/,
      `unknown field unexpectedly accepted: ${field}`,
    );
  }

  // A record written by a runtime from before board 159 is byte-identical to one
  // written now, so it still validates and needs no migration.
  const legacy = JSON.parse(JSON.stringify(meta));
  assert.deepEqual(Object.keys(legacy).sort(), INSTALLED_BINARY_TOP_LEVEL_FIELDS);
  assert.doesNotThrow(() => validateAgentMetadata(legacy));
});

test('the store-owner sidecar is an agent id, and its absence means the ambient store', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { XDG_STATE_HOME: join(root, 'state') } };
  assert.equal(createAgentDirectory('a11d', options), true);

  // Absent sidecar: an agent from before board 159. That is a defined meaning,
  // not a failure, and it is what keeps its recorded session resolvable.
  assert.equal(readBackendStoreOwner('a11d', options), null);
  assert.deepEqual(backendStoreEnv('a11d', options), {});

  claimBackendStore('a11d', options);
  assert.equal(readBackendStoreOwner('a11d', options), 'a11d');
  assert.equal(existsSync(backendStoreOwnerPath('a11d', options)), true);
  // The sidecar lives inside the agent's own directory, so `agent delete` takes
  // it, and the store it names, with it.
  assert.equal(backendStoreOwnerPath('a11d', options).startsWith(agentDir('a11d', options)), true);

  // An agent id is lowercase hex, never a path: a sidecar cannot redirect one
  // agent's store onto another's files and cannot escape the state root. A
  // present-but-wrong value fails loudly rather than silently reverting to the
  // shared store, which is the writer class this issue exists to remove.
  for (const bad of ['/tmp/elsewhere/opencode.db', '../escape', '', 'A11D', 'a11d\n../../x', 'a11 d']) {
    writeFileSync(backendStoreOwnerPath('a11d', options), `${bad}\n`);
    assert.throws(
      () => readBackendStoreOwner('a11d', options),
      /sidecar for agent a11d is malformed/,
      `sidecar unexpectedly accepted: ${bad}`,
    );
    assert.throws(() => backendStoreEnv('a11d', options), /sidecar for agent a11d is malformed/);
  }
});

test('backendStoreEnv resolves an id to an absolute path under its own state root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { XDG_STATE_HOME: join(root, 'state') } };

  for (const id of ['a11d', 'b22d']) assert.equal(createAgentDirectory(id, options), true);
  claimBackendStore('a11d', options);
  claimBackendStore('b22d', options);

  const scope = backendStoreEnv('a11d', options);
  assert.deepEqual(Object.keys(scope), [OPENCODE_DB_ENV]);
  const path = scope[OPENCODE_DB_ENV];
  assert.equal(isAbsolute(path), true);
  assert.equal(path, storePathFor('a11d', options));
  assert.equal(path.startsWith(join(root, 'state')), true);
  assert.equal(existsSync(join(agentDir('a11d', options), 'backend')), true);

  // Two owners never collide, and an unclaimed agent names no store at all.
  const other = backendStoreEnv('b22d', options);
  assert.notEqual(other[OPENCODE_DB_ENV], path);

  // Resolving twice is stable, and the directory it names is inside the agent's
  // own directory, so `agent delete` takes the store with it.
  assert.equal(backendStorePath('a11d', options), path);
  assert.equal(backendStoreEnv('a11d', options)[OPENCODE_DB_ENV], path);
});

test('the invocation spawn opens this agent\'s store, and an unclaimed agent opens none', async (t) => {
  const backend = fakeBackend(t);
  const { env } = scratch(t, backend);
  const options = { env };

  const { id } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation(),
    pending_prompt: 'do the work',
  });
  await runManagedRunner(id, 'new', 7, options);
  const scoped = probeLines(backend).filter((line) => line.argv0 === 'run');
  assert.equal(scoped.length, 1, 'the fake backend run was not invoked exactly once');
  assert.equal(scoped[0].db, storePathFor(id, options));

  // An agent from before board 159: same spawn, no `OPENCODE_DB`, so the backend
  // keeps using the operator's ambient store -- the only store holding its
  // recorded session.
  agent(t, options, {
    id: 'b22d',
    legacy: true,
    runner_gen: 7,
    runner_reservation: reservation(),
    pending_prompt: 'do the work',
  });
  assert.equal(readBackendStoreOwner('b22d', options), null);
  await runManagedRunner('b22d', 'new', 7, options);
  const after = probeLines(backend).filter((line) => line.argv0 === 'run');
  assert.equal(after.length, 2);
  assert.equal(after[1].db, 'unset');
});

test('two agents with the same ambient environment get two different stores', async (t) => {
  const backend = fakeBackend(t);
  const { env } = scratch(t, backend);
  const options = { env };

  for (const id of ['a11d', 'c33d']) {
    agent(t, options, {
      id,
      runner_gen: 7,
      runner_reservation: reservation(),
      pending_prompt: 'work',
    });
    await runManagedRunner(id, 'new', 7, options);
  }

  const lines = probeLines(backend).filter((line) => line.argv0 === 'run');
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].db, lines[1].db);
  assert.equal(lines[0].db, storePathFor('a11d', options));
  assert.equal(lines[1].db, storePathFor('c33d', options));
});

test('a fork inherits the source sidecar, so its session id still resolves', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-store-'));
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-store-cwd-'));
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const options = { env: { XDG_STATE_HOME: join(root, 'state') } };
  assert.equal(createAgentDirectory('a11d', options), true);
  const source = idleMeta('a11d', cwd, null, 1);
  source.native_session_id = 'ses_source';
  writeMeta('a11d', source, options);
  claimBackendStore('a11d', options);

  const clone = forkAgent('a11d', 'f00d', options, 2);
  assert.equal(clone.id, 'f00d');
  assert.equal(clone.native_session_id, 'ses_source');
  // The sidecar is copied, not derived: the clone continues the source's
  // session, so it must read and write the store that session lives in.
  assert.equal(readBackendStoreOwner('f00d', options), 'a11d');
  assert.equal(
    backendStoreEnv('f00d', options)[OPENCODE_DB_ENV],
    backendStoreEnv('a11d', options)[OPENCODE_DB_ENV],
  );
  // Independence is not weakened by sharing a store: the source still names
  // itself, and the clone's own record is untouched.
  assert.equal(readBackendStoreOwner('a11d', options), 'a11d');
  assert.equal(readMeta('f00d', options).id, 'f00d');

  // A legacy source has no sidecar to copy, so the clone gets none: both keep
  // using the ambient store, which is where that source's session is.
  rmSync(backendStoreOwnerPath('a11d', options), { force: true });
  const legacyClone = forkAgent('a11d', 'b22d', options, 3);
  assert.equal(legacyClone.id, 'b22d');
  assert.equal(readBackendStoreOwner('b22d', options), null);
  assert.deepEqual(backendStoreEnv('b22d', options), {});
});

test('session discovery reads the same store the invocation will write', (t) => {
  const backend = fakeBackend(t);
  const { env } = scratch(t, backend);
  const options = { env };
  const { id, meta } = agent(t, options);

  const scope = backendStoreEnv(id, options);
  assert.equal(discoverSessionId(id, env, scope), 'sess-1');
  const command = buildAgentCommand({ ...meta }, 'work', true, env, scope);
  assert.equal(command === null, false);
  assert.equal(command[command.indexOf('--session') + 1], 'sess-1');
  // Twice: the explicit call above, and the one inside `buildAgentCommand`. Both
  // read the store the invocation will write; a regression that dropped the
  // scope from either would show an `unset` line here.
  const expected = storePathFor(id, options);
  assert.deepEqual(probeLines(backend), [
    { argv0: 'session', db: expected },
    { argv0: 'session', db: expected },
  ]);

  // An unclaimed agent discovers ambient, which is where its session is.
  const legacyRoot = mkdtempSync(join(tmpdir(), 'antonina-store-'));
  t.after(() => rmSync(legacyRoot, { recursive: true, force: true }));
  const legacyOptions = { env: { XDG_STATE_HOME: join(legacyRoot, 'state') } };
  assert.equal(createAgentDirectory('b22d', legacyOptions), true);
  // Same agent id as above, in a different state root: the fixture answers with
  // a session titled for `a11d`, so this is the same lookup with no sidecar.
  assert.equal(createAgentDirectory('a11d', legacyOptions), true);
  assert.equal(discoverSessionId('a11d', env, backendStoreEnv('a11d', legacyOptions)), 'sess-1');
  assert.equal(probeLines(backend).at(-1).db, 'unset');
});

test('continue mode resolves its session through the real runner, in this agent\'s store', async (t) => {
  const backend = fakeBackend(t);
  const { env } = scratch(t, backend);
  const options = { env };

  // `native_session_id: null` on a continue-mode invocation is the shape that
  // forces `buildAgentCommand` to discover, which is the only way this seam is
  // observable. A continue with a recorded id never discovers at all (the two
  // cases below are separated for that reason).
  const { id } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ mode: 'continue' }),
    pending_prompt: 'keep going',
    native_session_id: null,
  });
  await runManagedRunner(id, 'continue', 7, options);

  const expected = storePathFor(id, options);
  const discovered = probeLines(backend).filter((line) => line.argv0 === 'session');
  assert.equal(discovered.length >= 1, true, 'continue mode never discovered a session');
  for (const line of discovered) {
    assert.equal(
      line.db,
      expected,
      'continue-mode session discovery read a store other than the one the invocation writes',
    );
  }
  const runs = probeLines(backend).filter((line) => line.argv0 === 'run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].db, expected);
});

test('a first run records its fresh session from this agent\'s own store', async (t) => {
  const backend = fakeBackend(t);
  const { env } = scratch(t, backend);
  const options = { env };

  const { id } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation(),
    pending_prompt: 'first work',
    native_session_id: null,
  });
  await runManagedRunner(id, 'new', 7, options);

  // `rememberFreshSession` is what writes `native_session_id` after a first run,
  // so it is the seam whose silent regression loses a session id forever. The
  // session the runner records must have come from this agent's own store.
  const expected = storePathFor(id, options);
  const discovered = probeLines(backend).filter((line) => line.argv0 === 'session');
  assert.equal(discovered.length, 1, 'the post-run session discovery never ran');
  assert.equal(discovered[0].db, expected);
  assert.equal(readMeta(id, options).native_session_id, 'sess-1');

  // A continue with a recorded id performs no discovery at all: the recorded id
  // is used directly. Pinned so a future change cannot start rediscovering
  // against a store the invocation will not write.
  agent(t, options, {
    id: 'c33d',
    runner_gen: 7,
    runner_reservation: reservation({ mode: 'continue' }),
    pending_prompt: 'again',
    native_session_id: 'sess-recorded',
  });
  await runManagedRunner('c33d', 'continue', 7, options);
  assert.deepEqual(
    probeLines(backend).filter((line) => line.argv0 === 'session'),
    [{ argv0: 'session', db: expected }],
    'a recorded session id still triggered discovery',
  );
  assert.equal(readMeta('c33d', options).native_session_id, 'sess-recorded');
});

test('the model preflight probe opens no durable store', (t) => {
  const backend = fakeBackend(t);
  const { env } = scratch(t, backend);
  assert.equal(configuredModelAvailable(env), true);
  assert.deepEqual(probeLines(backend), [{ argv0: 'models', db: THROWAWAY_STORE_DB }]);
});

test('an ambient OPENCODE_DB does not reach the probe or a scoped agent', (t) => {
  const backend = fakeBackend(t);
  const { env } = scratch(t, backend);
  const ambient = { ...env, [OPENCODE_DB_ENV]: join(tmpdir(), 'operator-shared-store', 'opencode.db') };
  const options = { env: ambient };

  // The probe is `:memory:` even when the operator pinned a store: that is the
  // documented behaviour (review F3), pinned here so it cannot be "fixed" into a
  // shared-store reader.
  assert.equal(createAgentDirectory('a11d', options), true);
  claimBackendStore('a11d', options);
  assert.equal(configuredModelAvailable(ambient), true);
  // A scoped agent still beats the ambient value, and names its own store.
  assert.equal(backendStoreEnv('a11d', ambient)[OPENCODE_DB_ENV], storePathFor('a11d', options));
  // An agent with no sidecar gets no `OPENCODE_DB` from the ambient value either:
  // it inherits the operator's store the way it always did, which is not the
  // same as being handed a path by Antonina.
  assert.equal(createAgentDirectory('b22d', options), true);
  assert.deepEqual(backendStoreEnv('b22d', ambient), {});
  for (const line of probeLines(backend)) {
    assert.equal(line.db, THROWAWAY_STORE_DB);
  }
});