// Explicit opt-in integration against one isolated V2 background service.
// Two agents in distinct Git projects must share one server and database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHostV2Service } from '../packages/agent-runtime/dist/packages/agent-runtime/src/backend.js';

const bin = process.env.ANTONINA_OPENCODE_V2_BIN;
if (!bin || !bin.startsWith('/')) throw new Error('Set absolute ANTONINA_OPENCODE_V2_BIN for V2 testing');
const model = process.env.ANTONINA_OPENCODE_V2_MODEL ?? 'opencode/beam-free';
const root = mkdtempSync(join(tmpdir(), 'antonina-v2-shared-smoke-'));
const workA = join(root, 'agent-a');
const workB = join(root, 'agent-b');
for (const dir of [workA, workB]) {
  mkdirSync(dir);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0);
}
const svc = join(root, 'service');
for (const kind of ['config', 'state', 'data', 'cache']) mkdirSync(join(svc, kind), { recursive: true });
const database = join(svc, 'opencode.db');
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(svc, 'config'),
  XDG_STATE_HOME: join(svc, 'state'),
  XDG_DATA_HOME: join(svc, 'data'),
  XDG_CACHE_HOME: join(svc, 'cache'),
  OPENCODE_DB: database,
};
// Deliberately supply invocation markers during bootstrap. The server MUST
// still start with them removed, or orphan cleanup for agent A could kill
// all agents' work in the shared service.
const pinnedServer = ensureHostV2Service(bin, {
  ...env, ANTONINA_AGENT_ID: 'smoke-agent-a',
  ANTONINA_INVOCATION_ID: 'smoke-invocation-a',
}, workA);
assert.match(pinnedServer, /^http:\/\/127\.0\.0\.1:\d+$/);
if (existsSync('/proc')) {
  const candidateServices = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const pe = readFileSync('/proc/' + pid + '/environ').toString('latin1');
      if (!pe.includes('OPENCODE_DB=' + database + '\0')) continue;
      const pc = readFileSync('/proc/' + pid + '/cmdline').toString('latin1');
      if (!pc.includes('serve\0--service')) continue;
      candidateServices.push(pe);
    } catch { /* unrelated process exited or is unreadable */ }
  }
  assert.equal(candidateServices.length, 1, 'expected one persistent host V2 server');
  assert.ok(!candidateServices[0].includes('ANTONINA_AGENT_ID='));
  assert.ok(!candidateServices[0].includes('ANTONINA_INVOCATION_ID='));
}
function execute(args, cwd = workA) {
  const result = spawnSync(bin, args, {
    cwd, env: { ...env, PWD: cwd }, encoding: 'utf8', timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024, input: '',
  });
  assert.equal(result.error, undefined, 'V2 failed to launch: ' + String(result.error));
  assert.equal(result.status, 0,
    'V2 process failed ' + result.status + ': stderr=' + result.stderr.slice(0, 600) + ' stdout=' + result.stdout.slice(0, 1200));
  return result.stdout;
}
function events(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
try {
  assert.match(execute(['--version']), /(?:^|\s)v?2\./);
  const first = events(execute([
    'run', '--auto', '--format', 'json', '--model', model + '#low', '--thinking',
    '--title', 'antonina-shared-a', 'Reply with exactly FIRST.',
  ]));
  const sessionA = first.find((event) => event.type === 'text')?.sessionID;
  assert.match(sessionA, /^ses_[A-Za-z0-9_]+$/);
  const serviceA = execute(['service', 'status']);
  const second = events(execute([
    'run', '--auto', '--format', 'json', '--model', model + '#low', '--thinking',
    '--title', 'antonina-shared-b', 'Reply with exactly SECOND.',
  ], workB));
  const sessionB = second.find((event) => event.type === 'text')?.sessionID;
  assert.match(sessionB, /^ses_[A-Za-z0-9_]+$/);
  assert.notEqual(sessionA, sessionB, 'different agents must own different sessions');
  const serviceB = execute(['service', 'status'], workB);
  assert.match(serviceA, /^http:\/\/127\.0\.0\.1:\d+/);
  assert.equal(serviceA, serviceB, 'the agents did not connect to the same background service');
  const continued = events(execute([
    'run', '--auto', '--format', 'json', '--model', model + '#low', '--thinking',
    '--session', sessionA, 'Reply with exactly CONTINUED.',
  ]));
  assert.ok(continued.some((event) => event.type === 'text' && event.sessionID === sessionA));
  const forked = JSON.parse(execute(['api', 'session.fork', '--param', 'sessionID=' + sessionA, '--data', '{}']));
  const forkSession = forked.data?.id ?? forked.id;
  assert.match(forkSession, /^ses_[A-Za-z0-9_]+$/, 'V2 did not produce a distinct child session');
  assert.notEqual(forkSession, sessionA);
  const interrupt = JSON.parse(execute(['api', 'session.interrupt', '--param', 'sessionID=' + forkSession, '--param', 'resume=false']));
  assert.ok(interrupt && typeof interrupt === 'object', 'session-specific interrupt returned no response');
  const listA = JSON.parse(execute(['session', 'list', '--format', 'json', '--max-count', '100']));
  const listB = JSON.parse(execute(['session', 'list', '--format', 'json', '--max-count', '100'], workB));
  assert.ok(listA.some((item) => item.id === sessionA));
  assert.ok(listB.some((item) => item.id === sessionB));
  assert.ok(existsSync(database));
  process.stdout.write('OpenCode V2 shared-service smoke passed: two projects, one unmarked shared service, auto-discovered clients, durable isolated sessions.\n');
} finally {
  // The smoke MUST stop its isolated server; never touch the operator's service.
  spawnSync(bin, ['service', 'stop'], {
    cwd: workA, env: { ...env, PWD: workA }, encoding: 'utf8', timeout: 15_000,
  });
  rmSync(root, { recursive: true, force: true });
}
