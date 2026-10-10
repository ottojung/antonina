// Board issue 178, residual RF1. The launch-time half of the working-directory
// check -- `runner.ts`, the branch that refuses to spawn when the effective
// directory is not an existing directory -- and the `LAUNCH_DIRECTORY_MISSING: `
// entry in `DISPLAYABLE_AGENT_ERRORS` that exists only so `agent status` will
// quote that note, had no test at all on this head. An independent review
// measured it: making the runner branch dead but compiling left `runner.test.mjs`
// and `agent.e2e.test.mjs` at 77/77 green, and `grep` for the note across
// `packages/*/test/*.mjs` returned nothing.
//
// So this file drives the real runner and then reads the real record back
// through the real CLI, rather than asserting on the constant. The state it
// builds is not one `antonina agent run` can produce on its own -- the CLI
// checks the effective directory at acceptance, which is correct and is pinned
// in `agent.e2e.test.mjs` as `a recorded working directory that no longer
// exists is refused by name`. The gap this file covers is the window between
// that check and the spawn: the directory can be removed in between (an
// operator's `rm -rf`, a cleanup sweep, an unmounted volume), and an accepted
// prompt must still end with a note that names the cause. Without the branch
// the outcome was no pid and the note `OpenCode process had no pid` with exit
// 127 -- a sentence that names nothing an operator could act on, which is
// precisely what the branch was written to eliminate.
//
// Why this file lives in `packages/cli/test` and not `packages/agent-runtime/test`:
// the assertion has two halves, and the second half is a CLI surface. Driving
// both from one place is what makes the pair one claim -- that the runner
// writes a note which the CLI then displays -- instead of two files that each
// assert half of it and could disagree.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { beginInvocation } from '../dist/packages/agent-runtime/src/lifecycle.js';
import { LAUNCH_DIRECTORY_MISSING, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { metaPath, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

// Board 197: the reservation is claimed against the owner's identity, and on the
// `self` shape that is pid plus the process's own live start time plus the
// per-invocation token the launcher minted. These fixtures are the launcher, so
// they carry the same evidence a real one does rather than a name alone.
const LAUNCHER_TOKEN = mintRunnerReservationOwnerToken();

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-LAUNCHDIR-EXEC-OK';

// Copied in full from `agent.e2e.test.mjs` rather than imported: this file must
// stay runnable on its own, and it deliberately shares no module state with the
// suite that owns the main CLI fixture.
function execProbe(parent) {
  const dir = mkdtempSync(join(parent, 'probe-'));
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
    rmSync(REPO_FIXTURE_PARENT, { recursive: false });
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

function selectExecRoot(prefix, t) {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      failures.push(`${parent}: cannot create fixture parent (${error.message})`);
      continue;
    }
    const probe = execProbe(parent);
    if (!probe.ok) {
      failures.push(`${parent}: ${probe.reason}`);
      continue;
    }
    const root = mkdtempSync(join(parent, prefix));
    t.after(() => {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      pruneFixtureParent(t);
    });
    return root;
  }
  pruneFixtureParent(t);
  const error = new Error(
    `no exec-capable fixture directory for the fake opencode; tried: ${failures.join('; ')}`,
  );
  error.code = 'ANTONINA_FIXTURE_NOEXEC';
  throw error;
}

function fixture(t) {
  const root = selectExecRoot('antonina-launchdir-', t);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // The marker the backend writes the moment it is executed at all. Its
  // continued absence is the load-bearing negative: the note below has to be
  // reachable without a spawn, so a regression that "fixed" the empty note by
  // spawning anyway would be caught here rather than passing because the check
  // no longer runs.
  const invoked = join(root, 'backend-invoked');
  const opencode = join(bin, 'opencode');
  writeFileSync(opencode, `#!/bin/sh\nprintf 'invoked %s\\n' "$*" >>'${invoked}'\nexit 0\n`, { mode: 0o755 });
  const work = join(root, 'work');
  mkdirSync(work);
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    // Trust and credential configuration are test-owned too, so nothing here
    // can read or write the operator's real ~/.config/antonina.
    XDG_CONFIG_HOME: join(root, 'config'),
    ANTONINA_OPENCODE_BIN: opencode,
    // The runner this file drives directly is the one the reservation above was
    // minted for, so it is handed the token exactly as a real launcher hands it.
    ANTONINA_RUNNER_OWNER_TOKEN: LAUNCHER_TOKEN,
  };
  const direct = spawnSync(opencode, ['models'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(
    direct.status,
    0,
    `fake opencode fixture ${opencode} is not runnable here: ${direct.error?.code ?? direct.stderr}`,
  );
  rmSync(invoked, { force: true });
  return { root, work, env, invoked };
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function reservation(overrides = {}) {
  return {
    state: 'reserved',
    gen: 3,
    mode: 'new',
    reserved_at: 1,
    owner_pid: process.pid,
    owner_start_ticks: procStartTicks(process.pid) ?? 0,
    owner_token: LAUNCHER_TOKEN,
    ...overrides,
  };
}

test('a directory that disappears between acceptance and spawn is named, and never launched into', async (t) => {
  const { work, env, invoked } = fixture(t);

  // Created through the real CLI, so the declaration and everything else about
  // the record is the ordinary shape rather than something assembled here.
  const created = runCli(['agent', 'new', '--id', '0a11', '--cwd', work, '--json'], env);
  assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
  assert.equal(JSON.parse(created.stdout).cwd, work);

  // The accepted-but-not-yet-launched state, built through the same lifecycle
  // entry point `antonina agent run` uses rather than by hand-patching the
  // fields, so the runner runs against a state the CLI really produces. A
  // hand-built record could differ from the CLI's in exactly the field this
  // test is about.
  const now = Date.now() / 1000;
  const meta = readMeta('0a11', { env });
  beginInvocation(meta, 'work', now, 2);
  meta.active_runner = true;
  meta.runner_gen = 3;
  meta.runner_reservation = reservation({ gen: 3 });
  writeMeta('0a11', meta, { env });

  // The window: the directory is gone before the spawn. Nothing races here --
  // the runner is called directly, so the check is reached on the state above,
  // deterministically, on every run of this file.
  rmSync(work, { recursive: true, force: true });
  assert.equal(existsSync(work), false, 'the fixture must actually be gone for this case to mean anything');

  await runManagedRunner('0a11', 'new', 3, { env });

  const after = readMeta('0a11', { env });
  assert.equal(after.state, 'failed');
  assert.equal(
    after.error,
    `${LAUNCH_DIRECTORY_MISSING}: ${work}`,
    'the recorded reason must name the directory, not report that no pid appeared',
  );
  assert.equal(after.exit_code, null, 'no process was ever run, so there is no exit code to report');
  // No spawn record, for the same reason: the launch was refused before one
  // existed, so there is no identity to publish and none to leave behind as a
  // dead pid dressed up as authoritative.
  assert.equal(after.pid, null);
  assert.equal(after.pgid, null);
  assert.equal(after.invocation_id, null);
  assert.equal(after.start_time, null);
  // The claim is released, so the agent is not wedged by a refusal.
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
  // The declaration survives untouched: refusing a launch says nothing about
  // what the operator declared, and a later run in a restored directory has to
  // be able to use it.
  assert.equal(after.cwd, work);
  // The observation did not move. Nothing ran, so nothing was observed -- which
  // is the whole point of `cwd` and `invocation_cwd` being two facts.
  assert.equal(after.invocation_cwd, null);

  assert.equal(
    existsSync(invoked),
    false,
    'the backend must never have been executed: the check is a refusal, not a spawn that failed',
  );

  // The second half of the claim: the note exists in order to be read, and the
  // only reason `DISPLAYABLE_AGENT_ERRORS` grew a `LAUNCH_DIRECTORY_MISSING: `
  // entry was so that `agent status` would quote it. Asserted through the real
  // CLI, in both output forms.
  const human = runCli(['agent', 'status', '--id', '0a11'], env);
  assert.equal(human.status, 0, `${human.stdout}${human.stderr}`);
  assert.match(
    human.stdout,
    new RegExp(`^last error: ${LAUNCH_DIRECTORY_MISSING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `, 'm'),
    human.stdout,
  );
  assert.doesNotMatch(human.stdout, /not displayable here/, human.stdout);
  const json = runCli(['agent', 'status', '--id', '0a11', '--json'], env);
  assert.equal(json.status, 0, `${json.stdout}${json.stderr}`);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.last_error, `${LAUNCH_DIRECTORY_MISSING}: ${work}`);
  assert.equal(parsed.cwd, work, 'the declaration is still the declaration');
  assert.equal(parsed.invocation_cwd, null, 'and nothing was ever observed');
});

test('the same agent launches normally once the directory exists again', async (t) => {
  // The control for the refusal above, and the reason the refusal is a refusal
  // rather than a poisoned agent: a restored directory must be usable, through
  // the same declared `cwd`, with no operator intervention on the record.
  const { work, env, invoked } = fixture(t);
  assert.equal(runCli(['agent', 'new', '--id', '0a12', '--cwd', work, '--json'], env).status === 0, true);
  const now = Date.now() / 1000;
  const meta = readMeta('0a12', { env });
  beginInvocation(meta, 'work', now, 2);
  meta.active_runner = true;
  meta.runner_gen = 3;
  meta.runner_reservation = reservation({ gen: 3 });
  writeMeta('0a12', meta, { env });

  await runManagedRunner('0a12', 'new', 3, { env });

  const after = readMeta('0a12', { env });
  assert.equal(after.state, 'succeeded', 'a directory that still exists launches as before');
  assert.equal(after.error, null);
  assert.equal(after.invocation_cwd, work, 'the observation is recorded only once a child existed');
  assert.ok(existsSync(invoked), 'the backend really was executed on this path');
  assert.match(readFileSync(metaPath('0a12', { env }), 'utf8'), new RegExp(`"invocation_cwd": ${JSON.stringify(work).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});