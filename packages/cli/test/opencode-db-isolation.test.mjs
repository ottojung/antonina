// Board 186: the CLI's two OpenCode probes must be handed the record's database.
//
// `packages/agent-runtime/test/opencode-db-isolation.test.mjs` pins where the
// per-agent database is calculated and, since the landing front's pass, that the
// runner hands it to OpenCode. This file pins the last two seams, both in
// `packages/cli/src/agent.ts`:
//
//   * `cmdRun`'s model probe (`configuredModelAvailable`), and
//   * `cmdRun`'s session-recovery probe (`discoverSessionId`).
//
// Both are unpinned by construction. `configuredModelAvailable` is a pure
// function of the backend's `models` output, and `discoverSessionId` answers
// from whatever database it is pointed at, so removing
// `...opencodeBackendEnv(...)` from either call site changed nothing any existing
// test could see: at fce7f02c, removing it from both leaves `npm run test:cli`
// at 204 pass / 0 fail. A future refactor could have dropped the isolation here
// without a single test noticing.
//
// So the fixture's ANSWERS DEPEND ON THE DATABASE IT WAS HANDED. `models` prints
// the configured model only when `$OPENCODE_DB` is this agent's database;
// `session list` prints a row only when the sidecar next to `$OPENCODE_DB` names
// it; `run` records what argv it was launched with. A probe pointed anywhere else
// therefore answers "nothing here", which is exactly what a shared-database front
// saw before the fix -- and the assertions below are about what the command
// DECIDED, read back from the shipped executable.
//
// Both XDG roots are test-owned temporary directories, so nothing here can read
// or write the operator's `trust.json` or `credential.json` (AGENTS.md, Test
// safety). Each case waits for the detached runner it starts to reach a terminal
// record and asserts its process is gone, so nothing is left running.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const OPENCODE_BIN_ENV = 'ANTONINA_OPENCODE_BIN';
const MODEL = 'opencode-go/step-5-preview-free';
const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-B186-CLI-EXEC-OK';
const CONVERGE_MS = 20_000;
const POLL_MS = 100;

function execProbe(parent, name) {
  const dir = mkdtempSync(join(parent, name));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "${PROBE_SENTINEL}"\n`, { mode: 0o755 });
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  return result.error === undefined && result.status === 0 && result.stdout.trim() === PROBE_SENTINEL;
}

function pruneFixtureParent(t) {
  try {
    rmdirSync(REPO_FIXTURE_PARENT);
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t?.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

// The fixture backend. Every answer is gated on the OPENCODE_DB it was handed:
//
//   * `models`        -> the configured model, but only for THIS agent's database
//   * `session list`  -> the agent's row, but only if the sidecar beside the
//                        database it was handed names that session
//   * `run`           -> records "OPENCODE_DB|argv" and exits 0
//
// `run` also drops a sidecar so the runner's own post-invocation probe has
// something to find; the CLI cases do not depend on it.
function fixtureBackend(t, id, expectedDb, logFile, sessionId, gates) {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    let root;
    try {
      mkdirSync(parent, { recursive: true });
      root = mkdtempSync(join(parent, 'antonina-b186-cli-'));
    } catch (error) {
      failures.push(`${parent}: ${error.message}`);
      continue;
    }
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      pruneFixtureParent(t);
    });
    if (!execProbe(root, 'probe-')) {
      failures.push(`${root}: fixture is not exec-capable`);
      continue;
    }
    const bin = join(root, 'opencode');
    // `gates` names WHICH answer depends on the database: 'models' or 'session'.
    // One per case, so a red case attributes the failure to the one seam it pins
    // rather than to whichever probe the command happened to run first. The
    // ungated answer is deliberately unconditional, because `cmdRun` always runs
    // BOTH probes and a gated model probe would otherwise stop the command before
    // it ever reached the seam under test.
    writeFileSync(bin, `#!/bin/sh
printf '%s|%s\\n' "$OPENCODE_DB" "$*" >>'${logFile}'
case "$1" in
  models)
    if [ '${gates}' = 'session' ] || [ "$OPENCODE_DB" = '${expectedDb}' ]; then
      printf '${MODEL}\\n'
    fi
    ;;
  session)
    if [ '${gates}' = 'models' ] || [ "$OPENCODE_DB" = '${expectedDb}' ]; then
      if [ -f "$OPENCODE_DB.sessions" ]; then
        printf '[{"id":"${sessionId}","title":"antonina-${id}","created":1}]\\n'
      fi
    fi
    ;;
  run)
    printf '${sessionId}\\n' > "$OPENCODE_DB.sessions"
    ;;
esac
exit 0
`, { mode: 0o755 });
    return bin;
  }
  t.skip(`no exec-capable fixture directory for the fake opencode backend; tried: ${failures.join('; ')}`);
  return null;
}

// The state root is fixed before the fixture backend is written, because the
// fixture gates its answers on the exact database path -- so the world is built
// first and the backend installed into it afterwards.
function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-b186-cli-'));
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    NO_COLOR: '1',
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, work, env };
}

function run(args, env, timeout = 30_000) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout });
}

function metaPath(env, id) {
  return join(env.XDG_STATE_HOME, 'antonina', 'agents', id, 'meta.json');
}

function readMeta(env, id) {
  const path = metaPath(env, id);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function writeMeta(env, id, meta) {
  writeFileSync(metaPath(env, id), JSON.stringify(meta, null, 2));
}

// The database the record names: `<state>/antonina/opencode/<key>.db`, the layout
// `opencodeDbPath` builds. Named here rather than imported because the CLI test
// runs the shipped executable, not the runtime's module graph -- and because a
// test that imports the thing under test cannot catch that thing being wrong.
function expectedDb(env, id) {
  return join(env.XDG_STATE_HOME, 'antonina', 'opencode', `${id}.db`);
}

// `agent run` hands the work to a DETACHED runner and returns immediately, so a
// case that cares what the runner then did has to wait for it. Waiting is
// bounded, and the record's own terminal state is what ends the wait; a runner
// that never converges fails the case instead of hanging the file.
function awaitTerminal(env, id) {
  const deadline = Date.now() + CONVERGE_MS;
  for (;;) {
    const meta = readMeta(env, id);
    if (meta !== null && meta.state !== 'running' && meta.active_runner === false) return meta;
    if (Date.now() > deadline) {
      throw new Error(`agent ${id} was still ${meta?.state ?? 'absent'} after ${CONVERGE_MS}ms`);
    }
    spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${POLL_MS})`]);
  }
}

function invocationLog(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('|');
    return { db: line.slice(0, at), argv: line.slice(at + 1) };
  });
}

function assertReaped(t, meta) {
  if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0) return;
  assert.throws(() => process.kill(meta.pid, 0), /ESRCH/, `agent ${meta.pid} was left running`);
}

test('the model probe is run against the record database', (t) => {
  const id = 'b186c1';
  const logFile = join(mkdtempSync(join(tmpdir(), 'antonina-b186-cli-log-')), 'models.log');
  t.after(() => rmSync(join(logFile, '..'), { recursive: true, force: true }));
  const handle = world(t);
  const bin = fixtureBackend(t, id, expectedDb(handle.env, id), logFile, 'ses_b186c1', 'models');
  if (bin === null) return;
  handle.env[OPENCODE_BIN_ENV] = bin;

  const created = run(['agent', 'new', '--id', id, '--cwd', handle.work], handle.env);
  assert.equal(created.status, 0, created.stderr);

  // The fixture refuses to list the model for any database but this agent's, so
  // this run reaches `spawnRunner` only if the model probe was handed the
  // record's database. Before board 186 it was handed nothing and the model
  // probe read the shared database; the assertion is the command's own refusal
  // message, so a probe pointed elsewhere produces a red case rather than a
  // silent substitution.
  const ran = run(['agent', 'run', '--id', id, '--prompt', 'work'], handle.env);
  assert.equal(
    ran.status, 0,
    `agent run refused: ${ran.stderr}\nA probe handed a database other than ${expectedDb(handle.env, id)} cannot see the model.`,
  );
  assert.doesNotMatch(ran.stderr + ran.stdout, /model opencode-go\/step-5-preview-free is unavailable/);

  const models = invocationLog(logFile).filter((entry) => entry.argv.startsWith('models'));
  assert.ok(models.length >= 1, 'no model probe was recorded at all');
  for (const entry of models) {
    assert.equal(entry.db, expectedDb(handle.env, id), 'the model probe read a database other than the record\'s');
  }

  const settled = awaitTerminal(handle.env, id);
  assertReaped(t, settled);
});

test('a session-recovery probe reads the record database', (t) => {
  const id = 'b186c2';
  const logFile = join(mkdtempSync(join(tmpdir(), 'antonina-b186-cli-log-')), 'recover.log');
  t.after(() => rmSync(join(logFile, '..'), { recursive: true, force: true }));
  const handle = world(t);
  const sessionId = 'ses_b186c2';
  const bin = fixtureBackend(t, id, expectedDb(handle.env, id), logFile, sessionId, 'session');
  if (bin === null) return;
  handle.env[OPENCODE_BIN_ENV] = bin;

  const created = run(['agent', 'new', '--id', id, '--cwd', handle.work], handle.env);
  assert.equal(created.status, 0, created.stderr);

  // A record that owns no session id but has run before: the shape that sends
  // `cmdRun` to `discoverSessionId` rather than declaring a fresh session. The
  // session exists, in the database this record names.
  const meta = readMeta(handle.env, id);
  assert.equal(meta.native_session_id, null, 'the fixture record already named a session');
  meta.prompt_count = 2;
  meta.state = 'idle';
  meta.finished_at = null;
  writeMeta(handle.env, id, meta);
  const expected = expectedDb(handle.env, id);
  mkdirSync(join(expected, '..'), { recursive: true });
  writeFileSync(`${expected}.sessions`, `${sessionId}\n`);

  const ran = run(['agent', 'run', '--id', id, '--prompt', 'work'], handle.env);
  assert.equal(ran.status, 0, ran.stderr);

  const settled = awaitTerminal(handle.env, id);
  assertReaped(t, settled);

  const seen = invocationLog(logFile);
  const probes = seen.filter((entry) => entry.argv.startsWith('session list'));
  assert.ok(probes.length >= 1, `no recovery probe was recorded; saw ${JSON.stringify(seen)}`);
  for (const probe of probes) {
    assert.equal(probe.db, expected, 'the recovery probe read a database other than the record\'s');
  }
  // And the decision the probe produced is visible in what the runner was told
  // to do: having found the session, the run continues it. A probe handed
  // another database finds nothing, the command declares `mode: 'new'`, and the
  // backend is launched with `--title antonina-<id>` and no `--session`.
  const spawns = seen.filter((entry) => entry.argv.startsWith('run '));
  assert.equal(spawns.length, 1, `expected one spawned invocation, saw ${spawns.length}`);
  assert.equal(spawns[0].db, expected);
  assert.match(spawns[0].argv, new RegExp(`--session ${sessionId}(\\s|$)`));
});