// Board issue 126: `antonina agent new --fork <OLD>`, end to end through the
// shipped executable. Board issue 320: the clone's id is generated, like every
// other `agent new` id, and the source id is still the caller's `--fork` value.
//
// This file covers the CLI surface only: the flag is routed by the public
// command spec, the command reports what it did, and the required failure modes
// are exercised as an operator would exercise them -- an unknown source id, and
// a `--fork` that is not an id at all -- with their exit codes asserted and
// nothing left behind on disk.
//
// The independence proof is not here. It is in
// packages/agent-runtime/test/fork.test.mjs, where the two records can be
// mutated and compared; nothing in this suite can change an agent's record
// without launching a backend, and this suite deliberately launches none, so it
// stays green on a noexec checkout. The generated-id collision case (a target
// id that already exists) is covered there too: the CLI can no longer name a
// target id, so it cannot force that collision.
//
// Every case replaces BOTH Antonina XDG roots, so no case can read or write the
// operator's ~/.local/state/antonina or ~/.config/antonina.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 3;
const ENTITY_ID = /^[0-9A-Za-z-]{22}-[a-z]+$/;

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-fork-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  return { root, env, work };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

function metaPath(root, id) {
  return join(root, 'state', 'antonina', 'agents', id, 'meta.json');
}

function readMeta(root, id) {
  return JSON.parse(readFileSync(metaPath(root, id), 'utf8'));
}

function agentIds(root) {
  return readdirSync(join(root, 'state', 'antonina', 'agents')).sort();
}

// `agent new` prints exactly the generated id and a newline on stdout.
function createAgent(env, args) {
  const created = run(['agent', 'new', ...args], env);
  assert.equal(created.status, EXIT_OK, created.stderr);
  const id = created.stdout.trim();
  assert.match(id, ENTITY_ID, `new must print a generated id, got ${JSON.stringify(created.stdout)}`);
  return id;
}

function seed(root, env, work, title) {
  const id = createAgent(env, ['--cwd', work, ...(title === undefined ? [] : ['--title', title])]);
  return { id, meta: readMeta(root, id) };
}

test('a fork creates an independent agent from an existing one', (t) => {
  const { root, env, work } = world(t);
  const { id: sourceId, meta: sourceBefore } = seed(root, env, work, 'title of the source');

  const forked = run(['agent', 'new', '--fork', sourceId, '--json'], env);
  assert.equal(forked.status, EXIT_OK, forked.stderr);
  const report = JSON.parse(forked.stdout);
  assert.match(report.id, ENTITY_ID, 'the clone id is generated');
  assert.notEqual(report.id, sourceId);
  assert.equal(report.forked_from, sourceId);
  assert.equal(report.cwd, work);
  assert.equal(report.title, 'title of the source');
  assert.equal(report.prompts, 0);

  const clone = readMeta(root, report.id);
  assert.equal(clone.id, report.id);
  // The source is byte-identical to what it was before the fork.
  assert.deepEqual(readMeta(root, sourceId), sourceBefore);
  // Two records, two files, and neither claims a process or a runner.
  assert.notEqual(metaPath(root, sourceId), metaPath(root, report.id));
  for (const field of ['pid', 'pgid', 'start_time', 'invocation_id', 'runner_pid', 'runner_start_time', 'runner_reservation', 'pending_prompt']) {
    assert.equal(clone[field], null, `clone.${field} must be null`);
  }
  assert.equal(clone.active_runner, false);
  assert.equal(clone.runner_gen, 0);
  assert.deepEqual(clone.steer_queue, []);

  // Both agents are independently visible to the rest of the CLI.
  const listed = run(['agent', 'list', '--page', '1', '--json'], env);
  assert.equal(listed.status, EXIT_OK, listed.stderr);
  const ids = JSON.parse(listed.stdout).agents.map((agent) => agent.id).sort();
  assert.deepEqual(ids, [sourceId, report.id].sort());
  for (const id of [sourceId, report.id]) {
    const status = run(['agent', 'status', '--id', id, '--json'], env);
    assert.equal(status.status, EXIT_OK, status.stderr);
    assert.equal(JSON.parse(status.stdout).cwd, work);
  }
});

test('a fork of a plain idle agent continues the same work identity', (t) => {
  const { root, env, work } = world(t);
  const { id: sourceId } = seed(root, env, work);

  const forked = run(['agent', 'new', '--fork', sourceId], env);
  assert.equal(forked.status, EXIT_OK, forked.stderr);
  // The default stdout is the bare generated id; the shared-session disclosure
  // moves to stderr so a shell can capture the id directly.
  const cloneId = forked.stdout.trim();
  assert.match(cloneId, ENTITY_ID);
  assert.match(forked.stderr, /independent/);

  const clone = readMeta(root, cloneId);
  // A fresh agent declares no working directory; a fork inherits the source's
  // declaration rather than the directory that happened to invoke the command.
  assert.equal(clone.cwd, work);
  assert.equal(clone.state, 'idle');
  assert.equal(clone.prompt_count, 0);
});

// Board issue 178. `invocation_cwd` is an *observation*: the directory a front
// was actually launched in. A fork is a fresh agent with its own identity that
// launched nothing, so it must report `never ran`. `forkMetaSnapshot` is a
// `structuredClone` of the source, which carried the source's last launch
// directory across as the clone's own -- so `agent status` on a never-run agent
// printed `ran in: <the source's directory>`.
//
// The source's observation is seeded by writing it into the record directly
// rather than by launching a backend, for the reason this file launches none:
// the fork decision is `forkMetaSnapshot`'s, and a test that had to run a
// backend to produce an input would test the backend instead.
test('a fork of a front that has run reports never ran, not the source directory', (t) => {
  const { root, env, work } = world(t);
  const { id: sourceId } = seed(root, env, work);
  assert.equal(readMeta(root, sourceId).invocation_cwd, null, 'a front that has not run observes nothing');

  const ranElsewhere = join(root, 'source-worktree');
  mkdirSync(ranElsewhere, { recursive: true });
  const seeded = readMeta(root, sourceId);
  seeded.invocation_cwd = ranElsewhere;
  writeFileSync(metaPath(root, sourceId), JSON.stringify(seeded));

  const forked = run(['agent', 'new', '--fork', sourceId], env);
  assert.equal(forked.status, EXIT_OK, forked.stderr);
  const cloneId = forked.stdout.trim();

  const clone = readMeta(root, cloneId);
  assert.equal(
    clone.invocation_cwd,
    null,
    'the clone launched nothing, so it must observe nothing',
  );
  // The declaration is inherited: it is a fact about the agent, not about a run.
  assert.equal(clone.cwd, work);
  // The source is untouched by being read.
  assert.equal(readMeta(root, sourceId).invocation_cwd, ranElsewhere);

  const status = run(['agent', 'status', '--id', cloneId, '--json'], env);
  assert.equal(status.status, EXIT_OK, status.stderr);
  assert.equal(JSON.parse(status.stdout).invocation_cwd, null);
  const human = run(['agent', 'status', '--id', cloneId], env);
  assert.equal(human.status, EXIT_OK, human.stderr);
  assert.match(human.stdout, /^ran in:\s+never ran$/m);
});

test('forking an unknown agent id fails clearly with the not-found exit code', (t) => {
  const { root, env, work } = world(t);
  const { id: sourceId } = seed(root, env, work);

  const forked = run(['agent', 'new', '--fork', 'dead'], env);
  assert.equal(forked.status, EXIT_NOT_FOUND);
  assert.match(forked.stderr, /no managed agent with id dead/);
  assert.deepEqual(agentIds(root), [sourceId], 'a failed fork creates no agent directory');
});

test('a running source forks, and the clone owns nothing the source owns', (t) => {
  const { root, env, work } = world(t);
  const { id: sourceId } = seed(root, env, work);
  // The issue's own purpose: fork an agent that is mid-run. The durable record
  // says running and names a process; the clone must not inherit any of it.
  const sourcePath = metaPath(root, sourceId);
  const meta = JSON.parse(readFileSync(sourcePath, 'utf8'));
  meta.state = 'running';
  meta.started_at = Date.now() / 1000;
  // A complete, canonical invocation identity pointing at this test process.
  const startTicks = Number(readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').pop().split(' ')[19]);
  meta.pid = process.pid;
  meta.pgid = process.pid;
  meta.start_time = startTicks;
  meta.invocation_id = 'a'.repeat(32);
  writeFileSync(sourcePath, `${JSON.stringify(meta, null, 2)}\n`);
  const before = readFileSync(sourcePath, 'utf8');

  const forked = run(['agent', 'new', '--fork', sourceId, '--json'], env);
  assert.equal(forked.status, EXIT_OK, forked.stderr);
  const report = JSON.parse(forked.stdout);
  assert.equal(report.forked_from, sourceId);

  const clone = readMeta(root, report.id);
  // Coherent and non-running, despite the source being mid-run.
  assert.equal(clone.state, 'idle');
  for (const field of ['pid', 'pgid', 'start_time', 'invocation_id', 'runner_pid', 'runner_start_time', 'runner_reservation', 'pending_prompt']) {
    assert.equal(clone[field], null, `clone.${field} must be null`);
  }
  const status = run(['agent', 'status', '--id', report.id, '--json'], env);
  assert.equal(status.status, EXIT_OK, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, 'idle');
  assert.equal(JSON.parse(status.stdout).alive, false);

  // The source was not modified -- not even reconciled into a forkable state.
  assert.equal(readFileSync(sourcePath, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(sourcePath, 'utf8')).state, 'running');
});

test('a source being deleted is refused, and nothing is created', (t) => {
  const { root, env, work } = world(t);
  const { id: sourceId } = seed(root, env, work);
  // A tombstone is not a stable thing to snapshot: a clone taken from one would
  // outlive the deletion the operator asked for.
  const sourcePath = metaPath(root, sourceId);
  const meta = JSON.parse(readFileSync(sourcePath, 'utf8'));
  meta.delete_pending = true;
  writeFileSync(sourcePath, `${JSON.stringify(meta, null, 2)}\n`);

  const forked = run(['agent', 'new', '--fork', sourceId], env);
  assert.equal(forked.status, EXIT_ERROR);
  assert.match(forked.stderr, /being deleted/);
  assert.deepEqual(agentIds(root), [sourceId], 'a refused fork creates no agent directory');
  assert.equal(JSON.parse(readFileSync(sourcePath, 'utf8')).delete_pending, true);
});

test('fork flags are validated at the surface', (t) => {
  const { root, env, work } = world(t);
  const { id: sourceId } = seed(root, env, work);

  const missingValue = run(['agent', 'new', '--fork'], env);
  assert.equal(missingValue.status, EXIT_USAGE);

  const notAnId = run(['agent', 'new', '--fork', 'not-an-id'], env);
  assert.equal(notAnId.status, EXIT_USAGE);
  assert.match(notAnId.stderr, /--fork/);

  const withCwd = run(['agent', 'new', '--fork', sourceId, '--cwd', work], env);
  assert.equal(withCwd.status, EXIT_USAGE);
  assert.match(withCwd.stderr, /--cwd cannot be combined with --fork/);

  const withTitle = run(['agent', 'new', '--fork', sourceId, '--title', 'x'], env);
  assert.equal(withTitle.status, EXIT_USAGE);

  assert.deepEqual(agentIds(root), [sourceId], 'no refused fork leaves a directory behind');
});

test('new refuses a caller-supplied --id', (t) => {
  const { root, env, work } = world(t);
  // Board issue 320: the id is generated, never named by the caller. The flag
  // is refused rather than ignored, so a caller migrating from `new --id <id>`
  // is told the flag is gone instead of believing its id was honoured.
  const named = run(['agent', 'new', '--id', 'a1b2', '--cwd', work], env);
  assert.equal(named.status, EXIT_USAGE);
  assert.match(named.stderr, /--id/);
  assert.equal(existsSync(join(root, 'state', 'antonina', 'agents')), false, 'a refused new creates nothing');
});

test('the help text advertises the fork option and no longer offers --id', (t) => {
  const { env } = world(t);
  const help = run(['agent', 'new', '--help'], env);
  assert.equal(help.status, EXIT_OK, help.stderr);
  assert.match(help.stdout, /--fork/);
  // Both halves of the disclosure, not just the opening clause: the bare prefix
  // match below would survive a rewrite of every sentence after it, which is
  // exactly the defect class this issue exists to remove. The substantive,
  // backend-free check of the same claim is the session contract pair in
  // packages/agent-runtime/test/fork.test.mjs.
  assert.match(help.stdout, /--fork <value>\s+Create the new agent as a snapshot of this existing agent id\./);
  assert.match(help.stdout, /If the source has a backend session, the clone continues it: running both drives one conversation\./);
  assert.match(help.stdout, /There is no per-fork opt-out\./);
  // The id is generated and printed; it is not an input.
  assert.doesNotMatch(help.stdout, /--id/);
  assert.match(help.stdout, /generated id/i);
});
