import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/metadata.js';
import {
  agentDir,
  createAgentDirectory,
  readMeta,
  stateRoot,
  updateMeta,
  withAgentLock,
  writeMeta,
} from '../dist/store.js';

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'antonina-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { env: { XDG_STATE_HOME: dir }, home: join(dir, 'home') };
}

test('state root follows XDG_STATE_HOME with home fallback', () => {
  assert.equal(stateRoot({ env: { XDG_STATE_HOME: '/x/state' }, home: '/home/u' }), '/x/state/antonina');
  assert.equal(stateRoot({ env: {}, home: '/home/u' }), '/home/u/.local/state/antonina');
});

test('metadata round-trips only when durable identity matches addressed agent', (t) => {
  const options = root(t);
  assert.equal(createAgentDirectory('a11d', options), true);
  assert.equal(createAgentDirectory('a11d', options), false);
  writeMeta('a11d', idleMeta('a11d', '/tmp', null, 5), options);
  assert.equal(readMeta('a11d', options)?.id, 'a11d');

  writeFileSync(join(agentDir('a11d', options), 'meta.json'), JSON.stringify({ id: 'beef' }));
  assert.equal(readMeta('a11d', options), null);
});

test('updateMeta commits a locked metadata transition', async (t) => {
  const options = root(t);
  createAgentDirectory('aa', options);
  writeMeta('aa', idleMeta('aa', '/tmp', null, 5), options);
  const updated = await updateMeta('aa', (meta) => {
    meta.prompt_count = 1;
    meta.pending_prompt = 'hello';
  }, options);
  assert.equal(updated?.prompt_count, 1);
  assert.equal(readMeta('aa', options)?.pending_prompt, 'hello');
});

test('stale lock files are reclaimed without native flock support', async (t) => {
  const options = root(t);
  createAgentDirectory('bb', options);
  writeMeta('bb', idleMeta('bb', '/tmp', null, 5), options);
  writeFileSync(join(agentDir('bb', options), '.lock'), JSON.stringify({ pid: 99999999, startTicks: 1 }));
  const result = await withAgentLock('bb', () => 'ok', options);
  assert.equal(result, 'ok');
});

test('concurrent in-process updates serialize through the lock file', async (t) => {
  const options = root(t);
  createAgentDirectory('cc', options);
  writeMeta('cc', idleMeta('cc', '/tmp', null, 5), options);
  const order = [];
  const first = withAgentLock('cc', async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push('first-end');
  }, options);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = withAgentLock('cc', () => { order.push('second'); }, options);
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});
