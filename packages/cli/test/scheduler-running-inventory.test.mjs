import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const SNAPSHOT = join(scripts, 'antonina-scheduler-snapshot');
const WORKTREES = join(scripts, 'antonina-scheduler-worktrees');

function fixture(t, { agentPages, issues = [], resources = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-scheduler-live-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const cli = join(home, '.local', 'bin', 'antonina');
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(join(root, 'state'));
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'issues-1.json'), JSON.stringify(issues));
  writeFileSync(join(root, 'resources-1.json'), JSON.stringify(resources));
  agentPages.forEach((agents, index) =>
    writeFileSync(join(root, `agents-${index + 1}.json`), JSON.stringify(agents)),
  );
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
let file, fallback;
if (args[0] === 'agent' && args[1] === 'list' && args.includes('--running')) {
  file = 'agents-' + option('--page') + '.json';
  fallback = { agents: [] };
} else if (args[0] === 'board' && args[1] === 'list') {
  file = 'issues-' + option('--page') + '.json';
  fallback = [];
} else if (args[0] === 'board' && args[1] === 'resource' && args[2] === 'list') {
  file = 'resources-' + option('--page') + '.json';
  fallback = [];
} else {
  process.stderr.write('unexpected test CLI invocation: ' + args.join(' ') + '\\n');
  process.exit(4);
}
const fixture = path.join(process.env.ANTONINA_TEST_FIXTURE_ROOT, file);
process.stdout.write(fs.existsSync(fixture) ? fs.readFileSync(fixture, 'utf8') : JSON.stringify(fallback));
`);
  chmodSync(cli, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    ANTONINA_TEST_FIXTURE_ROOT: root,
  };
  const exec = (script, args = []) =>
    spawnSync('python3', [script, ...args], { env, encoding: 'utf8', timeout: 15_000 });
  return { root, exec };
}

function requirePython(t) {
  const result = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    t.skip('the scheduler scripts require python3');
    return false;
  }
  return true;
}

test('a continued agent is live without an OpenCode --title process argument', (t) => {
  if (!requirePython(t)) return;
  const root = mkdtempSync(join(tmpdir(), 'antonina-cwd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owned = join(root, 'owned');
  const free = join(root, 'free');
  mkdirSync(owned);
  mkdirSync(free);
  const agent = {
    id: 'f00d', state: 'running', title: 'AssemblyP1 94 continuation', cwd: owned,
  };
  const { exec } = fixture(t, {
    agentPages: [{ agents: [agent], unreadable: [] }],
    issues: [{ number: 94, title: 'AssemblyP1 proof task' }],
    resources: [{ path: owned, host: 'marceline-dev' }, { path: free, host: 'marceline-dev' }],
  });

  const snapshot = exec(SNAPSHOT);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const state = JSON.parse(snapshot.stdout);
  assert.deepEqual(state.live_agents.map((a) => a.id), ['f00d']);
  assert.deepEqual(state.represented_projects, ['AssemblyP1']);
  assert.deepEqual(state.live_issue_numbers, [94]);
  assert.deepEqual(state.unrepresented_projects, []);

  const worktrees = exec(WORKTREES, ['--issue', '94', '--json']);
  assert.equal(worktrees.status, 0, worktrees.stderr);
  assert.deepEqual(JSON.parse(worktrees.stdout), [{ path: free, host: 'marceline-dev' }]);
});

test('running-agent inventory traverses later pages when more than 500 agents exist', (t) => {
  if (!requirePython(t)) return;
  const root = mkdtempSync(join(tmpdir(), 'antonina-cwd-pages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owned = join(root, 'owned');
  mkdirSync(owned);
  const filler = Array.from({ length: 500 }, (_, i) => ({
    id: `misc-${i}`, state: 'running', title: 'unrelated', cwd: null,
  }));
  const { exec } = fixture(t, {
    agentPages: [
      { agents: filler, unreadable: [] },
      { agents: [{ id: 'later', state: 'running', title: 'AssemblyP1 94 continuation', cwd: owned }], unreadable: [] },
    ],
    issues: [{ number: 94, title: 'AssemblyP1 proof task' }],
    resources: [{ path: owned, host: 'marceline-dev' }],
  });

  const snapshot = exec(SNAPSHOT);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(JSON.parse(snapshot.stdout).live_agents.length, 501);

  const worktrees = exec(WORKTREES, ['--issue', '94', '--json']);
  assert.equal(worktrees.status, 0, worktrees.stderr);
  assert.deepEqual(JSON.parse(worktrees.stdout), []);
});

test('unreadable agent inventory refuses to pronounce a worktree unoccupied', (t) => {
  if (!requirePython(t)) return;
  const { exec } = fixture(t, {
    agentPages: [{ agents: [], unreadable: [{ id: 'unknown', reason: 'unreadable' }] }],
  });
  for (const [script, args] of [[SNAPSHOT, []], [WORKTREES, ['--issue', '94', '--json']]]) {
    const result = exec(script, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete ownership data/);
  }
});
