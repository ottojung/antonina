import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAgentCommand } from '../dist/packages/cli/src/agent.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

function fixture(t) {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-managed-cache-'));
  const work = join(root, 'work');
  nodeFs.mkdirSync(work, { recursive: true });
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    work,
    state: {
      env: { XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') },
      home: join(root, 'home'),
    },
  };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdoutRaw: (t) => out.push(t) } };
}

function context(work, state, io, extra = {}) {
  return { env: { ...state.env, PATH: '' }, home: state.home, cwd: work, io, ...extra };
}

function seed(id, work, state, mutate) {
  assert.equal(createAgentDirectory(id, state), true);
  const meta = idleMeta(id, work, null, 1);
  mutate?.(meta);
  writeMeta(id, meta, state);
}

test('agent cache --init refuses a delete-pending agent (init vs terminal deletion race)', async (t) => {
  const { work, state } = fixture(t);
  seed('cache-del', work, state, (meta) => { meta.delete_pending = true; });
  const out = capture();
  const code = await runAgentCommand(['cache', '--id', 'cache-del', '--init'], context(work, state, out.io));
  assert.notEqual(code, 0);
  assert.match(out.err.join('\n'), /being deleted/);
  const cachePath = join(state.env.XDG_STATE_HOME, 'antonina', 'build-cache', 'cache-del', 'target');
  assert.equal(nodeFs.existsSync(cachePath), false);
});

test('agent cache --init registers and prints dedicated path', async (t) => {
  const { work, state } = fixture(t);
  seed('cache-ok', work, state);
  const out = capture();
  const code = await runAgentCommand(['cache', '--id', 'cache-ok', '--init'], context(work, state, out.io));
  assert.equal(code, 0, out.err.join('\n'));
  const expected = join(state.env.XDG_STATE_HOME, 'antonina', 'build-cache', 'cache-ok', 'target');
  assert.equal(out.out.join('\n').trim(), expected);
  assert.equal(nodeFs.existsSync(expected), true);
  assert.equal(nodeFs.existsSync(join(state.env.XDG_STATE_HOME, 'antonina', 'build-cache', 'cache-ok', 'managed-cache.json')), true);
});
