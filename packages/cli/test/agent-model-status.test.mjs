import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { idleMeta } from '../../agent-runtime/dist/packages/agent-runtime/src/metadata.js';
import { createAgentDirectory, writeMeta } from '../../agent-runtime/dist/packages/agent-runtime/src/store.js';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');

test('status reports witnessed models, never configuration or speculative selection', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-model-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  mkdirSync(env.XDG_STATE_HOME, { recursive: true });
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  const options = { env };
  const id = 'model-status-test';
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, root, 'test');
  meta.model_failover = { selected_model: 'example.test/not-launched', cooldowns: [] };
  writeMeta(id, meta, options);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'agent', 'status', '--id', id, ...args], { env, encoding: 'utf8' });
  const status = () => {
    const r = run('--json');
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(status().model, null);
  assert.deepEqual(status().models_used, []);
  assert.match(run().stdout, /model:\s+not observed/);
  meta.observed_models = ['example.test/first', 'example.test/actual'];
  writeMeta(id, meta, options);
  assert.equal(status().model, 'example.test/actual');
  assert.deepEqual(status().models_used, ['example.test/first', 'example.test/actual']);
  const human = run();
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /model:\s+example\.test\/actual/);
  assert.match(human.stdout, /models used:\s+example\.test\/first, example\.test\/actual/);
  // Human-facing timestamps are local calendar time with version-style age,
  // but structured JSON keeps seconds since the epoch for automation.
  assert.match(human.stdout, /^created:    \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \(.+ ago\)$/m);
  assert.match(human.stdout, /^started:    -$/m);
  assert.match(human.stdout, /^finished:   -$/m);
  assert.equal(typeof status().created_at, 'number');
  meta.state = 'clearexit';
  meta.started_at = meta.created_at;
  meta.finished_at = meta.created_at;
  meta.exit_code = 0;
  writeMeta(id, meta, options);
  const terminal = run();
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.match(terminal.stdout, /^state: {6}clearexit$/m);
  assert.match(terminal.stdout, /^started:    \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \(.+ ago\)$/m);
  assert.match(terminal.stdout, /^finished:   \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \(.+ ago\)$/m);
  assert.equal(typeof status().finished_at, 'number');
});
