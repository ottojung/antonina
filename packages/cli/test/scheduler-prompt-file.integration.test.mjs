// Durable scheduler integration: a synthetic prompt larger than Linux's
// MAX_ARG_STRLEN must start a managed turn through --prompt-file, with the full
// ordered model comments and the complete issue frontier intact.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
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
const comment = 'MEGA-COMMENT-MARKER ' + 'operator note line\n'.repeat(14_000);
const issues = Array.from({ length: 120 }, (_, index) => ({
  number: `SYNTH-ISSUE-${String(index + 1).padStart(4, '0')}`,
  title: `synthetic independent front ${index + 1}: ${'x'.repeat(180)}`,
}));

const ANTONINA_STUB = `#!/usr/bin/env python3
import json, os, stat, sys
args = sys.argv[1:]
def emit(obj):
    print(json.dumps(obj, separators=(',', ':')))
if args[:2] == ['agent', 'model'] and args[2:] == ['select']:
    print('opencode-go/hy4-flash-free')
elif args[:2] == ['agent', 'model'] and args[2:] == ['list']:
    print(open(${JSON.stringify(join(root, 'model-config.json'))}).read(), end='')
elif args[:2] == ['agent', 'new']:
    print('SYNTH-TURN-AGENT')
elif args[:2] == ['agent', 'run']:
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

function runScheduler() {
  return spawnSync('sh', [resolve('host-integration/antonina-orchestrator-turn.prompt-file')], {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: state,
      PATH: bin + ':' + process.env.PATH,
      EVIDENCE: evidencePath,
    },
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
  assert.deepEqual(readdirSync(join(state, 'antonina/scheduler-prompts')), []);
});

test('the same prompt cannot be passed as a single argv string', () => {
  const huge = Buffer.alloc(270 * 1024, 0x78).toString('utf8');
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)', huge], { encoding: 'utf8' });
  assert.ok(result.error, 'expected the kernel to refuse an oversized argv string');
  assert.match(String(result.error.code), /E2BIG/);
});
