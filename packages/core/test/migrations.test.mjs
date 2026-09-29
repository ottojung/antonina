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

/**
 * The compiled migration registry, read as structure rather than searched as
 * text: each entry with the `from:` and `to:` it declares, and the offsets of
 * its own text within the file.
 *
 * This is what lets the bump probe re-point the step the chain ends at without
 * pinning a version literal. `String.replace` hits the *first* match in a file,
 * so a search for `to: BOARD_SCHEMA_VERSION,` is not a search for "the step the
 * chain ends at" — in a build that has already been bumped it finds whichever
 * entry comes first in the file, which need not be that step. Slicing the entry
 * out first and rewriting only inside it makes the rewrite say what it means.
 *
 * The `from`/`to` values are compared as *expressions* (`SUPERSEDED_BOARD_SCHEMA_VERSION`,
 * `BOARD_SCHEMA_VERSION`, a literal), because that is how the compiled registry
 * spells them; the caller compares them against the same expressions.
 */
function readRegistry(text, what) {
  const open = 'const PERSISTED_BOARD_MIGRATIONS = {';
  const start = text.indexOf(open);
  assert.ok(start !== -1, `the compiled ${what} no longer contains ${JSON.stringify(open)}, so this probe cannot be built`);
  const end = text.indexOf('\n};', start);
  assert.ok(end !== -1, `the compiled ${what} no longer closes its migration registry with a bare "};", so this probe cannot be built`);
  const body = text.slice(start, end);
  const entries = [...body.matchAll(/^ {4}\[([^\]]+)\]: \{\n([\s\S]*?)^ {4}\},$/gm)].map((match) => {
    const inner = match[2] ?? '';
    const from = /^ {8}from: ([^,\n]+),$/m.exec(inner);
    const to = /^ {8}to: ([^,\n]+),$/m.exec(inner);
    assert.ok(from !== null && to !== null, `a registry entry in the compiled ${what} has no \`from:\`/\`to:\` pair, so this probe cannot be built`);
    return {
      key: match[1],
      from: from[1],
      to: to[1],
      text: match[0],
      start: start + (match.index ?? 0),
    };
  });
  assert.ok(entries.length > 0, `the compiled ${what} declares no migration entries, so this probe cannot be built`);
  return { entries };
}

/** The compiled core, beside which the version-bump probe is written. */
function distDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
}

/**
 * Every version this build declares, as the file states it independently of the
 * module under test: the oldest version it reads, through to the one it writes,
 * with no gap. Derived from the two version constants rather than written out, so
 * the next bump does not need an edit here.
 */
function everyDeclaredVersion() {
  const from = model.LEGACY_BOARD_SCHEMA_VERSION;
  const to = migrations.CURRENT_PERSISTED_BOARD_VERSION;
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * The versions a board at `from` steps through on its way to the current one:
 * one step per version, in order, up to and including the version this build
 * writes. Stated from the constants and the distance between them, so a version
 * bump moves the expectation instead of breaking it.
 */
function versionsSteppedThrough(from) {
  const to = migrations.CURRENT_PERSISTED_BOARD_VERSION;
  return Array.from({ length: to - from }, (_, index) => from + 1 + index);
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

// A board storage service for one test. It is a generic keyed store rather than
// a single `board-v2` slot: initializing a board writes the sharded v3
// snapshots, so a fake that only answers for one key 404s the first shard write.
function fakeSkrynia(seed) {
  const capability = 'c'.repeat(64);
  const objects = new Map();
  if (seed !== undefined) {
    objects.set('board-v2', { value: structuredClone(seed), mode: 'capability-write', capability, revision: 1 });
  }
  const keyOf = (url) => decodeURIComponent(String(url).split('/').at(-1));
  const etagOf = (entry) => `"v${entry.revision}"`;
  const json = (value, status, etag) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...(etag === undefined ? {} : { ETag: etag }) },
  });

  return {
    capability,
    get signed() { return objects.get('board-v2')?.value ?? null; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const key = keyOf(url);
      const current = objects.get(key);
      if (method === 'GET') {
        return current === undefined
          ? new Response(null, { status: 404 })
          : json(current.value, 200, etagOf(current));
      }
      if (method === 'POST') {
        if (current !== undefined) return new Response(null, { status: 409 });
        const mode = new Headers(init.headers).get('X-Skrynia-Mode') ?? 'capability-write';
        if (!['capability-write', 'public-write', 'immutable'].includes(mode)) {
          return json({ error: 'invalid_mode' }, 400);
        }
        objects.set(key, {
          value: JSON.parse(String(init.body)),
          mode,
          capability: mode === 'capability-write' ? capability : null,
          revision: 1,
        });
        return json(mode === 'capability-write' ? { mode, capability } : { mode }, 201);
      }
      if (method === 'PUT') {
        if (current === undefined) return new Response(null, { status: 404 });
        if (current.mode === 'immutable') return json({ error: 'immutable' }, 403);
        const headers = new Headers(init.headers);
        if (current.mode === 'capability-write' && headers.get('X-Skrynia-Capability') !== capability) {
          return json({ error: 'invalid capability' }, 403);
        }
        const match = headers.get('If-Match');
        if (match !== null && match !== etagOf(current)) {
          return json({ error: 'etag_mismatch' }, 412);
        }
        current.value = JSON.parse(String(init.body));
        current.revision += 1;
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
  assert.deepEqual([...migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS], everyDeclaredVersion());
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

/**
 * The version bump this build has not made yet, built the way the real bump
 * would be: the current version moves up one, the version this build writes
 * today becomes a supported superseded version, and it is given both of the
 * things a bump owes it — a parser to read boards at that version, and a step
 * to migrate them.
 *
 * It is built by rewriting the *compiled* `model.js` and `migrations.js` into
 * probes beside them, because the bump must not be declared in the real
 * source: the point is to show that adding the two entries is sufficient, not
 * to ship a v4. Everything the probes assert is derived from the compiled text,
 * so a rename in either module makes the probe fail to build rather than pass
 * vacuously.
 *
 * Nothing here is derived from a version literal. `SUPERSEDED` is whatever this
 * build currently writes and `NEXT` is one above it, and every string the probe
 * searches the compiled text for is built from those two, from the version
 * constants the modules export, or from the *name* of the module-level constant
 * that means "the version this build writes" — which is a rename, not a number,
 * so it survives a bump. The strings that used to break that were the two gate
 * literals `to: BOARD_SCHEMA_VERSION,` and the legacy re-stamp
 * `return { ...legacy, schemaVersion: BOARD_SCHEMA_VERSION, ... };`, which a bump
 * necessarily rewrites, and which therefore aborted the probe before it reached
 * the model side. Both are now reached through {@link frozenChainEndEntry}: the
 * registry entry the compiled chain ends at, located by the chain this build
 * actually runs, and rewritten only inside that entry, so the rewrite cannot
 * land on some other step's `to:`.
 *
 * What is still pinned, and loudly: the *shape* of the compiled output. Each
 * entry is matched as `[<key>]: {` / `        from: <v>,` / `        to: <v>,` /
 * `    },`, and the re-stamp is matched as `schemaVersion: <current-version
 * expression>` inside that entry. A build that renames those, or that writes a
 * chain whose last step does not name the current-version constant, fails to
 * build rather than producing a probe that does not declare the version it
 * claims to.
 */
async function buildNextVersionBumpProbe() {
  const NEXT = migrations.CURRENT_PERSISTED_BOARD_VERSION + 1;
  const SUPERSEDED = migrations.CURRENT_PERSISTED_BOARD_VERSION;

  const rewrite = (text, rewrites, what) => {
    let out = text;
    for (const [from, to] of rewrites) {
      assert.ok(out.includes(from), `the compiled ${what} no longer contains ${JSON.stringify(from)}, so this probe cannot be built`);
      out = out.replace(from, to);
    }
    return out;
  };
  // The parser the bumped build registers for the version this build writes
  // today is, verbatim, the reader this build already ships. It is imported
  // from the *unrewritten* module so the probe is not asserting a v3 reader
  // against a v4 guard.
  const modelPath = join(distDir(), 'model.next-version-bump.probe.js');
  const migrationsPath = join(distDir(), 'migrations.next-version-bump.probe.js');
  writeFileSync(modelPath, rewrite(readFileSync(join(distDir(), 'model.js'), 'utf8'), [
    // v4 is what the bumped build writes. The string searched for is this
    // build's *current* version, not a literal, so a bumped build is probed by
    // the same line.
    [`export const BOARD_SCHEMA_VERSION = ${SUPERSEDED};`, `export const BOARD_SCHEMA_VERSION = ${NEXT};`],
    [`import { BoardIncompatibilityError,`, `import { parseCanonicalBoard as parseSupersededBoard } from './model.js';\nimport { BoardIncompatibilityError,`],
    // the version this build writes today is still in the world and still needs
    // reading, and the new version is what is written. The declared list already
    // ends in the constant the rewrite above has just moved to `NEXT`, so the
    // superseded version is *inserted* before that entry. Anchoring on the last
    // entry rather than on the whole two-entry list is what lets a build that
    // already declares three versions still be probed; a build whose list is not
    // written that way still fails to build, loudly, rather than producing a
    // probe that does not declare the version it claims to.
    ['    BOARD_SCHEMA_VERSION,\n];',
      `    ${SUPERSEDED},\n    BOARD_SCHEMA_VERSION,\n];`],
    ['    [BOARD_SCHEMA_VERSION]: parseCanonicalBoard,\n};',
      `    [${SUPERSEDED}]: parseSupersededBoard,\n    [BOARD_SCHEMA_VERSION]: parseCanonicalBoard,\n};`],
  ], 'model'));

  const gatePath = join(distDir(), 'migrations.js');
  const gateText = readFileSync(gatePath, 'utf8');

  // The step the bump has to re-point is *not* found by searching for a version
  // literal. It is found structurally: the registry entries, in compiled form,
  // each with its own `from:` and `to:`. The entry whose `to:` is the version
  // this build writes is the one the bump supersedes, because a registry is a
  // chain and exactly one entry can end at the current version. This is derived
  // from the chain the build itself runs (`migrations.persistedBoardMigrationChain`
  // below), so a build that has already been bumped is handled by the same code:
  // its chain ends at the same place, one version further on.
  const registry = readRegistry(gateText, 'gate');
  // A chain has exactly one last step, so exactly one registered step may end at
  // the version this build writes, and that is asserted rather than assumed here
  // because the selection is structural and a `find` takes the first entry that
  // matches: a registry holding a second entry whose `to` names the current
  // version — a redundant direct step declared ahead of the ladder step, say —
  // would have the wrong entry re-pointed, and the rewrite would land somewhere
  // other than the end of the chain.
  //
  // What this assertion is worth is the diagnosis, not the detection. The ladder
  // assertion in the test below already goes red on such a registry, by name:
  // a two-entry registry can only skip a version to end at the current version
  // twice, and the ladder requires one step per version, so it reports a
  // version-skip mismatch. That is a correct red, but it names the ladder and not
  // the entries at fault. This assertion reports the same registry defect as the
  // count of chain-end entries plus the offending `from -> to` pairs, so the
  // reader is told which entry the probe would have re-pointed. (The chain
  // cross-check two assertions below is the weaker sibling and is not what
  // catches this class: it fires on the chain the running build walks, not on
  // which registry entry was selected here.)
  const chainEndEntries = registry.entries.filter((entry) => entry.to === 'BOARD_SCHEMA_VERSION');
  assert.equal(
    chainEndEntries.length,
    1,
    `the compiled gate registers ${chainEndEntries.length} steps whose \`to\` is the version this build writes`
    + `${chainEndEntries.length === 0 ? ', so it has no chain end at all' : ` (${chainEndEntries.map((entry) => `${entry.from} -> ${entry.to}`).join('; ')}), so the probe would re-point whichever came first rather than the step the chain ends at`},`
    + ' so this probe cannot be built',
  );
  const endOfChain = chainEndEntries[0];
  // The frozen step must be the one the chain actually ends at, and the chain
  // must be walkable — otherwise the entry found above is some other step that
  // happens to name the current version, and rewriting it would build a probe
  // that is not the bump.
  assert.equal(
    migrations.persistedBoardMigrationChain(migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS[0]).at(-1)?.to,
    migrations.CURRENT_PERSISTED_BOARD_VERSION,
    'the gate the probe is built from does not walk its own registry to the current version, so this probe cannot be built',
  );

  writeFileSync(migrationsPath, rewrite(
    // the frozen step is re-pointed at `SUPERSEDED`, by slicing the one entry the
    // chain ends at out of the text and rewriting inside it. Scoping the rewrite
    // to the entry — rather than replacing the first match in the file — is what
    // keeps a build that has already been bumped correct: there, an *earlier*
    // entry is the one that names the current version in some spellings, and a
    // whole-file replace would silently re-point that one instead.
    gateText.slice(0, endOfChain.start) + rewrite(endOfChain.text, [
      // the step this build registers for the superseded version now leads to
      // the version that supersedes it, not to the end of the line.
      [`        to: ${endOfChain.to},`, `        to: ${SUPERSEDED},`],
      // and the re-stamp in its body agrees with the version it now leads to.
      // Anchored on the `schemaVersion:` *expression*, not on the whole return
      // statement, because the statement is this step's own: in a build that has
      // already been bumped the chain-end step spreads a parsed v3 board rather
      // than a parsed legacy one, and a whole-statement search string would miss
      // it and abort.
      [`schemaVersion: ${endOfChain.to}`, `schemaVersion: ${SUPERSEDED}`],
    ], 'gate') + gateText.slice(endOfChain.start + endOfChain.text.length),
    [
      [`from './model.js'`, `from './model.next-version-bump.probe.js'`],
      ['export const CURRENT_PERSISTED_BOARD_VERSION = BOARD_SCHEMA_VERSION;',
        `export const CURRENT_PERSISTED_BOARD_VERSION = ${NEXT};`],
      // the step the bump registers, and nothing else.
      ['const PERSISTED_BOARD_MIGRATIONS = {',
        `const PERSISTED_BOARD_MIGRATIONS = {\n    ${SUPERSEDED}: {\n`
        + `        from: ${SUPERSEDED},\n        to: ${NEXT},\n`
        + "        summary: 'the step the next bump registers',\n"
        + `        migrate(value) {\n            return { ...value, schemaVersion: ${NEXT} };\n        },\n    },`],
    ],
    'gate',
  ));

  try {
    return {
      NEXT,
      SUPERSEDED,
      bumpedModel: await import(pathToFileURL(modelPath).href),
      bumped: await import(pathToFileURL(migrationsPath).href),
    };
  } finally {
    rmSync(modelPath, { force: true });
    rmSync(migrationsPath, { force: true });
  }
}

test('a step registered at the next version bump is used automatically, with no other edit to the gate', async () => {
  const { NEXT, SUPERSEDED, bumped } = await buildNextVersionBumpProbe();
  const oldest = model.LEGACY_BOARD_SCHEMA_VERSION;
  assert.equal(bumped.CURRENT_PERSISTED_BOARD_VERSION, NEXT);
  assert.equal(bumped.everySupersededVersionHasAMigration(), true);
  // The step registered for the superseded version is reached from that version,
  // and is the last step of the chain.
  assert.deepEqual(
    bumped.persistedBoardMigrationChain(SUPERSEDED).map((step) => [step.from, step.to]),
    [[SUPERSEDED, NEXT]],
  );
  // And from the oldest version this build reads, the whole ladder is walked in
  // one chain: one step per version from the oldest to the one the bump writes,
  // with no version skipped. Stated as consecutive pairs rather than as the two
  // steps a two-version build happens to have, so a build that has already been
  // bumped is checked by the same assertion.
  const ladder = [...bumped.SUPPORTED_PERSISTED_BOARD_VERSIONS];
  assert.deepEqual(
    bumped.persistedBoardMigrationChain(oldest).map((step) => [step.from, step.to]),
    ladder.slice(0, -1).map((version, index) => [version, ladder[index + 1]]),
  );
});

test('a board at a supported version is readable, including at the next version bump', async () => {
  // Board issue 104. The gate could accept and migrate a board that
  // `parsePersistedBoard` refused, because the two recognised versions
  // independently: the gate consulted the registry, and the parser branched on
  // `LEGACY_BOARD_SCHEMA_VERSION` alone. So at the next bump a v3 board was
  // refused on the operation-log parse path at operations.ts, before the
  // migration that would have read it was ever reached.
  //
  // The general form is the point: for every version this build declares it can
  // read, a board at that version parses, and a build whose current version has
  // moved on still parses a board at the version this build writes. Both are
  // checked here.
  //
  // What each half derives, honestly: the *bumped* half below is general, and
  // the next bump after next is covered by it without editing this file. The
  // *current build's* half is not. It holds real boards, and a real board at a
  // given version is data that cannot be derived — it is what some earlier
  // release actually wrote. The current version's board is derived (an empty
  // board is what this build writes) and the legacy board is the committed
  // operation-log fixture, whose key is the legacy constant rather than a
  // literal, so it follows the source. Any *further* declared version — which is
  // exactly what a bump adds — still owes a board here, and the loop below fails
  // loudly and by name if one is missing. That is a reminder the bump author
  // must answer, not a defect the test hides, and the docstring no longer claims
  // otherwise.
  assert.equal(model.everySupportedVersionHasAParser(), true);
  assert.deepEqual([...model.PERSISTED_BOARD_VERSIONS], [...migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS]);

  const boards = new Map([
    [migrations.CURRENT_PERSISTED_BOARD_VERSION, model.emptyBoard()],
    [model.LEGACY_BOARD_SCHEMA_VERSION, storedLog().operations[0].payload.board],
  ]);
  for (const version of model.PERSISTED_BOARD_VERSIONS) {
    const board = boards.get(version);
    assert.ok(board !== undefined, `no board fixture at declared version ${version}: this build reads a version with no board to read it with`);
    assert.equal(model.parsePersistedBoard(board).schemaVersion, version);
    // The gate agrees about which versions are readable, for the same list.
    assert.ok(migrations.SUPPORTED_PERSISTED_BOARD_VERSIONS.includes(version));
  }

  const { NEXT, SUPERSEDED, bumpedModel, bumped } = await buildNextVersionBumpProbe();
  assert.equal(bumpedModel.everySupportedVersionHasAParser(), true);
  assert.deepEqual([...bumpedModel.PERSISTED_BOARD_VERSIONS], [...bumped.SUPPORTED_PERSISTED_BOARD_VERSIONS]);

  // The concrete instance: at v4, a v3 board — the one the immediately
  // preceding release wrote — is readable, and refused no earlier than the gate.
  // This is where this build's own board at the version it writes today is used,
  // and it is why that board is derived rather than hand-written: the bumped
  // build is required to read the board this build writes, whatever version
  // number that turns out to be.
  const supersededBoard = boards.get(SUPERSEDED);
  assert.ok(supersededBoard !== undefined, `this build has no board at the version it writes, ${SUPERSEDED}`);
  assert.equal(supersededBoard.schemaVersion, SUPERSEDED);
  assert.equal(bumpedModel.parsePersistedBoard(supersededBoard).schemaVersion, SUPERSEDED);
  assert.equal(bumped.migratePersistedBoard(supersededBoard).board.schemaVersion, NEXT);
  // And v2 is still readable at v4, through the v2 parser, not by accident.
  const legacyBoard = boards.get(model.LEGACY_BOARD_SCHEMA_VERSION);
  assert.equal(bumpedModel.parsePersistedBoard(legacyBoard).schemaVersion, model.LEGACY_BOARD_SCHEMA_VERSION);

  // Every version the bumped build claims is readable at v4, and every one that
  // is superseded at v4 still migrates. This half *is* general: the current
  // version needs no fixture, because an empty chain leaves the board exactly as
  // it was found, and the versions this build has boards for are used as they
  // are. A version with no board behind it is stamped onto an empty one, which
  // is enough to show it is readable and migrates, and is why the bumped half
  // needs no fixture when the version after next is reached.
  //
  // The stamp is live code and it is a second place a bump can pass without a
  // real board, so it is kept deliberately rather than by inertia, and the thing
  // that holds it honest is named here. What would falsify the stamp is a bumped
  // parser that needs a field an empty board does not have: the stamp would then
  // prove readability of a board no release ever wrote. The answer is not a
  // louder assertion in this loop, it is the current-build half above. Each
  // version the bumped build declares *is* a version this build will declare one
  // bump later, so `boards` is required to hold a real board for it, and the
  // `no board fixture at declared version N` refusal — the one red this suite
  // carries on purpose in a bumped build — stops the stamp from ever being the
  // only evidence. The stamp covers the version *after* next; the refusal
  // arrives, one bump later, and demands the fixture it stood in for.
  for (const version of bumpedModel.PERSISTED_BOARD_VERSIONS) {
    const board = boards.get(version) ?? model.emptyBoard();
    assert.equal(bumpedModel.parsePersistedBoard({ ...board, schemaVersion: version }).schemaVersion, version);
    const migrated = bumped.migratePersistedBoard({ ...board, schemaVersion: version });
    assert.equal(migrated.board.schemaVersion, NEXT, `version ${version}`);
    assert.equal(migrated.throughVersions.length, bumped.persistedBoardMigrationChain(version).length);
  }
});

test('a version this build does not support is still refused by version, not by a parse symptom', () => {
  // The exhaustive dispatch must not have widened what is accepted: a version
  // that is neither current nor in the declared list is still refused, and the
  // refusal still names the version rather than reporting a key set or a field.
  const NEXT = migrations.CURRENT_PERSISTED_BOARD_VERSION + 1;
  for (const version of [1, NEXT, NEXT + 1]) {
    const refused = captureRefusal(() => model.parsePersistedBoard({ ...model.emptyBoard(), schemaVersion: version }));
    assert.equal(refused.constructor.name, 'BoardIncompatibilityError');
    assert.equal(refused.defect.kind, 'schema-version-mismatch');
    assert.match(refused.message, new RegExp(`schema version is ${version}`));
    assert.match(refused.message, new RegExp(`reads schema version ${migrations.CURRENT_PERSISTED_BOARD_VERSION}`));
  }
  // A value carrying no version at all is still a shape problem, not a version one.
  const { schemaVersion: _omitted, ...unversioned } = model.emptyBoard();
  const malformed = captureRefusal(() => model.parsePersistedBoard(unversioned));
  assert.equal(malformed.defect.kind, 'schema-version-mismatch');
});

test('a stored board from a newer Antonina is refused by version, not by a parse symptom', () => {
  // One past the version this build writes, derived rather than written down, so
  // the next bump does not need an edit here.
  const future = migrations.CURRENT_PERSISTED_BOARD_VERSION + 1;
  assert.throws(() => migrations.migratePersistedBoard({ ...model.emptyBoard(), schemaVersion: future }), (error) => {
    assert.ok(error instanceof migrations.UnsupportedPersistedBoardVersionError);
    assert.equal(error.persistedVersion, future);
    assert.match(error.message, new RegExp(`format version ${future}`));
    assert.match(error.message, /Upgrade Antonina/);
    return true;
  });
});

test('a stored board older than anything this build migrates is refused rather than guessed at', () => {
  const ancient = {
    schemaVersion: model.LEGACY_BOARD_SCHEMA_VERSION - 1,
    nextIssueNumber: 1,
    issues: [],
    resources: [],
  };
  assert.throws(() => migrations.migratePersistedBoard(ancient), (error) => {
    assert.ok(error instanceof migrations.NoPersistedBoardMigrationPathError);
    assert.equal(error.persistedVersion, model.LEGACY_BOARD_SCHEMA_VERSION - 1);
    assert.match(error.message, new RegExp(`no migration from persisted board format version ${model.LEGACY_BOARD_SCHEMA_VERSION - 1}`));
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
    schemaVersion: model.LEGACY_BOARD_SCHEMA_VERSION,
    nextIssueNumber: 2,
    issues: [{ number: 1, title: 'Broken', body: '', state: 'open', createdAt: at(1), updatedAt: at(1), messages: [] }],
    resources: [{ host: 'not-a-lubko-address', path: '/srv', issueNumbers: [1], createdAt: at(1), updatedAt: at(1) }],
  };
  assert.throws(() => migrations.migratePersistedBoard(malformed), /resource/);
});

test('a migration that produced an invalid current board is refused rather than exposed', () => {
  const legacy = model.LEGACY_BOARD_SCHEMA_VERSION;
  const chain = migrations.persistedBoardMigrationChain(legacy);
  // The step itself produces a valid board; the point of this case is that the
  // gate validates the migrated result, not that this input is bad.
  const migrated = migrations.migratePersistedBoard({
    schemaVersion: legacy,
    nextIssueNumber: 1,
    issues: [],
    resources: [],
  });
  assert.equal(migrated.board.schemaVersion, migrations.CURRENT_PERSISTED_BOARD_VERSION);
  // One step per version between the oldest this build reads and the one it
  // writes, counted from the constants rather than written down.
  assert.equal(chain.length, migrations.CURRENT_PERSISTED_BOARD_VERSION - legacy);
  // The first step out of the oldest version is the one that adds the two
  // collections; later steps are added by bumps and are not this test's subject.
  assert.equal(chain[0].from, legacy);
  assert.match(chain[0].summary, /execution-target catalog/);
});

// ---------------------------------------------------------------------------
// Layer 2: the real 0.1.0 board, through the production open path.
// ---------------------------------------------------------------------------

/**
 * The migrated board, written out by hand from the fixture rather than captured
 * from the code under test. A golden that the migration generates is not a
 * check, so this one is a second statement of what v2 -> v3 means.
 *
 * The one field taken from the module under test is `schemaVersion`: it is the
 * version the migration lands on, which a bump moves, and it is the only value
 * here that is not data the fixture itself holds. Every other field is what the
 * signed 0.1.0 log says.
 */
function expectedMigratedBoard() {
  return {
    schemaVersion: migrations.CURRENT_PERSISTED_BOARD_VERSION,
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
  const legacy = model.LEGACY_BOARD_SCHEMA_VERSION;
  const state = await verifyAndReplayOperationLog(storedLog(), fixtureAnchor());
  assert.deepEqual(state.migration, {
    persistedVersion: legacy,
    throughVersions: versionsSteppedThrough(legacy),
  });
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
  assert.equal(parsed.schemaVersion, model.LEGACY_BOARD_SCHEMA_VERSION);
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
  // so this is a signature failure and not a read. "Current format" is the
  // version this build writes, derived, so a bump needs no edit here.
  const log = storedLog();
  const board = log.operations[0].payload.board;
  log.operations[0].payload.board = {
    ...board,
    schemaVersion: migrations.CURRENT_PERSISTED_BOARD_VERSION,
    targets: [],
    dispatches: [],
  };
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
  const current = migrations.CURRENT_PERSISTED_BOARD_VERSION;
  const log = storedLog();
  const resigned = { ...log, operations: [] };
  let previous = null;
  for (const original of log.operations) {
    const payload = original.kind === 'board.initialize'
      ? { board: { ...original.payload.board, schemaVersion: current, targets: [], dispatches: [] } }
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
  assert.deepEqual(asCurrent.migration, { persistedVersion: current, throughVersions: [] });
  assert.equal(asCurrent.board.schemaVersion, current);

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
  const legacy = model.LEGACY_BOARD_SCHEMA_VERSION;
  assert.equal(first.state.migration.persistedVersion, legacy);
  assert.deepEqual(first.state.migration.throughVersions, versionsSteppedThrough(legacy));
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

  // Reopen from what is actually stored, through the ordinary read path. Once a
  // board has been migrated it is materialized v3, and a materialized board is
  // located by the credential's shared key rather than by the trust anchor
  // alone, so the ordinary path for it is the credential read.
  const reread = await store.readWithCredential(credential);
  assert.notEqual(reread, null);
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

  // The first write migrates the board, and every state after it reports the
  // board at the current version through no versions: the board is materialized
  // now, and nothing was migrated again to open it or to write to it.
  assert.equal(created.state.migration.persistedVersion, migrations.CURRENT_PERSISTED_BOARD_VERSION);
  assert.deepEqual(created.state.migration.throughVersions, []);
  assert.equal(reread.state.migration.persistedVersion, migrations.CURRENT_PERSISTED_BOARD_VERSION);
  assert.deepEqual(reread.state.migration.throughVersions, []);
  assert.equal(closed.state.board.nextIssueNumber, 8);
});

test('a legacy board that cannot be migrated is refused before anything is written', async () => {
  const log = storedLog();
  // One past the version this build writes: a board no migration can reach.
  // Derived, so a bump needs no edit here.
  log.operations[0].payload.board.schemaVersion = migrations.CURRENT_PERSISTED_BOARD_VERSION + 1;
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
  assert.equal(refusal.defect.found, String(model.LEGACY_BOARD_SCHEMA_VERSION));
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
