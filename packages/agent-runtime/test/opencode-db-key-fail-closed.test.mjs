// Board 198 R3: the database-deletion decision must fail closed.
//
// `removeOpencodeDatabase` unlinks `<state>/antonina/opencode/<key>.db` -- the
// operator's conversation history -- once it believes no OTHER agent record
// names that key. A fork pair shares one database on purpose (board 186: the
// clone carries the source's `native_session_id`, so it keeps using the
// source's database), which makes that belief the only thing standing between a
// `delete` of the source and the destruction of the conversation the clone is
// still continuing.
//
// The guard used to be `opencodeDbKeysInUse('').has(key)`, and
// `opencodeDbKeysInUse` answered from nothing in every case where the question
// could not be read:
//
//   - a state root that could not be enumerated (absent-by-other-name, wrong
//     type, denied) returned an empty set, because the `readdir` was caught;
//   - a record whose `meta.json` could not be read was skipped, i.e. treated as
//     absent -- the same answer, from a directory that was demonstrably there.
//
// Its own doc comment said the conservative direction "would be to keep the
// file", and then it did the other thing. Board 197/198 R2 established that an
// inventory which cannot be read reporting as an empty one is a defect this
// project treats as serious; this is the same shape with data loss at the end
// of it, and it is the destructive direction.
//
// These cases pin the fail-closed predicate: the file survives every unreadable
// inventory, and is still removed for the three states where absence really is
// established (absent root, readable empty root, readable sibling naming a
// different key). Every "kept" case here goes RED against the guard this
// replaces -- `if (!inventory.complete || inventory.keys.has(key)) return;`
// deleted down to `if (inventory.keys.has(key)) return;` turns five of them
// red, and deleting the whole guard turns all of them red including the
// in-use control.
//
// Test-state safety: each case owns a `mkdtemp` root under the OS temp dir and
// points both XDG_STATE_HOME and XDG_CONFIG_HOME at it, so no case can read or
// mutate the operator's ambient Antonina state. The bytes on disk are real
// files, because the point is real errno codes from a real readdir; nothing here
// touches `$XDG_STATE_HOME/antonina`. No case spawns a process.

import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import {
  agentsDir,
  opencodeDbKeysInUse,
  opencodeDbPath,
  readMeta,
  removeOpencodeDatabase,
  writeMeta,
} from '../dist/packages/agent-runtime/src/store.js';

const KEY = '0b1980a3000000000000000000000000000dbee01';
const OTHER_KEY = '0b1980a3000000000000000000000000000dbee02';
const SOURCE = '0b1980a3000000000000000000000000000dbee03';
const CLONE = '0b1980a3000000000000000000000000000dbee04';
const CONVERSATION = 'CONVERSATION-BYTES-A-CLONE-IS-STILL-CONTINUING\n'.repeat(4);

/**
 * A throwaway state root, an XDG pair pointed inside it, and an agents root that
 * exists. Cleanup restores any mode it had to change before removing the tree:
 * a directory left mode 000 would defeat `rmSync`'s own traversal.
 */
function world(t) {
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'antonina-b198r3-'));
  const env = { XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') };
  const options = { env, home: join(root, 'home') };
  nodeFs.mkdirSync(agentsDir(options), { recursive: true });
  nodeFs.mkdirSync(join(env.XDG_STATE_HOME, 'antonina', 'opencode'), { recursive: true });
  t.after(() => {
    try {
      nodeFs.chmodSync(agentsDir(options), 0o700);
    } catch {}
    nodeFs.rmSync(root, { recursive: true, force: true });
  });
  return { root, env, options };
}

/**
 * The subject of the whole file: a fork pair (source + clone) sharing ONE
 * database key, then the source's record removed as `agent delete` would remove
 * it. What remains is a clone that is still continuing the conversation in that
 * database. Returns the paths and the bytes that must not be destroyed.
 */
function forkPairWithSourceDeleted(t, name) {
  const w = world(t);
  for (const agentId of [SOURCE, CLONE]) {
    nodeFs.mkdirSync(join(agentsDir(w.options), agentId), { recursive: true });
    const meta = idleMeta(agentId, null, `title ${name} ${agentId}`);
    meta.opencode_db = KEY;
    meta.native_session_id = '0b1980a3000000000000000000000000000dbee05';
    writeMeta(agentId, meta, w.options);
  }
  const db = opencodeDbPath(KEY, w.options);
  nodeFs.writeFileSync(db, CONVERSATION);
  nodeFs.writeFileSync(`${db}-wal`, 'WAL');
  nodeFs.writeFileSync(`${db}-shm`, 'SHM');
  nodeFs.rmSync(join(agentsDir(w.options), SOURCE), { recursive: true, force: true });
  return { ...w, db, bytes: () => (nodeFs.existsSync(db) ? nodeFs.readFileSync(db, 'utf8') : null) };
}

// --- the four shapes that destroyed the clone's conversation -----------------

test('R3: a state root that is not a directory keeps the database', (t) => {
  const w = forkPairWithSourceDeleted(t, 'notdir');
  nodeFs.rmSync(agentsDir(w.options), { recursive: true, force: true });
  nodeFs.writeFileSync(agentsDir(w.options), 'not a directory');

  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, false, 'ENOTDIR must not read as an empty inventory');
  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), CONVERSATION, 'the shared conversation survived');
});

test('R3: an unreadable state root keeps the database', (t) => {
  const w = forkPairWithSourceDeleted(t, 'eacces');
  // Mode-based denial is only meaningful as a non-root reader; as uid 0 the
  // read succeeds and the case would be asserting nothing.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root reads a mode 000 directory');
    return;
  }
  nodeFs.chmodSync(agentsDir(w.options), 0o000);

  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, false, 'EACCES must not read as an empty inventory');
  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), CONVERSATION, 'the shared conversation survived');
});

test('R3: a sibling record whose metadata cannot be read keeps the database', (t) => {
  const w = forkPairWithSourceDeleted(t, 'unreadable-meta');
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root reads a mode 000 file');
    return;
  }
  nodeFs.chmodSync(join(agentsDir(w.options), CLONE, 'meta.json'), 0o000);

  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, false, 'an unreadable record must not read as absent');
  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), CONVERSATION, 'the shared conversation survived');
});

test('R3: a sibling record whose metadata does not validate keeps the database', (t) => {
  // Same reasoning as above without a mode change: `readMeta` refuses a record
  // it cannot fully validate, and a refusal must never license an unlink.
  for (const [label, raw] of [
    ['malformed JSON', '{ this is not json'],
    ['metadata file missing', null],
  ]) {
    const w = forkPairWithSourceDeleted(t, label);
    const metaPath = join(agentsDir(w.options), CLONE, 'meta.json');
    if (raw === null) nodeFs.rmSync(metaPath, { force: true });
    else nodeFs.writeFileSync(metaPath, raw);

    const inventory = opencodeDbKeysInUse('', w.options);
    assert.equal(inventory.complete, false, `${label} must not read as absent`);
    removeOpencodeDatabase(KEY, w.options);
    assert.equal(w.bytes(), CONVERSATION, `the shared conversation survived ${label}`);
  }
});

// --- absence really is established: these must still delete -----------------

test('R3: an absent state root is an empty inventory, not a denied one', (t) => {
  const w = forkPairWithSourceDeleted(t, 'absent');
  nodeFs.rmSync(agentsDir(w.options), { recursive: true, force: true });

  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, true, 'absence is readable absence');
  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), null, 'a root with no records holds no reference');
});

test('R3: a readable but empty state root still permits deletion', (t) => {
  const w = forkPairWithSourceDeleted(t, 'empty');
  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), CONVERSATION, 'the clone still names this key, so it is kept');

  // Enumerable, and demonstrably nothing in it -- the absence that R2's
  // inventory refusal must not have swallowed along with the denied case.
  nodeFs.rmSync(join(agentsDir(w.options), CLONE), { recursive: true, force: true });
  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, true);
  assert.deepEqual([...inventory.keys], []);

  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), null, 'with no record left, the database goes');
});

test('R3: a readable sibling naming a different key does not block deletion', (t) => {
  const w = forkPairWithSourceDeleted(t, 'other-key');
  const meta = readMeta(CLONE, w.options);
  meta.opencode_db = OTHER_KEY;
  writeMeta(CLONE, meta, w.options);

  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, true);
  assert.deepEqual([...inventory.keys], [OTHER_KEY], 'a read record that names another key is a reference to that key only');

  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), null, 'nothing names this key any more');
});

test('R3: a readable sibling naming this key keeps the database', (t) => {
  // The control for the guard itself: the original, working reason to keep the
  // file must still be the reason it is kept.
  const w = forkPairWithSourceDeleted(t, 'in-use');
  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, true);
  assert.deepEqual([...inventory.keys], [KEY]);

  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), CONVERSATION, 'the clone is still continuing this conversation');
  for (const suffix of ['', '-wal', '-shm']) {
    assert.ok(nodeFs.existsSync(`${w.db}${suffix}`), `the ${suffix || 'database'} sibling survived`);
  }
});

test('R3: a directory that is not a well-formed agent id cannot keep a database alive', (t) => {
  const w = forkPairWithSourceDeleted(t, 'stray');
  // `writeMeta` cannot produce this name and `persistedAgentId` rejects it, so
  // it cannot name a key. Treating it as an unreadable record would make a
  // stray `agents/scratch/` immortalise every database on the machine.
  nodeFs.mkdirSync(join(agentsDir(w.options), 'scratch'), { recursive: true });

  const inventory = opencodeDbKeysInUse('', w.options);
  assert.equal(inventory.complete, true, 'a non-record directory is not an unreadable record');
  removeOpencodeDatabase(KEY, w.options);
  assert.equal(w.bytes(), CONVERSATION, 'the clone still names this key, so it is kept');
});

test('R3: exceptAgentId still exempts only its own record', (t) => {
  const w = forkPairWithSourceDeleted(t, 'except');
  nodeFs.mkdirSync(join(agentsDir(w.options), SOURCE), { recursive: true });
  const meta = idleMeta(SOURCE, null, 'title source again');
  meta.opencode_db = KEY;
  writeMeta(SOURCE, meta, w.options);
  const cloneMeta = readMeta(CLONE, w.options);
  cloneMeta.opencode_db = OTHER_KEY;
  writeMeta(CLONE, cloneMeta, w.options);

  assert.deepEqual(
    [...opencodeDbKeysInUse(SOURCE, w.options).keys],
    [OTHER_KEY],
    'the exempted record is not a reference to itself, and the other one still is',
  );
  assert.deepEqual([...opencodeDbKeysInUse('', w.options).keys].sort(), [KEY, OTHER_KEY].sort(), 'without the exemption both are');
});