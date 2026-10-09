import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const LAUNCH = resolve('scripts/antonina-scheduler-launch');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const calls = join(root, 'calls.jsonl');
  const cli = join(root, 'fake-antonina');
  const worktrees = join(root, 'fake-worktrees');
  writeFileSync(cli, [
    '#!/usr/bin/env python3',
    'import json,os,sys',
    'a=sys.argv[1:]',
    'with open(os.environ["MOCK_CALLS"],"a") as h: h.write(json.dumps(a)+"\\n")',
    'if a[:2]==["board","show"]: print(json.dumps({"state":"open"}))',
    'elif a[:2]==["agent","status"]: print(json.dumps({"id":a[a.index("--id")+1],"cwd":os.environ.get("MOCK_STATUS_CWD",os.environ["MOCK_WORK"]),"state":os.environ.get("MOCK_STATE","failed"),"alive":os.environ.get("MOCK_ALIVE")=="1"}))',
    'elif a[:2]==["agent","run"]:',
    '  if os.environ.get("MOCK_FAIL")=="1": sys.exit(1)',
    '  print(json.dumps({"id":a[a.index("--id")+1],"state":"running","detached":True}))',
    'elif a[:2] in (["agent","new"],["agent","delete"],["agent","stop"],["board","comment"]): print("{}")',
    'else: sys.exit(7)',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(worktrees, [
    '#!/usr/bin/env python3',
    'import json,os',
    'print(json.dumps([{"path":os.environ["MOCK_WORK"]}]))',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env, ANTONINA_BIN: cli,
    ANTONINA_SCHEDULER_WORKTREES_BIN: worktrees, MOCK_WORK: cwd, MOCK_CALLS: calls };
  const launch = (extra = [], overrides = {}) => spawnSync('python3',
    [LAUNCH, '--issue', '207', '--cwd', cwd, '--title', 'Antonina #207',
      '--summary', 'Recover', '--prompt', 'Reconcile and continue', ...extra, '--json'],
    { encoding: 'utf8', env: { ...env, ...overrides }, timeout: 15_000 });
  const seen = (prefix) => {
    const rows = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    return rows.filter((row) => prefix.every((v, i) => row[i] === v));
  };
  return { launch, seen };
}

test('resume retains original ID, worktree and session; no replacement', (t) => {
  const f = fixture(t);
  const result = f.launch(['--resume-agent', 'a11d']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, 'a11d');
  assert.equal(f.seen(['agent', 'new']).length, 0);
  const runs = f.seen(['agent', 'run']);
  assert.equal(runs.length, 1);
  assert.equal(runs[0][runs[0].indexOf('--id') + 1], 'a11d');
  assert.equal(f.seen(['board', 'comment']).length, 1);
});

test('resume refuses already running agent or another worktree', (t) => {
  for (const overrides of [
    { MOCK_STATE: 'running', MOCK_ALIVE: '1' },
    { MOCK_STATUS_CWD: '/another/worktree' },
  ]) {
    const f = fixture(t);
    const result = f.launch(['--resume-agent', 'a11d'], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(f.seen(['agent', 'run']).length, 0);
  }
});

test('failed resume never deletes an original agent', (t) => {
  const f = fixture(t);
  assert.notEqual(f.launch(['--resume-agent', 'a11d'], { MOCK_FAIL: '1' }).status, 0);
  assert.equal(f.seen(['agent', 'delete']).length, 0);
});

test('fresh launch remains supported', (t) => {
  const f = fixture(t);
  assert.equal(f.launch().status, 0);
  assert.equal(f.seen(['agent', 'new']).length, 1);
  assert.equal(f.seen(['agent', 'run']).length, 1);
});
