import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import {
  createAgentDirectory,
  removeAgentDirectory,
  removeOrphanedOpencodeDatabases,
  stateRoot,
  writeMeta,
} from '../dist/packages/agent-runtime/src/store.js';

function fixture(t) {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'antonina-batched-db-clean-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const options = { env: { XDG_STATE_HOME: tmp }, home: tmp };
  const dbDir = join(stateRoot(options), 'opencode');
  fs.mkdirSync(dbDir, { recursive: true });
  return { options, dbDir };
}

function agent(options, id, databaseKey = id) {
  assert.equal(createAgentDirectory(id, options), true);
  writeMeta(id, { ...idleMeta(id, '/tmp', null, 1), opencode_db: databaseKey }, options);
}

test('deferred database removal reads the surviving registry once and preserves shared databases', (t) => {
  const { options, dbDir } = fixture(t);
  agent(options, 'a11d');
  agent(options, 'b22d', 'a11d');
  const db = join(dbDir, 'a11d.db');
  fs.writeFileSync(db, 'session');
  fs.writeFileSync(db + '-wal', 'wal');
  const keys = new Set();

  removeAgentDirectory('a11d', options, keys);
  assert.deepEqual([...keys], ['a11d']);
  assert.equal(fs.existsSync(db), true, 'deferred deletion must not unlink immediately');

  removeOrphanedOpencodeDatabases(keys, options);
  assert.equal(fs.existsSync(db), true, 'surviving fork still owns the same database');

  removeAgentDirectory('b22d', options, keys);
  removeOrphanedOpencodeDatabases(keys, options);
  assert.equal(fs.existsSync(db), false);
  assert.equal(fs.existsSync(db + '-wal'), false);
});

test('unreadable surviving records prevent batched database deletion', (t) => {
  const { options, dbDir } = fixture(t);
  agent(options, 'a11d');
  createAgentDirectory('b22d', options); // Creation not published yet: ownership is unknown.
  const db = join(dbDir, 'a11d.db');
  fs.writeFileSync(db, 'session');
  const keys = new Set();

  removeAgentDirectory('a11d', options, keys);
  removeOrphanedOpencodeDatabases(keys, options);
  assert.equal(fs.existsSync(db), true);
});
