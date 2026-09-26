import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The CLI compiles its own copy of packages/core and of the agent-runtime
// gatherer, so these cases drive the exact module graph the shipped executable
// runs, including the four-argument `recheckCollectionClaim` and the real
// node-side `gatherCandidatePathFacts`.
import { BoardApi } from '../dist/packages/core/src/api.js';
import { runBoardCommand, COLLECT_ROOTS_ENV } from '../dist/packages/cli/src/board.js';

const STAMP = '2026-09-25T12:00:00.000Z';
const HOST = 'lubko://server';
const OTHER_HOST = 'lubko://other';

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
  return runBoardCommand(argv, { env: {}, io: capture.io, ...context }).then((code) => ({ code, ...capture }));
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
  await rm(managed, { recursive: true, force: true });
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const server = fakeSkrynia();
  const writer = api(server);
  try {
    const initialized = await writer.initialize();
    const reader = api(server, { trustAnchor: initialized.trustAnchor });
    const contexts = { root, stateHome, managed, worktree, server, writer, reader };
    const outcome = await body(contexts);
    await rm(root, { recursive: true, force: true });
    if (outcome !== undefined) return outcome;
  } finally {
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
        + 'set ANTONINA_BOARD_TRUST to the board trust anchor to read it',
    );
  });
});

test('collect list needs no managed roots configured', async () => {
  await withWorkTree(async (context) => {
    await seededWorkTree(context);
    const { code, out, err } = await run(['collect', 'list', '--host', HOST], {
      env: { [COLLECT_ROOTS_ENV]: '' },
      createClient: () => context.reader,
    });
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.equal(out.length, 1);
  });
});
