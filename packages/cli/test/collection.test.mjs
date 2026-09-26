import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The CLI compiles its own copy of packages/core and of the agent-runtime
// gatherer, so these cases drive the exact module graph the shipped executable
// runs, including the four-argument `recheckCollectionClaim` and the real
// node-side `gatherCandidatePathFacts`.
import { BoardApi } from '../dist/packages/core/src/api.js';
import { runBoardCommand } from '../dist/packages/cli/src/board.js';
import { MANAGED_ROOTS_ENV } from '../dist/packages/agent-runtime/src/managed-roots-config.js';
import {
  collectDelete,
  removeAuthorizedPath,
} from '../dist/packages/cli/src/collection.js';
// A namespace import alongside the named one, so a test that needs a member this
// module does not export *yet* fails as one failing assertion rather than as a
// link-time `SyntaxError` that takes every other test in the file with it.
import * as collectModule from '../dist/packages/cli/src/collection.js';
import {
  openCollectionClaim,
  readCollectionSnapshot,
  boardApiCollectionReader,
  recheckCollectionClaim,
  commitCollectionDeletion,
} from '../dist/packages/core/src/collection.js';
import { gatherCandidatePathFacts } from '../dist/packages/agent-runtime/src/candidate-facts.js';
import { loadManagedRoots } from '../dist/packages/agent-runtime/src/managed-roots-config.js';
import { existsSync, readFileSync } from 'node:fs';

const STAMP = '2026-09-25T12:00:00.000Z';
const HOST = 'lubko://server';
const OTHER_HOST = 'lubko://other';
// A home directory that cannot exist, so a board command that fell through to
// the ambient `$HOME` would find no configuration rather than the operator's.
const TEST_HOME = '/nonexistent-antonina-test-home';

// A minimal Skrynia stand-in, as in `board.test.mjs`: the collector's only
// contact with the board is this store, and nothing here needs a real backend.
function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed = null;
  let revision = 0;
  const etag = () => `"v${revision}"`;

  return {
    capability,
    get signed() { return signed; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      if (!String(url).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
      if (method === 'GET') {
        return signed === null ? new Response(null, { status: 404 }) : jsonResponse(signed, 200, etag());
      }
      if (method === 'POST') {
        if (signed !== null) return new Response(null, { status: 409 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return jsonResponse({ mode: 'capability-write', capability }, 201);
      }
      if (method === 'PUT') {
        const headers = new Headers(init.headers);
        if (headers.get('X-Skrynia-Capability') !== capability) return jsonResponse({ error: 'invalid capability' }, 403);
        if (headers.get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return jsonResponse({ ok: true }, 200);
      }
      return new Response(null, { status: 405 });
    },
  };
}

function jsonResponse(value, status = 200, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function api(server, options = {}) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(STAMP),
    newId: () => `collect-${++sequence}`,
    ...options,
  });
}

function memoryIo() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

function run(argv, context) {
  const capture = memoryIo();
  // `home` is a deliberately unreachable directory: these tests must resolve the
  // configuration root from the environment they are given and never from the
  // ambient `$HOME/.config/antonina` they happen to run under.
  return runBoardCommand(argv, { env: {}, home: TEST_HOME, io: capture.io, ...context }).then((code) => ({ code, ...capture }));
}

/**
 * A test-owned tree, a test-owned `XDG_STATE_HOME` under it, and a live board
 * whose registered paths are real directories inside that tree. Nothing here
 * reads or mutates ambient Antonina state, no case names a path under `$HOME`
 * or under the ambient `XDG_STATE_HOME`, and everything is reaped before the case
 * returns.
 */
async function withWorkTree(body) {
  const root = await mkdtemp(join(tmpdir(), 'antonina-collect-'));
  const stateHome = join(root, 'state');
  const managed = join(root, 'managed');
  const worktree = join(managed, 'project');
  await mkdir(managed, { recursive: true });
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const server = fakeSkrynia();
  const writer = api(server);
  try {
    const initialized = await writer.initialize();
    const reader = api(server, { trustAnchor: initialized.trustAnchor });
    const contexts = { root, stateHome, managed, worktree, server, writer, reader };
    const outcome = await body(contexts);
    if (outcome !== undefined) return outcome;
  } finally {
    // The tree is reaped in the `finally`, not after `body`: a failing assertion
    // throws past the `try` and would otherwise leak the temp tree and the test
    // `XDG_STATE_HOME` it owns.
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
}

/**
 * A board where `worktree` is registered against two open issues and `build`
 * against one, and the two `worktree` dependents are then closed, so `worktree`
 * is collectible and `build` is not.
 */
async function seededWorkTree(context) {
  const open = [];
  for (let number = 1; number <= 3; number += 1) {
    open.push(await context.writer.createIssue(`Issue ${number}`));
  }
  const build = join(context.managed, 'build');
  await context.writer.addResourceDependency(HOST, context.worktree, open[0].number);
  await context.writer.addResourceDependency(HOST, context.worktree, open[1].number);
  await context.writer.addResourceDependency(HOST, build, open[2].number);
  await context.writer.close(open[0].number);
  await context.writer.close(open[1].number);
  return { build, open };
}

test('collect list prints every collectible path with the board and the revision it came from', async () => {
  await withWorkTree(async (context) => {
    const { build } = await seededWorkTree(context);
    const { code, out, err } = await run(['collect', 'list', '--host', HOST], {
      createClient: () => context.reader,
    });

    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1, 'only the collectible worktree is listed');
    assert.equal(
      out[0],
      `collectible ${context.worktree} on ${HOST}; board ${context.reader.accessState().boardId} `
        + `rev ${context.writer.getRememberedHead()}; closed dependents #1, #2`,
    );
    assert.equal(out[0].includes(build), false);
  });
});

test('collect list reports one identical revision across all entries', async () => {
  await withWorkTree(async (context) => {
    await context.writer.createIssue('Issue 1');
    const second = join(context.managed, 'second');
    await context.writer.addResourceDependency(HOST, context.worktree, 1);
    await context.writer.addResourceDependency(HOST, second, 1);
    await context.writer.close(1);
    const revision = context.writer.getRememberedHead();

    const { code, out } = await run(['collect', 'list', '--host', HOST, '--json'], {
      createClient: () => context.reader,
    });

    assert.equal(code, 0);
    const entries = JSON.parse(out[0]);
    assert.equal(entries.length, 2);
    const boardIds = new Set(entries.map((entry) => entry.boardId));
    const revisions = new Set(entries.map((entry) => entry.revision));
    assert.deepEqual([...boardIds], [context.reader.accessState().boardId]);
    assert.deepEqual([...revisions], [revision]);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['boardId', 'closedDependents', 'host', 'path', 'revision']);
      assert.equal(entry.host, HOST);
    }
  });
});

test('collect list excludes paths protected by an open dependency', async () => {
  await withWorkTree(async (context) => {
    const { build } = await seededWorkTree(context);
    const { code, out } = await run(['collect', 'list', '--host', HOST, '--json'], {
      createClient: () => context.reader,
    });

    assert.equal(code, 0);
    const paths = JSON.parse(out[0]).map((entry) => entry.path);
    assert.deepEqual(paths, [context.worktree]);
    assert.equal(paths.includes(build), false);
  });
});

test('collect list requires --host', async () => {
  await withWorkTree(async (context) => {
    const { code, out, err } = await run(['collect', 'list'], { createClient: () => context.reader });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.match(err[0], /--host/);
  });
});

test('collect list refuses a host that is not a lubko host identity', async () => {
  await withWorkTree(async (context) => {
    for (const host of ['https://example.com', 'lubko://', 'not-a-host']) {
      const { code, out, err } = await run(['collect', 'list', '--host', host], {
        createClient: () => context.reader,
      });
      assert.equal(code, 1, host);
      assert.deepEqual(out, [], host);
      assert.match(err[0], /lubko/, host);
    }
  });
});

test('collect list needs no credential', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    // A reader with the trust anchor and nothing else: no credential, and no
    // write capability of any kind, and the list is still complete.
    const { code, out, err } = await run(['collect', 'list', '--host', HOST], {
      createClient: () => context.reader,
    });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
  });
});

test('collect list surfaces a missing board as a failure and never as an empty list', async () => {
  await withWorkTree(async () => {
    const missing = fakeSkrynia();
    for (const argv of [['collect', 'list', '--host', HOST], ['collect', 'list', '--host', HOST, '--json']]) {
      const { code, out, err } = await run(argv, { createClient: () => api(missing) });
      assert.equal(code, 1, argv.join(' '));
      assert.deepEqual(out, [], argv.join(' '));
      assert.equal(
        err[0],
        'antonina board: Antonina signed board does not exist; run: antonina board initialize to create it',
        argv.join(' '),
      );
    }
    assert.equal(missing.signed, null);
  });
});

test('collect list surfaces an unverifiable board and names the trust anchor', async () => {
  await withWorkTree(async (context) => {
    const { code, out, err } = await run(['collect', 'list', '--host', HOST], {
      createClient: () => api(context.server),
    });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.equal(
      err[0],
      'antonina board: Antonina signed board exists; this client has no trust anchor for it; '
        + 'save the board trust anchor as $XDG_CONFIG_HOME/antonina/trust.json to read it',
    );
  });
});

test('collect list needs no managed roots configured', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const { code, out, err } = await run(['collect', 'list', '--host', HOST], {
      env: { [MANAGED_ROOTS_ENV]: '' },
      createClient: () => context.reader,
    });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
  });
});

const deleteArgs = (context, path, extra = []) => [
  'collect',
  'delete',
  '--host',
  HOST,
  '--path',
  path,
  ...extra,
];

const collectEnv = (context) => ({ [MANAGED_ROOTS_ENV]: context.managed });

/** A reader that lets the board move on exactly once, between two reads. */
function advancingReader(context, onSecondRead) {
  let reads = 0;
  return {
    async loadState() {
      reads += 1;
      if (reads === 2) await onSecondRead();
      return context.reader.loadState();
    },
    accessState() {
      return context.reader.accessState();
    },
  };
}

test('collect delete without --confirm reports the pending action and removes nothing', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    const before = context.writer.getRememberedHead();

    const { code, out, err } = await run(deleteArgs(context, context.worktree), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
    // The dry run reports no removal shape: the shape is on the authorization,
    // which exists only inside a confirmed run's re-check, so a pending report
    // says what the command would do with a path and nothing about how.
    assert.equal(
      out[0],
      `would delete ${context.worktree} on ${HOST} (a symlink would be unlinked as a link, `
        + `anything else removed recursively); board ${context.reader.accessState().boardId} `
        + `rev ${before}; re-run with --confirm`,
    );
    assert.equal(existsSync(context.worktree), true, 'nothing was unlinked');

    // The pending report has no `removal` key at all, and that absence is the
    // pending/deleted discriminator in `--json` (the payload carries no `mode`),
    // so it is asserted rather than assumed.
    const json = await run(deleteArgs(context, context.worktree, ['--json']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });
    assert.equal(json.code, 0);
    const pending = JSON.parse(json.out[0]);
    assert.equal('removal' in pending, false, Object.keys(pending).join(','));
    assert.equal(pending.path, context.worktree);
    assert.equal(pending.recheckHead, before);
    assert.equal(existsSync(context.worktree), true);
  });
});

test('collect delete with --confirm removes the path and reports the re-read revision', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(join(context.worktree, 'nested'), { recursive: true });
    const boardId = context.reader.accessState().boardId;
    const revision = context.writer.getRememberedHead();

    const { code, out, err } = await run(deleteArgs(context, context.worktree, ['--confirm', '--json']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(JSON.parse(out[0]), {
      host: HOST,
      boardId,
      path: context.worktree,
      outcome: 'collect',
      reason: 'still-collectible',
      recheckHead: revision,
      snapshotHead: revision,
      removal: 'unlinked',
    });
    assert.equal(existsSync(context.worktree), false);
  });
});

test('collect delete reports recheckHead and leaves snapshotHead null when the board advanced between the claim and the re-check', async () => {
  await withWorkTree(async (context) => {
    const { open } = await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    const claimRevision = context.writer.getRememberedHead();

    const advance = async () => {
      await context.writer.comment(open[0].number, 'root', 'unrelated board traffic');
    };

    const pending = await run(deleteArgs(context, context.worktree, ['--json']), {
      env: collectEnv(context),
      createClient: () => advancingReader(context, advance),
    });
    assert.equal(pending.code, 0);
    const report = JSON.parse(pending.out[0]);
    // The claim named one revision and the re-check read a different one, so the
    // claim's revision is reported as null and only the verified one is reported
    // as authority.
    assert.equal(report.snapshotHead, null);
    assert.notEqual(report.recheckHead, claimRevision);
    assert.equal(report.outcome, 'collect');

    const human = await run(deleteArgs(context, context.worktree), {
      env: collectEnv(context),
      createClient: () => advancingReader(context, advance),
    });
    assert.equal(human.code, 0);
    const revisions = human.out[0].match(/rev \S+/g) ?? [];
    assert.equal(revisions.length, 1, human.out[0]);
    assert.equal(human.out[0].includes(`rev ${claimRevision}`), false);
    // The named revision is the one this run's own re-check read, which is not
    // the revision the claim named and not any revision the listing printed.
    assert.equal(human.out[0].includes('rev unavailable'), false);
    assert.match(human.out[0], /; re-run with --confirm$/);
    assert.equal(existsSync(context.worktree), true);
  });
});

test('collect delete refuses a path that is not registered, and leaves it alone', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const stranger = join(context.managed, 'stranger');
    await mkdir(stranger);

    const { code, out, err } = await run(deleteArgs(context, stranger, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.match(err[0], /unregistered/);
    assert.equal(existsSync(stranger), true);
  });
});

test('collect delete refuses a path another host owns', async () => {
  await withWorkTree(async (context) => {
    const { open } = await seededWorkTree(context);
    const theirs = join(context.managed, 'theirs');
    await mkdir(theirs);
    await context.writer.addResourceDependency(OTHER_HOST, theirs, open[2].number);

    const { code, err } = await run(deleteArgs(context, theirs, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 1);
    assert.match(err[0], /wrong-board/);
    assert.equal(existsSync(theirs), true);
  });
});

test('collect delete refuses a path that became protected and leaves it alone', async () => {
  await withWorkTree(async (context) => {
    const { open } = await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    // An open issue depends on it again, so the re-check withholds.
    await context.writer.reopen(open[1].number);

    const { code, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 1);
    assert.match(err[0], /became-protected/);
    assert.equal(existsSync(context.worktree), true);
  });
});

test('collect delete refuses a path in no configured managed root with outside-managed-roots', async () => {
  await withWorkTree(async (context) => {
    const issue = await context.writer.createIssue('Issue 1');
    const elsewhere = join(context.root, 'outside');
    await mkdir(elsewhere, { recursive: true });
    await context.writer.addResourceDependency(HOST, elsewhere, issue.number);
    await context.writer.close(issue.number);

    const { code, err } = await run(deleteArgs(context, elsewhere, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 1);
    assert.match(err[0], /outside-managed-roots/);
    assert.equal(existsSync(elsewhere), true);
  });
});

test('collect delete refuses a managed root itself with candidate-is-managed-root', async () => {
  await withWorkTree(async (context) => {
    const issue = await context.writer.createIssue('Issue 1');
    await context.writer.addResourceDependency(HOST, context.managed, issue.number);
    await context.writer.close(issue.number);

    const { code, err } = await run(deleteArgs(context, context.managed, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 1);
    assert.match(err[0], /candidate-is-managed-root/);
    assert.equal(existsSync(context.managed), true);
  });
});

test('collect delete refuses a symlink whose target escapes its managed root and leaves both the link and its target intact', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const outside = join(context.root, 'outside-target');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, context.worktree);

    const { code, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 1);
    assert.match(err[0], /not-managed-collectible/);
    assert.equal(existsSync(context.worktree), true, 'the link is still there');
    assert.equal(existsSync(join(outside, 'keep.txt')), true, 'the target is untouched');
  });
});

test('collect delete refuses a path whose containing directory escapes its managed root while its own resolved path lands back inside it, and leaves it alone', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    // A double symlink, chosen so that only the containing-directory check can
    // catch it: the containing directory `link` escapes the managed root, and the
    // candidate's own resolved path comes back *inside* it, so the
    // `symlink-escapes-managed-root` check is satisfied and cannot be what fired.
    // A single symlink cannot do this -- both checks refuse it, so deleting the
    // containing-directory check would change nothing and the test would
    // discriminate nothing.
    const back = join(context.managed, 'back');
    await mkdir(join(back, 'project'), { recursive: true });
    await writeFile(join(back, 'project', 'precious.txt'), 'precious');
    const real = join(context.root, 'real');
    await mkdir(real, { recursive: true });
    // `real/project` is a symlink back into the managed root, so the candidate's
    // resolved path is `managed/back/project` and the candidate's final component
    // is a symlink too -- the two shapes the re-check would otherwise follow.
    await symlink(join(back, 'project'), join(real, 'project'));
    const link = join(context.managed, 'link');
    await symlink(real, link);
    const throughLink = join(link, 'project');
    const issue = await context.writer.createIssue('Issue 1');
    await context.writer.addResourceDependency(HOST, throughLink, issue.number);
    await context.writer.close(issue.number);

    const { code, err } = await run(deleteArgs(context, throughLink, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    // Core reports this refusal as `not-managed-collectible` because
    // `managedReason` folds the three path-safety refusals into one reason. The
    // fold is why the fixture, not the message, has to discriminate: with the
    // containing-directory check removed this run authorizes and exits 0, so this
    // assertion fails.
    assert.equal(code, 1);
    assert.match(err[0], /not-managed-collectible/);
    assert.equal(existsSync(throughLink), true, 'the link chain is still there');
    assert.equal(readFileSync(join(back, 'project', 'precious.txt'), 'utf8'), 'precious');
  });
});

test('collect delete unlinks an in-root symlink as a link and never recurses into its target', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const target = join(context.managed, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'keep');
    await symlink(target, context.worktree);

    const { code, out, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 0, err.join('\n'));
    assert.equal(out.length, 1);
    assert.match(out[0], /^unlinked symlink /);
    assert.equal(existsSync(context.worktree), false, 'the link is gone');
    assert.equal(existsSync(target), true, 'the target was not followed');
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep');
  });
});

test('collect delete removes a non-empty directory recursively', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(join(context.worktree, 'a', 'b'), { recursive: true });
    await writeFile(join(context.worktree, 'a', 'b', 'file.txt'), 'x');

    const { code, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 0, err.join('\n'));
    assert.equal(existsSync(context.worktree), false);
  });
});

test('collect delete reports candidate-facts-unavailable when neither the path nor its parent exists and touches nothing', async () => {
  await withWorkTree(async (context) => {
    const issue = await context.writer.createIssue('Issue 1');
    const orphan = join(context.managed, 'vanished', 'child');
    await context.writer.addResourceDependency(HOST, orphan, issue.number);
    await context.writer.close(issue.number);

    const { code, err } = await run(deleteArgs(context, orphan, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 1);
    assert.match(err[0], /candidate-facts-unavailable/);
    assert.equal(existsSync(context.managed), true, 'the managed root itself is still present');
  });
});

test('collect delete reports the ManagedRootDefect verbatim and reads no board when the root set is invalid', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const missing = fakeSkrynia();
    const methods = [];
    const reader = api(missing, {
      fetch: async (url, init = {}) => {
        methods.push(init.method ?? 'GET');
        return missing.fetch(url, init);
      },
    });

    const { code, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: { [MANAGED_ROOTS_ENV]: `${context.managed}:${context.managed}` },
      createClient: () => reader,
    });

    assert.equal(code, 1);
    assert.match(err[0], /duplicate/);
    assert.match(err[0], new RegExp(context.managed.replace(/[./*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(methods, [], 'no board read at all');

    const noRoots = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: {},
      createClient: () => reader,
    });
    assert.equal(noRoots.code, 1);
    assert.match(noRoots.err[0], /ANTONINA_COLLECT_ROOTS/);
    assert.deepEqual(methods, []);

    // A root that resolves to `/` is refused on the same boundary, before any
    // board read, so a symlinked filesystem root cannot reach a judgment.
    const worklink = join(context.root, 'worklink');
    await symlink('/', worklink);
    const toRoot = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: { [MANAGED_ROOTS_ENV]: worklink },
      createClient: () => reader,
    });
    assert.equal(toRoot.code, 1);
    assert.match(toRoot.err[0], /root-resolves-to-filesystem-root/);
    assert.deepEqual(methods, []);
  });
});

test('collect delete reports a board that cannot be read and commits no authorization', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    const broken = api(context.server, {
      trustAnchor: context.reader.getTrustAnchor(),
      fetch: async () => { throw new Error('network down'); },
    });

    const { code, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => broken,
    });

    assert.equal(code, 1);
    assert.match(err[0], /board-read-failed/);
    assert.match(err[0], /network down/);
    assert.match(err[0], /ANTONINA_BOARD_URL/);
    assert.equal(existsSync(context.worktree), true, 'nothing was removed');
  });
});

test('collect delete refuses a malformed or non-canonical path before any board read', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const missing = fakeSkrynia();
    const methods = [];
    const reader = api(missing, {
      fetch: async (url, init = {}) => {
        methods.push(init.method ?? 'GET');
        return missing.fetch(url, init);
      },
    });

    for (const path of ['relative/project', `${context.managed}/../elsewhere`, `${context.managed}/`]) {
      const { code, err } = await run(deleteArgs(context, path, ['--confirm']), {
        env: collectEnv(context),
        createClient: () => reader,
      });
      assert.equal(code, 1, path);
      assert.match(err[0], /canonical absolute POSIX path/, path);
    }
    assert.deepEqual(methods, []);
  });
});

test('collect delete treats an already-absent path as success', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    // Registered and collectible, and never created on disk: a path that does
    // not exist yet is a real deletion target, and the goal state already holds.
    assert.equal(existsSync(context.worktree), false);

    const { code, out, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });

    assert.equal(code, 0, err.join('\n'));
    assert.match(out[0], /^already absent /);
    assert.equal(existsSync(context.worktree), false);
  });
});

test('a removal that fails for any reason other than absence is not swallowed', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    const managed = await loadManagedRoots(collectEnv(context));
    const snapshot = await readCollectionSnapshot(HOST, boardApiCollectionReader(context.reader));
    const claim = openCollectionClaim(snapshot, context.worktree);
    // A real gatherer, so the authorization carries the shape a directory earns.
    const authorized = await recheckCollectionClaim(
      claim,
      context.reader,
      managed.roots,
      gatherCandidatePathFacts,
    );
    assert.equal(authorized.outcome, 'collect');
    let fallbackCalls = 0;

    await assert.rejects(
      () => removeAuthorizedPath(authorized, {
        rm: async () => {
          const error = new Error('permission denied');
          error.code = 'EACCES';
          throw error;
        },
        unlink: async () => { fallbackCalls += 1; },
      }),
      /permission denied/,
    );
    assert.equal(fallbackCalls, 0, 'the other branch was not tried as a fallback');
    assert.equal(existsSync(context.worktree), true);
  });
});

/**
 * The removal takes the shape the re-check authorized and observes nothing of
 * its own. The candidate's final component is replaced *after* the re-check
 * completes, so a collector that re-derived the shape would take the other
 * branch. The authorized shape is what is followed.
 *
 * The second half is the one that cannot be mistaken: a candidate the re-check
 * found to be a symlink is replaced by a directory, and the authorized removal
 * is `unlink` -- which fails on a directory. A re-deriving implementation would
 * have seen the directory and recursed into it, removing the very resource the
 * re-check said was a link's target and not a deletion target.
 */
test('the removal follows the authorized shape even when the final component changed after the re-check', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const outside = join(context.managed, 'target');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep'), 'not part of the candidate');
    const managed = await loadManagedRoots(collectEnv(context));
    const reader = boardApiCollectionReader(context.reader);

    // Half one: a directory at re-check time, a symlink at removal time. The
    // authorized shape is "not a symlink", so the link is removed as the shape
    // the re-check judged, and the report says `unlinked` rather than
    // `unlinked-symlink` -- which is what a re-deriving collector would print.
    await mkdir(context.worktree, { recursive: true });
    const asDirectory = await recheckCollectionClaim(
      openCollectionClaim(await readCollectionSnapshot(HOST, reader), context.worktree),
      context.reader,
      managed.roots,
      gatherCandidatePathFacts,
    );
    assert.equal(asDirectory.outcome, 'collect');
    assert.equal(asDirectory.unlinkFinalComponent, false);
    await rm(context.worktree, { recursive: true, force: true });
    await symlink(outside, context.worktree);

    assert.equal(await removeAuthorizedPath(asDirectory), 'unlinked');
    assert.equal(existsSync(context.worktree), false);
    assert.equal(existsSync(join(outside, 'keep')), true, 'the link target was not collected');

    // Half two: a symlink at re-check time, a directory at removal time.
    await context.writer.createIssue('Issue 4');
    await context.writer.addResourceDependency(HOST, context.worktree, 4);
    await context.writer.close(4);
    await symlink(outside, context.worktree);
    const asSymlink = await recheckCollectionClaim(
      openCollectionClaim(await readCollectionSnapshot(HOST, reader), context.worktree),
      context.reader,
      managed.roots,
      gatherCandidatePathFacts,
    );
    assert.equal(asSymlink.outcome, 'collect');
    assert.equal(asSymlink.unlinkFinalComponent, true);
    await rm(context.worktree, { recursive: true, force: true });
    await mkdir(context.worktree, { recursive: true });
    await writeFile(join(context.worktree, 'inside'), 'the candidate');

    // `unlink` on a directory is `EISDIR`/`EPERM`; `rm --recursive` would have
    // succeeded. The failure is the proof that the authorized shape was used
    // with no observation of its own.
    await assert.rejects(() => removeAuthorizedPath(asSymlink), /EISDIR|EPERM|is a directory|not permitted/);
    assert.equal(existsSync(join(context.worktree, 'inside')), true, 'nothing was removed');
  });
});

test('collect delete performs one removal and spends its authorization once', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    const boardBefore = JSON.stringify(context.server.signed);

    // The real four-argument re-check, with the real node-side gatherer, driven
    // from this CLI-side test: an authorization is spent by exactly one removal.
    const managed = await loadManagedRoots(collectEnv(context));
    assert.equal(managed.ok, true, JSON.stringify(managed));
    const snapshot = await readCollectionSnapshot(HOST, boardApiCollectionReader(context.reader));
    assert.equal(snapshot.verified, true);
    const claim = openCollectionClaim(snapshot, context.worktree);
    const authorized = await recheckCollectionClaim(
      claim,
      context.reader,
      managed.roots,
      gatherCandidatePathFacts,
    );
    assert.equal(authorized.outcome, 'collect');
    const completed = commitCollectionDeletion(authorized);
    assert.deepEqual(completed, {
      state: 'spent',
      outcome: 'collect',
      reason: 'still-collectible',
      host: HOST,
      path: context.worktree,
      recheckHead: authorized.recheckHead,
    });
    assert.throws(
      () => commitCollectionDeletion(authorized),
      /not a live authorization/,
    );

    // And the command's own deletion is one removal, not two.
    const { code, err } = await run(deleteArgs(context, context.worktree, ['--confirm']), {
      env: collectEnv(context),
      createClient: () => context.reader,
    });
    assert.equal(code, 0, err.join('\n'));
    assert.equal(existsSync(context.worktree), false);
    // Committing is local bookkeeping: it never writes to the board, so the
    // board still registers the path it just removed.
    assert.equal(JSON.stringify(context.server.signed), boardBefore);
  });
});

/**
 * `collect delete` driven directly, so the completion record is observable: the
 * commit is a module-private delete, so the only way to see it from a test is
 * through the same authorization it spent, which a second commit then refuses.
 */
function deleteDirectly(context, path, extra) {
  return collectDelete(context.reader, {
    host: HOST,
    path,
    confirm: true,
    env: collectEnv(context),
    ...extra,
  });
}

test('a removal that fails part-way is still owed its one commit', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const nested = join(context.worktree, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'partial'), 'gone before the removal failed');

    let unlinkCalls = 0;
    let commitCalls = 0;
    let committed;
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    await assert.rejects(
      () => deleteDirectly(context, context.worktree, {
        // A real removal on a real tree that takes a prefix of it and then fails,
        // which is the part-way case: the removal happened and cannot be undone.
        removalFs: {
          rm: async (target) => {
            await rm(join(target, 'nested'), { recursive: true });
            throw failure;
          },
          unlink: async () => { unlinkCalls += 1; },
        },
        commit: (authorized) => {
          commitCalls += 1;
          committed = authorized;
          return commitCollectionDeletion(authorized);
        },
      }),
      // The removal's own failure reaches the caller, unchanged: same object, so
      // same kind and same message.
      (error) => error === failure,
    );

    assert.equal(existsSync(join(nested, 'partial')), false, 'a prefix of the tree was really removed');
    assert.equal(existsSync(context.worktree), true, 'the removal stopped part-way');
    assert.equal(unlinkCalls, 0, 'the other branch was not tried as a fallback');
    assert.equal(commitCalls, 1, 'a removal that was performed is owed exactly one commit');
    assert.throws(() => commitCollectionDeletion(committed), /not a live authorization/);
  });
});

test('a bookkeeping failure cannot replace the removal failure it was owed for', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    await assert.rejects(
      () => deleteDirectly(context, context.worktree, {
        removalFs: {
          rm: async () => { throw failure; },
          unlink: async () => {},
        },
        commit: () => { throw new Error('the completion record could not be written'); },
      }),
      (error) => error === failure,
    );
  });
});

test('a refusal and an un-confirmed pending report are owed no commit at all', async () => {
  await withWorkTree(async (context) => {
    const { open } = await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    let commitCalls = 0;
    const commit = () => { commitCalls += 1; };

    // The un-confirmed gate: a real re-check runs and the claim is dropped, and
    // nothing is removed, so nothing is owed a commit.
    const pending = await deleteDirectly(context, context.worktree, { commit, confirm: false });
    assert.equal(pending.mode, 'collect-pending');
    assert.equal(commitCalls, 0, 'a pending report spent nothing');
    assert.equal(existsSync(context.worktree), true);

    // A re-check that withholds, after a claim that did not: the board gains an
    // open dependent on the worktree between the claim's read and the re-check's.
    // The second read is the re-check's; the first is the claim's.
    const reader = {
      reads: 0,
      async loadState() {
        this.reads += 1;
        if (this.reads === 2) {
          await context.writer.addResourceDependency(HOST, context.worktree, open[2].number);
        }
        return context.reader.loadState();
      },
      accessState() {
        return context.reader.accessState();
      },
    };
    await assert.rejects(
      () => collectDelete(reader, {
        host: HOST,
        path: context.worktree,
        confirm: true,
        env: collectEnv(context),
        commit,
      }),
      /refusing to collect/,
    );
    assert.equal(commitCalls, 0, 'a refusal spent nothing');
  });
});

/**
 * The report is the one consumer of the authorization that is *not* destructive,
 * so it is the one `hosts.md`'s "every destructive consumer re-derives" never
 * covered: before the fix the report and the refusal text below were built from
 * `collectDelete`'s own reference to the authorization, so a record re-pointed
 * after the re-check would have been named verbatim while the removal refused to
 * act on it -- a report naming a path, host or board no re-check examined.
 *
 * `collectDeleteReport` is the whole of that building, and it takes the same
 * module-private door the removal and the commit take, so a re-pointed record
 * produces no report at all rather than a report of the caller's values.
 */
test('the delete report and the refusal text are built from the issued record, not the caller\'s object', async () => {
  assert.equal(
    typeof collectModule.collectDeleteReport,
    'function',
    'the CLI has no report builder of its own to route through the issued record',
  );
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    await mkdir(context.worktree, { recursive: true });
    const managed = await loadManagedRoots(collectEnv(context));
    const reader = boardApiCollectionReader(context.reader);
    const authorized = await recheckCollectionClaim(
      openCollectionClaim(await readCollectionSnapshot(HOST, reader), context.worktree),
      context.reader,
      managed.roots,
      gatherCandidatePathFacts,
    );
    assert.equal(authorized.outcome, 'collect');

    // Untouched: the report is what the command has always printed.
    const reported = collectModule.collectDeleteReport(authorized);
    assert.deepEqual(reported, {
      host: HOST,
      boardId: context.reader.accessState().boardId,
      path: context.worktree,
      outcome: 'collect',
      reason: 'still-collectible',
      recheckHead: authorized.recheckHead,
      snapshotHead: authorized.snapshotHead,
    });

    // Re-pointed at a path, a host and a board no re-check ever read. The removal
    // and the commit already refuse this record; the report is the half that used
    // to obey it.
    const repointed = await recheckCollectionClaim(
      openCollectionClaim(await readCollectionSnapshot(HOST, reader), context.worktree),
      context.reader,
      managed.roots,
      gatherCandidatePathFacts,
    );
    repointed.path = join(context.managed, 'build');
    repointed.host = OTHER_HOST;
    repointed.boardId = 'a-board-no-recheck-read';
    assert.throws(() => collectModule.collectDeleteReport(repointed), /was changed after the re-check/);
    assert.equal(existsSync(context.worktree), true, 'nothing was removed');
  });
});
