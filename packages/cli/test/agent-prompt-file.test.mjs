// Prompt-file transport: the CLI boundary accepts a path or stdin, never a
// 250 KiB prompt in argv or env. No ambient Antonina state is touched here.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { MAX_PROMPT_BYTES, readPromptFile, readPromptStdin } from '../dist/packages/agent-runtime/src/prompt-file.js';
import { preparePublicCommand } from '../dist/packages/cli/src/public-cli.js';

// The validation helpers only read the files the test creates; pinning both
// XDG roots also makes any future accidental state access fail loudly.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-prompt-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-prompt-config';
const root = mkdtempSync(join(tmpdir(), 'antonina-prompt-file-'));
after(() => rmSync(root, { recursive: true, force: true }));

function file(name, bytes, mode = 0o600) {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode });
  return path;
}

test('a 250 KiB private UTF-8 prompt is read byte for byte', () => {
  const body = 'Ω scheduler frontier\n'.repeat(12_000);
  assert.ok(Buffer.byteLength(body) > 250 * 1024);
  const path = file('large.prompt', body);
  assert.equal(readPromptFile(path), body);
});

test('prompt file validation is deterministic and never echoes content', () => {
  const secret = 'TOP-SECRET-PROMPT-BODY';
  const cases = [
    ['relative path', 'relative.prompt', /path must be absolute/],
    ['symlink', symlinkTarget(), /regular file, not a symlink/],
    ['world-readable', file('world.prompt', secret, 0o644), /group- or world-accessible/],
    ['empty', file('empty.prompt', ''), /prompt is empty/],
    ['invalid UTF-8', file('bad.prompt', Buffer.from([0xff, 0xfe])), /not valid UTF-8/],
  ];
  for (const [name, path, expected] of cases) {
    assert.throws(() => readPromptFile(path), expected, name);
    try { readPromptFile(path); } catch (error) { assert.ok(!error.message.includes(secret)); }
  }
  assert.ok(MAX_PROMPT_BYTES >= 250 * 1024);
});

function symlinkTarget() {
  const target = file('target.prompt', 'data');
  const link = join(root, 'link.prompt');
  symlinkSync(target, link);
  return link;
}

test('stdin prompts use the same bounds and UTF-8 rules as files', () => {
  const body = 'stdin frontier\n'.repeat(20_000);
  const path = file('stdin.prompt', body);
  const fd = openSync(path, 'r');
  try {
    assert.equal(readPromptStdin(fd), body);
  } finally {
    closeSync(fd);
  }
  const bad = openSync(file('bad-stdin.prompt', Buffer.from([0xff])), 'r');
  try {
    assert.throws(() => readPromptStdin(bad), /not valid UTF-8/);
  } finally {
    closeSync(bad);
  }
});

test('the public run command forwards file and stdin prompt sources', () => {
  assert.equal(preparePublicCommand('agent', ['run', '--id', 'a11d', '--prompt-file', '/private/prompt']).args
    .join(' '), 'run --id a11d --prompt-file /private/prompt');
  assert.equal(preparePublicCommand('agent', ['run', '--id', 'a11d', '--prompt-stdin']).args
    .join(' '), 'run --id a11d --prompt-stdin');
});

test('this suite never sees ambient Antonina state', () => {
  assert.equal(process.env.XDG_STATE_HOME, '/nonexistent-antonina-prompt-state');
  assert.equal(process.env.XDG_CONFIG_HOME, '/nonexistent-antonina-prompt-config');
});
