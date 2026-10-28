// Explicit opt-in real OpenCode V2 end-to-end smoke. Never touches user state.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const bin = process.env.ANTONINA_OPENCODE_V2_BIN;
if (!bin || !bin.startsWith('/')) {
  throw new Error('Set ANTONINA_OPENCODE_V2_BIN to an absolute V2 executable path; never substitute a host V1 backend');
}
const model = process.env.ANTONINA_OPENCODE_V2_MODEL ?? 'opencode/beam-free';
const root = mkdtempSync(join(tmpdir(), 'antonina-opencode-v2-smoke-'));
const cwd = join(root, 'work');
mkdirSync(cwd);
const initialized = spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8' });
assert.equal(initialized.status, 0, 'The V2 session-list smoke requires a real Git project');
for (const path of ['config', 'state', 'cache']) mkdirSync(join(root, path));
const database = join(root, 'agent.db');
const env = {
  ...process.env,
  PWD: cwd,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_STATE_HOME: join(root, 'state'),
  XDG_CACHE_HOME: join(root, 'cache'),
  OPENCODE_DB: database,
};
function execute(args) {
  const result = spawnSync(bin, args, {
    cwd, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    input: '',
  });
  assert.equal(result.error, undefined, 'V2 process failed: ' + String(result.error));
  assert.equal(result.status, 0,
    'V2 process exited ' + result.status + ', stderr: ' + result.stderr.slice(0, 400));
  return result.stdout;
}
function events(output) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
try {
  assert.match(execute(['--version']), /(?:^|\s)v?2\./);
  const fresh = events(execute([
    'run', '--standalone', '--auto', '--format', 'json',
    '--model', model + '#low','--thinking', '--title', 'antonina-v2-smoke', 'Reply with exactly FIRST.',
  ]));
  const first = fresh.find((event) => event.type === 'text');
  assert.ok(first, 'fresh V2 session emitted no text');
  const session = first.sessionID;
  assert.match(session, /^ses_[A-Za-z0-9_]+$/);
  const continued = events(execute([
    'run', '--standalone', '--auto', '--format', 'json',
    '--model', model + '#low','--thinking', '--session', session, 'Reply with exactly SECOND.',
  ]));
  assert.ok(continued.some((event) => event.type === 'text' && event.sessionID === session),
    'V2 did not continue the same durable session');
  const list = JSON.parse(execute(['session', 'list', '--standalone', '--format', 'json', '--max-count', '100']));
  assert.ok(list.some((item) => item.id === session), 'V2 session was not persisted in the isolated database');
  assert.ok(existsSync(database), 'isolated OpenCode V2 SQLite database was not created');
  process.stdout.write('OpenCode V2 smoke passed: session created, resumed and found in isolated DB.\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
