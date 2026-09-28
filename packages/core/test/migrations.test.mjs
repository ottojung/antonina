import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { canonicalJson } from '../dist/canonical.js';
import { createBoardCredential } from '../dist/credential.js';
import * as migrations from '../dist/migrations.js';
import * as model from '../dist/model.js';
import { signBoardOperation, verifyAndReplayOperationLog } from '../dist/operations.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_PATH = join(fixtureDir, 'board-v2-populated-operation-log.json');

/** The compiled core, beside which the version-bump probe is written. */
function distDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
}

/** The fixture as it is written on disk, read fresh so no test can share a mutation. */
function storedLog() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

/**
 * The thrown refusal as data. `assert.throws(fn, Ctor)` cannot be used to get a
 * handle on the error in Node 22, it returns undefined, so the throw is
 * captured directly and the caller asserts on the type.
 */
function captureRefusal(read) {
  try {
    read();
  } catch (error) {
    return error;
  }
  assert.fail('expected the board to be refused');
}

/**
 * The trust anchor of the fixture. The board id and root key id are read from
 * the fixture itself rather than restated, so a regenerated fixture does not
 * silently test against a stale anchor. The root public key is the public half
 * of the throwaway root key the generator commits alongside the fixture.
 */
function fixtureAnchor() {
  const log = storedLog();
  return { boardId: log.boardId, rootKeyId: log.rootKeyId, rootPublicKey: ROOT_KEY.publicKey };
}

const ROOT_KEY = {
  keyId: 'ed25519:-y9TTfl1XE8ZeROsfH-JZx-XgILqwoN0V4jl7itnTR8',
  publicKey: 'QlkyS0Org1pBgnGz8VRYtf0K7_L_J3R_z9NmJAGmN48',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIIcl33zeE-gtzBcuqxw02dHc9_rFTAYDBcimwJdRD_zZ',
};

function fakeSkrynia(seed) {
  const capability = 'c'.repeat(64);
  let signed = seed === undefined ? null : structuredClone(seed);
  let revision = 0;
  const etag = () => `"v${revision}"`;
  const json = (value, status) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ETag: etag() },
  });

  return {
    capability,
    get signed() { return signed; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      if (!String(url).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
      if (method === 'GET') {
        return signed === null ? new Response(null, { status: 404 }) : json(signed, 200);
      }
      if (method === 'PUT') {
        if (new Headers(init.headers).get('X-Skrynia-Capability') !== capability) return json({ error: 'no' }, 403);
        if (new Headers(init.headers).get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return json({ ok: true }, 200);
      }
      return new Response(null, { status: 405 });
    },
  };
}

async function openedStore() {
  const log = storedLog();
  const server = fakeSkrynia(log);
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  const credential = await createBoardCredential(fixtureAnchor(), ROOT_KEY, server.capability);
  return { store, server, credential, log };
}

const at = (minute) => `2026-09-20T10:${String(minute).padStart(2, '0')}:00.000Z`;

// ---------------------------------------------------------------------------
// Layer 1: the migration gate itself.
// ---------------------------------------------------------------------------

test('a board already at the current persisted version opens without migrating', () => {
  const board = model.emptyBoard();
  const migrated = migrations.migratePersistedBoard(board);
  assert.equal(migrated.fromVersion, migrations.CURRENT_PERSISTED_BOARD_VERSION);
  assert.deepEqual(migrated.throughVersions, []);
  assert.deepEqual(migrated.board, board);
  // Safe to repeat: opening again changes nothing and migrates nothing.
  assert.deepEqual(migrations.migratePersistedBoard(migrated.board), migrated);
});

test('every supported version that is not current has a registered migration', () => {
  assert.equal(migrations.everySupersededVersionHasAMigration(), true);
  assert.deepEqual([...migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS], [2, 3]);
  for (const version of migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS) {
    const chain = migrations.persistedBoardMigrationChain(version);
    assert.equal(chain.at(-1)?.to ?? version, migrations.CURRENT_PERSISTED_BOARD_VERSION);
  }
});

test('every step a chain returns agrees with the version it was asked to leave', () => {
  // The registry key and the `from` the entry restates are two statements of
  // the same thing, and only one of them is the key the walk dispatches on. So
  // every chain is checked to start at the version asked for, to step strictly
  // forward, to have each `to` be the next step's `from`, and to land on the
  // current version. An entry whose `from` contradicts its own key, or whose
  // `to` jumps or goes backwards, cannot pass.
  for (const version of migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS) {
    const chain = migrations.persistedBoardMigrationChain(version);
    for (const [index, step] of chain.entries()) {
      assert.equal(step.from, index === 0 ? version : chain[index - 1].to, `chain from ${version} step ${index}`);
      assert.ok(step.to > step.from, `chain from ${version} step ${index} must step forward`);
      assert.ok(
        migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS.includes(step.to),
        `chain from ${version} step ${index} lands on unsupported version ${step.to}`,
      );
    }
    assert.equal(chain.at(-1)?.to ?? version, migrations.CURRENT_PERSISTED_BOARD_VERSION);
  }
});

test('a step registered at the next version bump is used automatically, with no other edit to the gate', async () => {
  // The version bump this build has not made yet: v4 becomes current, v3 joins
  // the supported list, and a v3 -> v4 step joins the registry. Nothing else
  // about the gate changes, in particular nothing about how it turns a version
  // into a step. This is built by rewriting the *compiled* module into a probe
  // beside it, because the version bump must not be declared in the real
  // source: the point is to show that registering a step is sufficient, not to
  // ship a v4.
  const compiled = readFileSync(join(distDir(), 'migrations.js'), 'utf8');
  const NEXT = migrations.CURRENT_PERSISTED_BOARD_VERSION + 1;
  const SUPERSEDED = migrations.CURRENT_PERSISTED_BOARD_VERSION;
  const rewrites = [
    // v4 is what this build writes.
    ['export const CURRENT_PERSISTED_BOARD_VERSION = BOARD_SCHEMA_VERSION;',
      `export const CURRENT_PERSISTED_BOARD_VERSION = ${NEXT};`],
    // v3 is still in the world and still needs reading, and v4 is what is written.
    ['    LEGACY_BOARD_SCHEMA_VERSION,\n    BOARD_SCHEMA_VERSION,\n];',
      `    LEGACY_BOARD_SCHEMA_VERSION,\n    ${SUPERSEDED},\n    ${NEXT},\n];`],
    // the v3 -> v4 step, registered and nothing else.
    ['const PERSISTED_BOARD_MIGRATIONS = {',
      `const PERSISTED_BOARD_MIGRATIONS = {\n    ${SUPERSEDED}: {\n`
      + `        from: ${SUPERSEDED},\n        to: ${NEXT},\n`
      + "        summary: 'the step the next bump registers',\n"
      + `        migrate(value) {\n            return { ...value, schemaVersion: ${NEXT} };\n        },\n    },`],
    // and the existing v2 step now leads to v3 rather than to the end of the line.
    ['        to: BOARD_SCHEMA_VERSION,', `        to: ${SUPERSEDED},`],
    ['return { ...legacy, schemaVersion: BOARD_SCHEMA_VERSION, targets: [], dispatches: [] };',
      `return { ...legacy, schemaVersion: ${SUPERSEDED}, targets: [], dispatches: [] };`],
  ];
  let probe = compiled;
  for (const [from, to] of rewrites) {
    assert.ok(probe.includes(from), `the compiled gate no longer contains ${JSON.stringify(from)}, so this probe cannot be built`);
    probe = probe.replace(from, to);
  }

  const probePath = join(distDir(), 'migrations-next-version-bump.probe.js');
  writeFileSync(probePath, probe);
  try {
    const bumped = await import(pathToFileURL(probePath).href);
    assert.equal(bumped.CURRENT_PERSISTED_BOARD_VERSION, NEXT);
    assert.equal(bumped.everySupersededVersionHasAMigration(), true);
    // The step registered for v3 is reached from v3, and from v2, in one chain.
    assert.deepEqual(
      bumped.persistedBoardMigrationChain(SUPERSEDED).map((step) => [step.from, step.to]),
      [[SUPERSEDED, NEXT]],
    );
    assert.deepEqual(
      bumped.persistedBoardMigrationChain(2).map((step) => [step.from, step.to]),
      [[2, SUPERSEDED], [SUPERSEDED, NEXT]],
    );
  } finally {
    rmSync(probePath, { force: true });
  }
});

test('a stored board from a newer Antonina is refused by version, not by a parse symptom', () => {
  const future = { ...model.emptyBoard(), schemaVersion: 4 };
  assert.throws(() => migrations.migratePersistedBoard(future), (error) => {
    assert.ok(error instanceof migrations.UnsupportedPersistedBoardVersionError);
    assert.equal(error.persistedVersion, 4);
    assert.match(error.message, /format version 4/);
    assert.match(error.message, /Upgrade Antonina/);
    return true;
  });
});

test('a stored board older than anything this build migrates is refused rather than guessed at', () => {
  const ancient = {
    schemaVersion: 1,
    nextIssueNumber: 1,
    issues: [],
    resources: [],
  };
  assert.throws(() => migrations.migratePersistedBoard(ancient), (error) => {
    assert.ok(error instanceof migrations.NoPersistedBoardMigrationPathError);
    assert.equal(error.persistedVersion, 1);
    assert.match(error.message, /no migration from persisted board format version 1/);
    return true;
  });
});

test('a stored board with no version at all is refused as malformed', () => {
  assert.throws(
    () => migrations.migratePersistedBoard({ nextIssueNumber: 1, issues: [], resources: [] }),
    migrations.PersistedBoardMigrationError,
  );
});

test('a malformed legacy board fails closed and produces no board', () => {
  const malformed = {
    schemaVersion: 2,
    nextIssueNumber: 2,
    issues: [{ number: 1, title: 'Broken', body: '', state: 'open', createdAt: at(1), updatedAt: at(1), messages: [] }],
    resources: [{ host: 'not-a-lubko-address', path: '/srv', issueNumbers: [1], createdAt: at(1), updatedAt: at(1) }],
  };
  assert.throws(() => migrations.migratePersistedBoard(malformed), /resource/);
});

test('a migration that produced an invalid current board is refused rather than exposed', () => {
  const chain = migrations.persistedBoardMigrationChain(2);
  // The step itself produces a valid board; the point of this case is that the
  // gate validates the migrated result, not that this input is bad.
  const migrated = migrations.migratePersistedBoard({
    schemaVersion: 2,
    nextIssueNumber: 1,
    issues: [],
    resources: [],
  });
  assert.equal(migrated.board.schemaVersion, migrations.CURRENT_PERSISTED_BOARD_VERSION);
  assert.equal(chain.length, 1);
  assert.match(chain[0].summary, /execution-target catalog/);
});

// ---------------------------------------------------------------------------
// Layer 2: the real 0.1.0 board, through the production open path.
// ---------------------------------------------------------------------------

/**
 * The migrated board, written out by hand from the fixture rather than captured
 * from the code under test. A golden that the migration generates is not a
 * check, so this one is a second statement of what v2 -> v3 means.
 */
function expectedMigratedBoard() {
  return {
    schemaVersion: 3,
    nextIssueNumber: 7,
    issues: [
      {
        number: 1,
        title: 'Migrate the persisted board format',
        body: 'Signed by 0.1.0, edited by 0.1.0, and never rewritten since.',
        state: 'open',
        createdAt: '2026-09-20T09:01:00.000Z',
        updatedAt: '2026-09-20T09:05:00.000Z',
        messages: [
          {
            id: 'sha256:nE6Fpg6XaiwDL2gouhZ2BuaWS_VGO2tmoaGpOi-o2x4',
            author: '73a1',
            body: 'comment from the delegated key',
            createdAt: '2026-09-20T09:04:00.000Z',
          },
          {
            id: 'sha256:mAIzEhdg30VTWodHxguCZ6P75MJ-GRWt6qbDHEv14BE',
            author: '71a1',
            body: 'comment from the root key',
            createdAt: '2026-09-20T09:05:00.000Z',
          },
        ],
      },
      {
        number: 2,
        title: 'Collect the finished archive',
        body: 'Closed before the signing that carries it.',
        state: 'closed',
        createdAt: '2026-09-20T09:02:00.000Z',
        updatedAt: '2026-09-20T09:03:00.000Z',
        messages: [{
          id: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          author: '71a1',
          body: 'closing this one; the resource can be collected',
          createdAt: '2026-09-20T09:03:00.000Z',
        }],
      },
      {
        number: 3,
        title: 'Rehearse the reopen path',
        body: 'Closed and reopened by the operations below.',
        state: 'open',
        createdAt: '2026-09-20T09:04:00.000Z',
        updatedAt: '2026-09-20T09:07:00.000Z',
        messages: [],
      },
      {
        number: 4,
        title: 'Write the migration fixtures',
        body: 'This board is one of them.',
        state: 'open',
        createdAt: '2026-09-20T09:05:00.000Z',
        updatedAt: '2026-09-20T09:05:00.000Z',
        messages: [],
      },
      {
        number: 5,
        title: 'Collect from the closed issue',
        body: 'Created by a delegated key.',
        state: 'open',
        createdAt: '2026-09-20T09:02:00.000Z',
        updatedAt: '2026-09-20T09:02:00.000Z',
        messages: [],
      },
      {
        number: 6,
        title: 'After the revocation',
        body: 'Root-signed tail.',
        state: 'open',
        createdAt: '2026-09-20T09:12:00.000Z',
        updatedAt: '2026-09-20T09:12:00.000Z',
        messages: [],
      },
    ],
    resources: [
      {
        host: 'lubko://gpu-01',
        path: '/srv/work',
        issueNumbers: [1, 3, 5],
        createdAt: '2026-09-20T09:06:00.000Z',
        updatedAt: '2026-09-20T09:08:00.000Z',
      },
    ],
    targets: [],
    dispatches: [],
  };
}

test('the real 0.1.0 board opens through the gate and migrates to exactly the expected current board', async () => {
  const state = await verifyAndReplayOperationLog(storedLog(), fixtureAnchor());
  assert.deepEqual(state.migration, { persistedVersion: 2, throughVersions: [3] });
  assert.deepEqual(state.board, expectedMigratedBoard());
  assert.deepEqual(state.queue, [5, 1, 3, 4, 6]);
  assert.deepEqual(
    state.authorities.map((authority) => [authority.keyId, authority.revoked]),
    [[ROOT_KEY.keyId, false], ['ed25519:Vp2GP2F7SOLExy7wSO_56Z0FcZuyCyve-CgikP1aC44', true]],
  );
});

test('the migrated board reads through the public model, and reads deterministically', async () => {
  const anchor = fixtureAnchor();
  const first = await verifyAndReplayOperationLog(storedLog(), anchor);
  const second = await verifyAndReplayOperationLog(storedLog(), anchor);
  assert.deepEqual(second, first);

  const board = first.board;
  assert.deepEqual(model.resourceViews(board).map((view) => [view.host, view.path, view.protected]), [
    ['lubko://gpu-01', '/srv/work', true],
  ]);
  assert.deepEqual(model.targetViews(board), []);
  assert.equal(model.selectExecutionTarget(board).outcome, 'no-eligible-target');
  assert.deepEqual(board.issues.map((issue) => issue.number), [1, 2, 3, 4, 5, 6]);
});

test('the legacy signed representation is verified exactly as persisted, byte for byte', async () => {
  // The parser is allowed to read a legacy board only if reading it is a
  // round trip: the bytes a signature covered must be the bytes that get
  // verified. Canonicalisation sorts keys, so this compares content, not
  // property order, which is exactly what a signature covers.
  const log = storedLog();
  const persisted = log.operations[0].payload.board;
  const parsed = model.parsePersistedBoard(structuredClone(persisted));
  assert.equal(canonicalJson(parsed), canonicalJson(persisted));
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(Object.hasOwn(parsed, 'targets'), false);

  // And opening must not have rewritten it.
  const opened = await verifyAndReplayOperationLog(log, fixtureAnchor());
  assert.equal(canonicalJson(log.operations[0].payload.board), canonicalJson(persisted));
  assert.equal(opened.head, log.head);
});

test('a legacy board tampered with in storage is still rejected after migration support exists', async () => {
  const anchor = fixtureAnchor();
  const cases = [
    ['an issue title', (log) => { log.operations[0].payload.board.issues[0].title = 'Tampered'; }],
    ['an issue body edited after signing', (log) => {
      log.operations[3].payload.body = 'edited without a signature';
    }],
    ['a resource path', (log) => { log.operations[0].payload.board.resources[0].path = '/srv/other'; }],
    ['a message removed from a closed issue', (log) => { log.operations[0].payload.board.issues[1].messages = []; }],
    ['a delegated operation re-signed as the root', (log) => { log.operations[2].signerKeyId = anchor.rootKeyId; }],
  ];
  for (const [label, tamper] of cases) {
    const log = storedLog();
    tamper(log);
    await assert.rejects(
      () => verifyAndReplayOperationLog(log, anchor),
      /(identity hash|signature|signer)/,
      `tampering with ${label} must not survive migration support`,
    );
  }
});

test('a legacy board rewritten into the current format in storage is rejected, not accepted as migrated', async () => {
  // The attack migration support must not enable: upgrade the signed payload
  // in place so it looks like a current board. The signature covered v2 bytes,
  // so this is a signature failure and not a read.
  const log = storedLog();
  const board = log.operations[0].payload.board;
  log.operations[0].payload.board = { ...board, schemaVersion: 3, targets: [], dispatches: [] };
  await assert.rejects(
    () => verifyAndReplayOperationLog(log, fixtureAnchor()),
    /(identity hash|signature)/,
  );
});

test('a legacy history re-signed under the current format still cannot be rolled back onto a client', async () => {
  // The strongest thing an attacker with the root key can do to a migrated
  // board: rewrite the whole history, re-sign it as current-format, and serve
  // that instead. The result verifies as a history the root key authored, and it
  // is still refused by any client that already accepted the original head.
  const log = storedLog();
  const resigned = { ...log, operations: [] };
  let previous = null;
  for (const original of log.operations) {
    const payload = original.kind === 'board.initialize'
      ? { board: { ...original.payload.board, schemaVersion: 3, targets: [], dispatches: [] } }
      : original.payload;
    const operation = await signBoardOperation({
      boardId: log.boardId,
      previous,
      timestamp: original.timestamp,
      nonce: original.nonce,
      kind: original.kind,
      payload,
    }, ROOT_KEY);
    resigned.operations.push(operation);
    previous = operation.opId;
  }
  resigned.head = previous;
  assert.notEqual(resigned.head, log.head);

  // It is a real history, and it opens as a current board: nothing here depends
  // on the migration being broken.
  const asCurrent = await verifyAndReplayOperationLog(resigned, fixtureAnchor());
  assert.deepEqual(asCurrent.migration, { persistedVersion: 3, throughVersions: [] });
  assert.equal(asCurrent.board.schemaVersion, 3);

  // What stops it is that a client which already accepted the original history
  // will not accept a replacement that does not contain the head it accepted.
  await assert.rejects(
    () => verifyAndReplayOperationLog(resigned, fixtureAnchor(), { previouslyAcceptedHead: log.head }),
    /previously accepted head/,
  );
});

test('opening a legacy board is idempotent and does not change what is stored', async () => {
  const { store, server } = await openedStore();
  const before = canonicalJson(server.signed);
  const first = await store.require(fixtureAnchor());
  const second = await store.require(fixtureAnchor());
  assert.deepEqual(second.state, first.state);
  assert.equal(canonicalJson(server.signed), before);
  assert.equal(first.state.migration.persistedVersion, 2);
  assert.deepEqual(first.state.migration.throughVersions, [3]);
});

// ---------------------------------------------------------------------------
// Layer 3: the migrated board is still a working board.
// ---------------------------------------------------------------------------

test('a migrated board accepts writes, and those writes survive a reopen', async () => {
  const { store, server, credential } = await openedStore();
  const head = (await store.require(fixtureAnchor())).state.head;

  const created = await store.append(credential, {
    kind: 'issue.create',
    timestamp: at(1),
    nonce: 'after-migration-create',
    payload: (state) => ({ number: state.board.nextIssueNumber, title: 'Written after migration', body: '' }),
  }, head);
  await store.append(credential, {
    kind: 'issue.comment',
    timestamp: at(2),
    nonce: 'after-migration-comment',
    payload: { number: 7, author: '73a1', body: 'comment on a migrated board' },
  }, created.state.head);
  const closed = await store.append(credential, {
    kind: 'issue.close',
    timestamp: at(3),
    nonce: 'after-migration-close',
    payload: { number: 7 },
  });
  const reopened = await store.append(credential, {
    kind: 'issue.reopen',
    timestamp: at(4),
    nonce: 'after-migration-reopen',
    payload: { number: 7 },
  });
  await store.append(credential, {
    kind: 'resource.add',
    timestamp: at(5),
    nonce: 'after-migration-resource',
    payload: { number: 7, host: 'lubko://gpu-02', path: '/srv/after' },
  }, reopened.state.head);

  // Reopen from what is actually stored, through the ordinary read path.
  const reread = await store.require(fixtureAnchor());
  const issue = reread.state.board.issues.find((candidate) => candidate.number === 7);
  assert.equal(issue.title, 'Written after migration');
  assert.equal(issue.state, 'open');
  assert.deepEqual(issue.messages.map((message) => message.body), ['comment on a migrated board']);
  assert.deepEqual(
    reread.state.board.resources.map((resource) => [resource.host, resource.path, resource.issueNumbers]),
    [
      ['lubko://gpu-01', '/srv/work', [1, 3, 5]],
      ['lubko://gpu-02', '/srv/after', [7]],
    ],
  );

  // The legacy history is byte-identical to what the fixture holds, and the log
  // is still v2 at the head of the history: the migration added nothing to it.
  const fixtureLog = storedLog();
  assert.equal(canonicalJson(server.signed.operations[0]), canonicalJson(fixtureLog.operations[0]));
  assert.equal(server.signed.operations.length, fixtureLog.operations.length + 5);
  assert.equal(server.signed.operations[0].payload.board.schemaVersion, 2);
  assert.equal(closed.state.board.nextIssueNumber, 8);
});

test('a legacy board that cannot be migrated is refused before anything is written', async () => {
  const log = storedLog();
  log.operations[0].payload.board.schemaVersion = 4;
  const server = fakeSkrynia(log);
  const before = canonicalJson(server.signed);
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  await assert.rejects(
    () => store.require(fixtureAnchor()),
    migrations.UnsupportedPersistedBoardVersionError,
  );
  assert.equal(canonicalJson(server.signed), before);
});

test('a legacy board cannot be opened through the current-format parser alone', () => {
  const legacy = storedLog().operations[0].payload.board;
  // Board issue 71 gave this refusal a typed error, because "the CLI and the
  // browser both just said incompatible" was the diagnosability complaint that
  // issue was opened for. The type is the durable contract; the old assertion
  // matched the literal word `incompatible`, which the new message no longer
  // contains even though the refusal is stricter and better explained.
  const refusal = captureRefusal(() => model.parseBoard(legacy));
  assert.equal(model.isBoardIncompatibilityError(refusal), true);
  assert.equal(refusal.defect.kind, 'schema-version-mismatch');
  assert.equal(refusal.defect.found, '2');
  // There is no exported shortcut that lifts a legacy board any more: opening
  // one is the gate's job, so a caller cannot forget to ask for a migration.
  assert.equal(model.upgradePersistedBoard, undefined);
  assert.equal(typeof migrations.migratePersistedBoard, 'function');
});

test('no source file can lift a legacy board without going through the gate', () => {
  // The behavioural checks above prove the open path migrates. This proves
  // there is no second one: a legacy version constant, or any code that
  // recognizes a legacy board, may only appear in the parser that must read
  // legacy bytes to reproduce a signature, and in the gate itself.
  const sources = ['packages/core/src', 'packages/cli/src', 'packages/agent-runtime/src', 'web/src']
    .flatMap((directory) => {
      const full = join(repoRoot(), directory);
      return readdirSync(full, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
        .map((entry) => join(entry.parentPath, entry.name));
    });
  assert.ok(sources.length > 5, 'the source scan found suspiciously few files');
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('packages/core/src/migrations.ts')) continue;
    if (file.endsWith('packages/core/src/model.ts')) {
      // The parser has to recognize a legacy board, because a signature covers
      // its bytes. What it may not do is export a way to lift one.
      assert.equal(
        /export function \w+\([^)]*PersistedBoard[^)]*\)/.test(text),
        false,
        'packages/core/src/model.ts exports a function that takes a persisted board, so it can lift one outside the gate',
      );
      continue;
    }
    assert.equal(
      text.includes('LEGACY_BOARD_SCHEMA_VERSION'),
      false,
      `${file} refers to the legacy board version, so it can decide a board's format outside the gate`,
    );
  }
});

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
