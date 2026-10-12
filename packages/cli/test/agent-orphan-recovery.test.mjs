// Board #282: interrupted first metadata publication must never freeze every
// independent scheduler front. These tests use isolated XDG roots only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-282-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') };
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  return { root, env };
}
function dir(root, id) {
  const path = join(root, 'state', 'antonina', 'agents', id);
  mkdirSync(path, { recursive: true });
  return path;
}
function list(env, flags = []) {
  const result = spawnSync(process.execPath, [CLI, 'agent', 'list', '--page', '1', '--json', ...flags], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  return { data: JSON.parse(result.stdout), stderr: result.stderr };
}
function temp(directory, pid, text) {
  const path = join(directory, '.meta-' + pid + '-1791780013606-feedbeef.tmp');
  writeFileSync(path, text);
  return path;
}
function idle(id) { return idleMeta(id, '/tmp', null, 5); }

test('recovers a valid abandoned idle metadata temp and clears inventory blocker', (t) => {
  const { root, env } = world(t);
  const id = 'b1e1';
  const directory = dir(root, id);
  const path = temp(directory, 99999999, JSON.stringify(idle(id)));
  const { data } = list(env, ['--running']);
  assert.deepEqual(data, { agents: [], unreadable: [] });
  assert.equal(existsSync(join(directory, 'meta.json')), true, 'canonical record was exclusively published');
  assert.equal(existsSync(path), false, 'superseded temp was removed');
  const all = list(env).data;
  assert.deepEqual(all.agents.map((x) => x.id), [id]);
  assert.deepEqual(all.unreadable, []);
  const status = spawnSync(process.execPath, [CLI, 'agent', 'status', '--id', id, '--json'], { env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, 'idle');
});

test('pre-publication empty directory and live writer do not block running inventory', (t) => {
  const { root, env } = world(t);
  dir(root, 'b1e2');
  const directory = dir(root, 'b1e3');
  const active = temp(directory, process.pid, JSON.stringify(idle('b1e3')));
  const { data, stderr } = list(env, ['--running']);
  assert.deepEqual(data, { agents: [], unreadable: [] });
  assert.match(stderr, /only unpublished creation state/);
  assert.equal(existsSync(active), true, 'do not steal a live writer temporary');
  assert.equal(existsSync(join(directory, 'meta.json')), false);
});

test('torn initial temp is skipped; non-idle and suspicious state remains unreadable', (t) => {
  const { root, env } = world(t);
  temp(dir(root, 'b1e4'), 99999999, '{');
  const running = idle('b1e5');
  running.state = 'running';
  temp(dir(root, 'b1e5'), 99999999, JSON.stringify(running));
  const suspicious = dir(root, 'b1e6');
  temp(suspicious, 99999999, JSON.stringify(idle('b1e6')));
  writeFileSync(join(suspicious, 'output.log'), 'evidence of a previous invocation');
  const { data, stderr } = list(env, ['--running']);
  assert.deepEqual(data.agents, []);
  assert.match(stderr, /b1e4 has only unpublished creation state/);
  assert.deepEqual(data.unreadable.map((x) => x.id).sort(), ['b1e5', 'b1e6']);
  for (const id of ['b1e4', 'b1e5', 'b1e6']) {
    assert.equal(existsSync(join(suspicious, '..', id, 'meta.json')), false);
  }
});

test('a committed record is never overwritten by a leftover temp', (t) => {
  const { root, env } = world(t);
  const id = 'b1e7';
  const directory = dir(root, id);
  const original = idle(id);
  writeFileSync(join(directory, 'meta.json'), JSON.stringify(original));
  temp(directory, 99999999, JSON.stringify(idle(id)));
  const canonical = readFileSync(join(directory, 'meta.json'), 'utf8');
  const { data } = list(env);
  // An already-published record is authoritative; the temp must never win.
  assert.equal(data.unreadable.length, 0);
  assert.equal(readFileSync(join(directory, 'meta.json'), 'utf8'), canonical);
});
