// Durable scheduler integration: a synthetic prompt larger than Linux's
// MAX_ARG_STRLEN must start a managed turn through --prompt-file, with the full
// ordered model comments and the complete issue frontier intact.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';

process.env.XDG_STATE_HOME = '/nonexistent-antonina-scheduler-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-scheduler-config';

const root = mkdtempSync(join(tmpdir(), 'antonina-scheduler-prompt-'));
after(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, 'home');
const bin = join(home, '.local/bin');
const state = join(root, 'state');
const evidencePath = join(root, 'evidence.json');
const promptDir = join(state, 'antonina/scheduler-prompts');
const readyFlag = join(root, 'agent-run-ready.flag');
const comment = 'MEGA-COMMENT-MARKER ' + 'operator note line\n'.repeat(14_000);
const issues = Array.from({ length: 120 }, (_, index) => ({
  number: `SYNTH-ISSUE-${String(index + 1).padStart(4, '0')}`,
  title: `synthetic independent front ${index + 1}: ${'x'.repeat(180)}`,
}));

const ANTONINA_STUB = `#!/usr/bin/env python3
import json, os, stat, sys, time
args = sys.argv[1:]
mode = os.environ.get('ANTONINA_TEST_MODE', '')
def emit(obj):
    print(json.dumps(obj, separators=(',', ':')))
if args[:2] == ['agent', 'model'] and args[2:] == ['select']:
    print('opencode-go/hy4-flash-free')
elif args[:2] == ['agent', 'model'] and args[2:] == ['list']:
    print(open(${JSON.stringify(join(root, 'model-config.json'))}).read(), end='')
elif args[:2] == ['agent', 'new']:
    if mode == 'new-fails':
        sys.stderr.write('synthetic agent new failure\\n')
        sys.exit(7)
    print('SYNTH-TURN-AGENT')
elif args[:2] == ['agent', 'run']:
    if mode == 'run-fails':
        sys.stderr.write('synthetic backend failure\\n')
        sys.exit(9)
    if mode == 'run-blocks':
        with open(${JSON.stringify(readyFlag)}, 'w') as ready:
            ready.write(str(os.getpid()))
        time.sleep(60)
    assert '--prompt-file' in args, args
    assert '--prompt' not in args, 'prompt content reached argv'
    path = args[args.index('--prompt-file') + 1]
    info = os.stat(path)
    content = open(path, encoding='utf-8').read()
    assert stat.S_IMODE(info.st_mode) == 0o600, oct(info.st_mode)
    assert info.st_uid == os.getuid()
    assert 'MEGA-COMMENT-MARKER' in content
    assert 'TOKEN-NEVER-IN-ARGV' not in ' '.join(args)
    assert not any('MEGA-COMMENT-MARKER' in value for value in os.environ.values())
    assert not any('SYNTH-ISSUE-0120' in value for value in os.environ.values())
    evidence = {
        'argv': args,
        'prompt_bytes': len(content.encode('utf-8')),
        'mode': oct(stat.S_IMODE(info.st_mode)),
        'comments_present': content.count('MEGA-COMMENT-MARKER'),
        'issues_present': content.count('SYNTH-ISSUE-'),
        'env_has_prompt': any('MEGA-COMMENT-MARKER' in v for v in os.environ.values()),
    }
    with open(${JSON.stringify(evidencePath)}, 'w') as out:
        json.dump(evidence, out)
    emit(evidence)
elif args[:2] == ['agent', 'status']:
    emit({'state': 'clearexit', 'model': 'opencode-go/hy4-flash-free', 'exit_code': 0})
elif args[:2] in (['agent', 'stop'], ['agent', 'delete']):
    emit({'ok': True})
else:
    sys.stderr.write('unexpected stub invocation: ' + repr(args) + '\\n')
    sys.exit(99)
`;

function stub(name, body) {
  writeFileSync(join(bin, name), body, { mode: 0o755 });
}

function installStubs() {
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, 'scheduler-src'), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, 'model-config.json'), JSON.stringify({
    path: '/private/antonina/config.json',
    models: [
      { model: 'opencode-go/hy4-flash-free', comment },
      { model: 'opencode-go/second-free', comment: 'second ordered model' },
    ],
  }));
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify({
    live_agents: [], orphan_agents: [], active_local_leases: [],
    recent_terminal_agents: { agents: [], incomplete: false },
    unverified_terminal_issues: [], open_issue_count: issues.length, open_issues: issues,
  }));
  stub('antonina-scheduler-snapshot', `#!/bin/sh\ncat ${join(root, 'snapshot.json')}\n`);
  stub('antonina', ANTONINA_STUB);
}

function schedulerEnv(mode) {
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: state,
    PATH: bin + ':' + process.env.PATH,
    EVIDENCE: evidencePath,
    ...(mode ? { ANTONINA_TEST_MODE: mode } : {}),
  };
}

function runScheduler(mode) {
  return spawnSync('sh', [resolve('host-integration/antonina-orchestrator-turn.prompt-file')], {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 30_000,
    env: schedulerEnv(mode),
  });
}

test('a 250 KiB scheduler prompt starts without E2BIG', () => {
  installStubs();
  const result = runScheduler();
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.doesNotMatch(result.stderr + result.stdout, /E2BIG|Argument list too long|exit 126/);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  assert.ok(evidence.prompt_bytes > 250 * 1024, `only ${evidence.prompt_bytes} bytes`);
  assert.equal(evidence.mode, '0o600');
  assert.equal(evidence.comments_present, 1);
  assert.equal(evidence.issues_present, 120);
  assert.equal(evidence.env_has_prompt, false);
  assert.ok(evidence.argv.includes('--prompt-file'));
  assert.ok(!evidence.argv.includes('--prompt'));
  assert.deepEqual(readdirSync(promptDir), []);
});

test('a failed agent new never strands the private prompt file', () => {
  installStubs();
  const result = runScheduler('new-fails');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic agent new failure/);
  assert.deepEqual(readdirSync(promptDir), []);
});

test('a failed agent run never strands the private prompt file', () => {
  installStubs();
  const result = runScheduler('run-fails');
  assert.equal(result.status, 9);
  assert.match(result.stderr, /synthetic backend failure/);
  assert.deepEqual(readdirSync(promptDir), []);
});

test('a cancelled scheduler turn removes the private prompt file', async () => {
  installStubs();
  rmSync(readyFlag, { force: true });
  const child = spawn('sh', [resolve('host-integration/antonina-orchestrator-turn.prompt-file')], {
    cwd: resolve('.'),
    env: schedulerEnv('run-blocks'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 10_000;
    while (!(existsSync(readyFlag) && readdirSync(promptDir).length === 1)) {
      if (Date.now() > deadline) throw new Error(`turn never reached blocked agent run; stderr: ${stderr}`);
      await new Promise((done) => setTimeout(done, 25));
    }
    // GNU timeout places its command in a separate process group, so signal
    // the blocked backend by its recorded PID and signal the turn shell too.
    // The shell's TERM trap fires once its foreground command returns.
    const backendPid = Number(readFileSync(readyFlag, 'utf8').trim());
    process.kill(child.pid, 'SIGTERM');
    process.kill(backendPid, 'SIGTERM');
    const [code] = await exited;
    assert.notEqual(code, 0, `cancelled turn should fail; stderr: ${stderr}`);
    assert.deepEqual(readdirSync(promptDir), [], 'cancelled turn stranded its private prompt file');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await exited;
    }
  }
});

test('the same prompt cannot be passed as a single argv string', () => {
  const huge = Buffer.alloc(270 * 1024, 0x78).toString('utf8');
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)', huge], { encoding: 'utf8' });
  assert.ok(result.error, 'expected the kernel to refuse an oversized argv string');
  assert.match(String(result.error.code), /E2BIG/);
});
