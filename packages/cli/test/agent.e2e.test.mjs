import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-cli-e2e-'));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  const opencode = join(bin, 'opencode');
  writeFileSync(opencode, `#!/bin/sh
case "$1" in
  models)
    echo "opencode/space-bunny-free"
    exit 0
    ;;
  session)
    echo '[{"id":"ses_fake","title":"antonina-a11d","created":100},{"id":"ses_beef","title":"antonina-beef","created":100}]'
    exit 0
    ;;
  run)
    if [ -n "$ANTONINA_TEST_CALLS" ]; then
      printf '%s\n' "$*" >>"$ANTONINA_TEST_CALLS"
    fi
    last=""
    for arg in "$@"; do last="$arg"; done
    if [ "$last" = "slow" ]; then
      echo "slow-start"
      sleep 30
      exit 0
    fi
    if [ "$last" = "server-error" ]; then
      echo '{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_e2e"}}'
      exit 1
    fi
    echo "FAKE:$last"
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
`);
  chmodSync(opencode, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    XDG_STATE_HOME: join(root, 'state'),
    ANTONINA_TEST_CALLS: join(root, 'opencode-calls.log'),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, work, env };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 15_000 });
}

function metaPath(root, id) {
  return join(root, 'state', 'antonina', 'agents', id, 'meta.json');
}

async function waitFor(root, id, predicate, timeoutMs = 8_000) {
  const path = metaPath(root, id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8'));
      if (predicate(meta)) return meta;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for agent ${id}`);
}

test('built CLI runs a fresh prompt then continues the discovered OpenCode session', async (t) => {
  const { root, work, env } = fixture(t);
  const created = run(['agent', 'new', '--id', 'a11d', '--cwd', work, '--json'], env);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).state, 'idle');

  const first = run(['agent', 'prompt', '--id', 'a11d', '--detach', 'hello'], env);
  assert.equal(first.status, 0, first.stderr);
  const firstDone = await waitFor(root, 'a11d', (meta) => meta.state === 'succeeded' && meta.active_runner === false);
  assert.equal(firstDone.native_session_id, 'ses_fake');
  assert.equal(firstDone.prompt_count, 1);

  const second = run(['agent', 'prompt', '--id', 'a11d', '--detach', 'again'], env);
  assert.equal(second.status, 0, second.stderr);
  const secondDone = await waitFor(root, 'a11d', (meta) => meta.state === 'succeeded' && meta.prompt_count === 2 && meta.active_runner === false);
  assert.equal(secondDone.native_session_id, 'ses_fake');
  const log = readFileSync(join(root, 'state', 'antonina', 'agents', 'a11d', 'output.log'), 'utf8');
  assert.match(log, /FAKE:hello/);
  assert.match(log, /FAKE:again/);
});

test('hard steer interrupts the running process group and drains redirect FIFO', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'beef', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'beef', '--detach', 'slow'], env).status, 0);
  await waitFor(root, 'beef', (meta) => meta.state === 'running' && typeof meta.pid === 'number');

  const steer = run(['agent', 'prompt', '--id', 'beef', '--steer', '--detach', 'redirect'], env);
  assert.equal(steer.status, 0, steer.stderr);
  const done = await waitFor(root, 'beef', (meta) => meta.state === 'succeeded' && meta.prompt_count === 2 && meta.active_runner === false, 12_000);
  assert.equal(done.native_session_id, 'ses_beef');
  const log = readFileSync(join(root, 'state', 'antonina', 'agents', 'beef', 'output.log'), 'utf8');
  assert.match(log, /slow-start/);
  assert.match(log, /FAKE:redirect/);
});

test('ordinary prompt remains busy while an invocation is running', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'cafe', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'cafe', '--detach', 'slow'], env).status, 0);
  await waitFor(root, 'cafe', (meta) => meta.state === 'running' && typeof meta.pid === 'number');
  const busy = run(['agent', 'prompt', '--id', 'cafe', '--detach', 'second'], env);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /still running/);
  const killed = run(['agent', 'kill', '--id', 'cafe'], env);
  assert.equal(killed.status, 0, killed.stderr);
});


test('stale reserved work is recovered without overwriting the accepted prompt', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'd00d', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'd00d');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    active_runner: true,
    pending_prompt: 'accepted',
    prompt_count: 1,
    runner_gen: 1,
    runner_reservation: {
      state: 'reserved',
      gen: 1,
      mode: 'new',
      owner_pid: 99999999,
      owner_start_ticks: 1,
      reserved_at: 1,
    },
    started_at: 1,
  });
  writeFileSync(path, JSON.stringify(meta));

  const recovery = run(['agent', 'prompt', '--id', 'd00d', '--detach', 'replacement'], env);
  assert.equal(recovery.status, 1);
  assert.match(recovery.stderr, /recovering an already accepted prompt/);
  const done = await waitFor(root, 'd00d', (value) => value.state === 'succeeded' && value.active_runner === false);
  assert.equal(done.prompt_count, 1);
  const log = readFileSync(join(root, 'state', 'antonina', 'agents', 'd00d', 'output.log'), 'utf8');
  assert.match(log, /FAKE:accepted/);
  assert.doesNotMatch(log, /FAKE:replacement/);
});

test('status reconciles abandoned running metadata to an explicit failure', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'dead', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'dead');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    active_runner: false,
    pending_prompt: null,
    runner_reservation: null,
    pid: 99999999,
    pgid: 99999999,
    start_time: 1,
    invocation_id: 'a'.repeat(32),
    started_at: 1,
  });
  writeFileSync(path, JSON.stringify(meta));

  const status = run(['agent', 'status', '--id', 'dead', '--json'], env);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, 'failed');
  assert.match(readFileSync(path, 'utf8'), /disappeared without a captured exit status/);
});


test('stop on idle is a no-op and preserves idle state', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'fade', '--cwd', work], env).status, 0);
  const stopped = run(['agent', 'stop', '--id', 'fade'], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /already stopped/);
  const meta = JSON.parse(readFileSync(metaPath(root, 'fade'), 'utf8'));
  assert.equal(meta.state, 'idle');
});

test('clean dry-run observes and clean removes old terminal agents', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'f00d', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'f00d');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, { state: 'succeeded', finished_at: 1, active_runner: false });
  writeFileSync(path, JSON.stringify(meta));

  const dry = run(['agent', 'clean', '--days', '1', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /f00d/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'succeeded');

  const clean = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /deleted agent f00d/);
  assert.throws(() => readFileSync(path, 'utf8'));
});


test('delete without force refuses live work and force converges before removal', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'feed', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'feed', '--detach', 'slow'], env).status, 0);
  await waitFor(root, 'feed', (meta) => meta.state === 'running' && typeof meta.pid === 'number');

  const refused = run(['agent', 'delete', '--id', 'feed'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /use --force/);
  assert.equal(JSON.parse(readFileSync(metaPath(root, 'feed'), 'utf8')).state, 'running');

  const forced = run(['agent', 'delete', '--id', 'feed', '--force'], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /deleted agent feed/);
  assert.throws(() => readFileSync(metaPath(root, 'feed'), 'utf8'));
});

test('delete tombstone blocks later prompt reservation', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'face', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'face');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.delete_pending = true;
  writeFileSync(path, JSON.stringify(meta));

  const prompt = run(['agent', 'prompt', '--id', 'face', '--detach', 'must-not-run'], env);
  assert.equal(prompt.status, 1);
  assert.match(prompt.stderr, /still running|redirect/);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.pending_prompt ?? null, null);
  assert.equal(after.active_runner, false);
  assert.equal(after.prompt_count, 0);
});


test('backend server failure is persisted and sanitized through status', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'bad1', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'bad1', '--detach', 'server-error'], env).status, 0);
  await waitFor(root, 'bad1', (meta) => meta.state === 'failed' && meta.active_runner === false);

  const status = run(['agent', 'status', '--id', 'bad1', '--json'], env);
  assert.equal(status.status, 0, status.stderr);
  const body = JSON.parse(status.stdout);
  assert.equal(body.state, 'failed');
  assert.equal(body.backend_error.classification, 'transient_backend_server_error');
  assert.equal(body.backend_error.reference, 'err_e2e');
  assert.equal(body.backend_error.automatic_retry_safe, false);
  assert.equal(body.backend_error.request_boundary, 'fresh_session');
});


test('prompt recovers an existing OpenCode session when durable session id was lost', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'a11d', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'a11d', '--detach', 'first'], env).status, 0);
  await waitFor(root, 'a11d', (meta) => meta.state === 'succeeded' && meta.active_runner === false);

  const path = metaPath(root, 'a11d');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.native_session_id = null;
  writeFileSync(path, JSON.stringify(meta));

  assert.equal(run(['agent', 'prompt', '--id', 'a11d', '--detach', 'recovered'], env).status, 0);
  const done = await waitFor(
    root,
    'a11d',
    (value) => value.state === 'succeeded' && value.prompt_count === 2 && value.active_runner === false,
  );
  assert.equal(done.native_session_id, 'ses_fake');

  const calls = readFileSync(env.ANTONINA_TEST_CALLS, 'utf8');
  assert.match(calls, /run --auto --session ses_fake .* recovered/);
});


test('agent ids canonicalize at every CLI boundary and preserve exit-code distinctions', (t) => {
  const { root, work, env } = fixture(t);
  const created = run(['agent', 'new', '--id', 'A11CE', '--cwd', work], env);
  assert.equal(created.status, 0, created.stderr);
  assert.doesNotThrow(() => readFileSync(metaPath(root, 'a11ce'), 'utf8'));

  for (const id of ['a11ce', 'A11CE', 'a11Ce']) {
    const status = run(['agent', 'status', '--id', id, '--json'], env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).id, 'a11ce');
  }

  assert.equal(run(['agent', 'status', '--id', 'not-hex', '--json'], env).status, 2);
  assert.equal(run(['agent', 'status', '--id', 'deadbeef', '--json'], env).status, 3);
});

test('list and status fail closed on malformed or old metadata', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'cab1e', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'cab1e');

  let meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.created_at = {};
  writeFileSync(path, JSON.stringify(meta));

  const status = run(['agent', 'status', '--id', 'cab1e', '--json'], env);
  assert.equal(status.status, 1);
  assert.match(status.stderr, /created_at is malformed/);

  const listed = run(['agent', 'list', '--json'], env);
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /created_at is malformed/);

  meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.created_at = 1;
  meta.agent_version = 3;
  writeFileSync(path, JSON.stringify(meta));
  const oldVersion = run(['agent', 'status', '--id', 'cab1e', '--json'], env);
  assert.equal(oldVersion.status, 1);
  assert.match(oldVersion.stderr, /unsupported managed-agent metadata version: 3/);

  meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.agent_version = 4;
  delete meta.active_runner;
  writeFileSync(path, JSON.stringify(meta));
  const missing = run(['agent', 'status', '--id', 'cab1e', '--json'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /metadata fields are not canonical/);
});

test('prompt rejects malformed durable execution configuration before reservation', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'c0de', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'c0de');

  const malformedCwd = JSON.parse(readFileSync(path, 'utf8'));
  malformedCwd.cwd = 'relative';
  writeFileSync(path, JSON.stringify(malformedCwd));
  const cwdPrompt = run(['agent', 'prompt', '--id', 'c0de', '--detach', 'must-not-run'], env);
  assert.equal(cwdPrompt.status, 1);
  assert.match(cwdPrompt.stderr, /cwd is malformed/);
  let after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.prompt_count, 0);
  assert.equal(after.active_runner, false);

  after.cwd = work;
  after.variant = '';
  writeFileSync(path, JSON.stringify(after));
  const variantPrompt = run(['agent', 'prompt', '--id', 'c0de', '--detach', 'must-not-run'], env);
  assert.equal(variantPrompt.status, 1);
  assert.match(variantPrompt.stderr, /variant is malformed/);
  after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.prompt_count, 0);
  assert.equal(after.active_runner, false);
});

test('legacy top-level agent command spellings are not accepted', (t) => {
  const { env } = fixture(t);
  const result = run(['list', '--json'], env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /expected "agent" or "board"/);
});


test('attached prompt streams output and returns invocation status', (t) => {
  const { work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'ac1d', '--cwd', work], env).status, 0);
  const prompt = run(['agent', 'prompt', '--id', 'ac1d', 'attached'], env);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /FAKE:attached/);
});

test('graceful stop and wait timeout expose stable lifecycle results', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', '5a0f', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', '5a0f', '--detach', 'slow'], env).status, 0);
  await waitFor(root, '5a0f', (meta) => meta.state === 'running' && typeof meta.pid === 'number');

  const timed = run(['agent', 'wait', '--id', '5a0f', '--timeout', '1'], env);
  assert.equal(timed.status, 124);
  assert.match(timed.stderr, /still running after 1s/);

  const stopped = run(['agent', 'stop', '--id', '5a0f'], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  const meta = JSON.parse(readFileSync(metaPath(root, '5a0f'), 'utf8'));
  assert.equal(meta.state, 'stopped');

  const waited = run(['agent', 'wait', '--id', '5a0f', '--timeout', '1'], env);
  assert.equal(waited.status, 1);
});

test('status exposes canonical and malformed steer metadata', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', '57ee', '--cwd', work], env).status, 0);
  const path = metaPath(root, '57ee');
  let meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.steer_seq = 2;
  meta.steer_queue = [{ seq: 2, prompt: 'first line\nsecond line', queued_at: 1.5 }];
  meta.intent = 'steer';
  writeFileSync(path, JSON.stringify(meta));

  let status = JSON.parse(run(['agent', 'status', '--id', '57ee', '--json'], env).stdout);
  assert.equal(status.steers_pending, 1);
  assert.equal(status.next_steer, 'first line');
  assert.equal(status.steer_preempting, true);
  assert.equal(status.steer_metadata_error, null);

  meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.intent = null;
  meta.steer_seq = false;
  meta.steer_queue = [];
  writeFileSync(path, JSON.stringify(meta));
  const malformed = run(['agent', 'status', '--id', '57ee', '--json'], env);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /steer_seq is malformed/);
});
