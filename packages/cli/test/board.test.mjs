import assert from 'node:assert/strict';
import test from 'node:test';

// The CLI compiles its own copy of packages/core, so the test drives the exact
// module graph the shipped executable runs, including its error identities.
import { BoardApi } from '../dist/packages/core/src/api.js';
import { serializeBoardCredential, serializeBoardTrustAnchor } from '../dist/packages/core/src/credential.js';
import { runBoardCommand, BOARD_CREDENTIAL_ENV, BOARD_TRUST_ENV } from '../dist/packages/cli/src/board.js';

const STAMP = '2026-09-25T12:00:00.000Z';

function jsonResponse(value, status = 200, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

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
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function client(server, options = {}) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(STAMP),
    newId: () => `cli-${++sequence}`,
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

test('board CLI emits deterministic JSON list output for a read-only client', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  const initialized = await owner.initialize();
  await owner.createIssue('First', 'signed board');

  const reader = client(server, { trustAnchor: initialized.trustAnchor });
  const capture = memoryIo();
  const code = await runBoardCommand(['list', '--json'], { env: {}, io: capture.io, createClient: () => reader });

  assert.equal(code, 0);
  assert.equal(JSON.parse(capture.out[0])[0].title, 'First');
  assert.deepEqual(capture.err, []);
});

test('board CLI requires author from flag or environment', async () => {
  const capture = memoryIo();
  const code = await runBoardCommand(['comment', '1', 'hello'], {
    env: {},
    io: capture.io,
    createClient: () => client(fakeSkrynia()),
  });
  assert.equal(code, 1);
  assert.match(capture.err[0], /ANTONINA_BOARD_AUTHOR/);
});

test('no board CLI command creates a missing board', async () => {
  const server = fakeSkrynia();
  const methods = [];
  const reader = client(server, { fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); } });

  for (const command of [['list'], ['access'], ['queue', 'list'], ['create', 'Mine']]) {
    const { code, err } = await run(command, { createClient: () => reader });
    assert.equal(code, 1, command.join(' '));
    assert.match(err[0], /^antonina board: /, command.join(' '));
  }

  assert.equal(methods.includes('POST'), false);
  assert.equal(server.signed, null);
});

test('every read command names initialization while the board is missing', async () => {
  const server = fakeSkrynia();
  const missing = 'antonina board: Antonina signed board does not exist; run: antonina board initialize to create it';

  for (const command of [['list'], ['list', '--json'], ['show', '1'], ['queue', 'list'], ['resource', 'list']]) {
    const { code, err } = await run(command, { createClient: () => client(server) });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], missing, command.join(' '));
  }

  assert.equal(server.signed, null);
});

test('mutating commands name initialization before they demand a credential', async () => {
  const server = fakeSkrynia();
  const missing = 'antonina board: Antonina signed board does not exist; run: antonina board initialize to create it';
  const methods = [];
  const reader = client(server, { fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); } });

  for (const command of [
    ['access'],
    ['create', 'Mine'],
    ['close', '1'],
    ['resource', 'add', '1', 'lubko://host', '/workspace'],
    ['credential', 'delegate', 'issue.create'],
  ]) {
    const { code, err } = await run(command, { createClient: () => reader });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], missing, command.join(' '));
  }

  assert.equal(methods.includes('POST'), false);
  assert.equal(methods.includes('PUT'), false);
  assert.equal(server.signed, null);
});

test('a client on an existing board with no credential is told exactly that', async () => {
  const server = fakeSkrynia();
  const initialized = await client(server).initialize();
  const reader = client(server, { trustAnchor: initialized.trustAnchor });

  for (const command of [['access'], ['create', 'Mine']]) {
    const { code, err } = await run(command, { createClient: () => reader });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], 'antonina board: Antonina board credential is required', command.join(' '));
  }

  assert.equal(server.signed.operations.length, 1);
});

test('every read command names the trust anchor when it cannot verify the board', async () => {
  const server = fakeSkrynia();
  await client(server).initialize();
  const untrusted = 'antonina board: Antonina signed board exists; this client has no trust anchor for it; '
    + 'set ANTONINA_BOARD_TRUST to the board trust anchor to read it';

  for (const command of [['list'], ['show', '1'], ['queue', 'list'], ['resource', 'list']]) {
    const { code, err } = await run(command, { createClient: () => client(server) });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], untrusted, command.join(' '));
  }
});

test('a missing board fails closed for a client that holds a valid credential', async () => {
  const elsewhere = await client(fakeSkrynia()).initialize();
  const server = fakeSkrynia();
  const writer = client(server, { credential: elsewhere.credential });
  await assert.rejects(() => writer.createIssue('Mine'), /does not exist/);

  const { code, err } = await run(['create', 'Mine'], { createClient: () => writer });

  assert.equal(code, 1);
  assert.equal(err[0], 'antonina board: Antonina signed board does not exist; run: antonina board initialize to create it');
  assert.equal(server.signed, null);
});

test('board CLI reports an existing board instead of taking the trust root again', async () => {
  const server = fakeSkrynia();
  await client(server).initialize();

  const { code, err } = await run(['initialize'], { createClient: () => client(server) });

  assert.equal(code, 1);
  assert.match(err[0], /already exists/);
});

test('board CLI reports the trust anchor and root credential after initialization', async () => {
  const server = fakeSkrynia();
  const { code, out } = await run(['initialize', '--json'], { createClient: () => client(server) });

  assert.equal(code, 0);
  const printed = JSON.parse(out[0]);
  assert.equal(printed.credential.keyId, printed.trustAnchor.rootKeyId);
  assert.equal(printed.board.nextIssueNumber, 1);
  assert.equal(server.signed.operations[0].kind, 'board.initialize');
});

test('board CLI hands the initializer the copyable trust anchor and credential', async () => {
  const server = fakeSkrynia();
  const { out } = await run(['initialize'], { createClient: () => client(server) });
  const anchor = JSON.parse(out[2]);
  const credential = JSON.parse(out[4]);

  assert.equal(out[1], 'Trust anchor (public):');
  assert.equal(serializeBoardTrustAnchor(anchor), out[2]);
  assert.equal(serializeBoardCredential(credential), out[4]);
  assert.equal(credential.storageCapability, server.capability);
  assert.equal(credential.rootKeyId, anchor.rootKeyId);
});

test('board CLI prints only the credential for a pipe-friendly initialization', async () => {
  const server = fakeSkrynia();
  const { code, out, err } = await run(['initialize', '--credential'], { createClient: () => client(server) });

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.equal(out.length, 1);
  const credential = JSON.parse(out[0]);
  assert.equal(out[0], serializeBoardCredential(credential));
  assert.equal(credential.storageCapability, server.capability);
});

test('board CLI prints only the trust anchor for a pipe-friendly initialization', async () => {
  const server = fakeSkrynia();
  const { code, out, err } = await run(['initialize', '--trust-anchor'], { createClient: () => client(server) });

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.equal(out.length, 1);
  const anchor = JSON.parse(out[0]);
  assert.equal(out[0], serializeBoardTrustAnchor(anchor));
  assert.ok(anchor.rootKeyId);
  assert.equal('credential' in anchor, false);
});

test('board CLI refuses to print both initialization values at once', async () => {
  const server = fakeSkrynia();
  const { code, out, err } = await run(
    ['initialize', '--credential', '--trust-anchor'],
    { createClient: () => client(server) },
  );

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err[0], /one value at a time/);
  assert.equal(server.signed, null);
});

test('board CLI refuses to print a secret value as JSON', async () => {
  const server = fakeSkrynia();
  const conflict = 'antonina board: --json cannot be combined with --credential or --trust-anchor';

  for (const argv of [['initialize', '--credential', '--json'], ['initialize', '--trust-anchor', '--json']]) {
    const { code, out, err } = await run(argv, { createClient: () => client(server) });
    assert.equal(code, 1, argv.join(' '));
    assert.deepEqual(out, [], argv.join(' '));
    assert.equal(err.length, 1, argv.join(' '));
    assert.equal(err[0], conflict, argv.join(' '));
    assert.equal(server.signed, null, argv.join(' '));
  }
});

test('board CLI refuses a repeated or unrecognized flag to initialize', async () => {
  const server = fakeSkrynia();
  const unexpected = 'antonina board: unexpected arguments for initialize';

  for (const argv of [
    ['initialize', '--credential', '--credential'],
    ['initialize', '--credential', 'stray'],
    ['initialize', '--unknown'],
  ]) {
    const { code, out, err } = await run(argv, { createClient: () => client(server) });
    assert.equal(code, 1, argv.join(' '));
    assert.deepEqual(out, [], argv.join(' '));
    assert.equal(err.length, 1, argv.join(' '));
    assert.equal(err[0], unexpected, argv.join(' '));
    assert.equal(server.signed, null, argv.join(' '));
  }
});

test('a pipe-friendly initialization leaves stdout empty when the board already exists', async () => {
  const server = fakeSkrynia();
  await client(server).initialize();

  for (const argv of [['initialize', '--credential'], ['initialize', '--trust-anchor']]) {
    const { code, out, err } = await run(argv, { createClient: () => client(server) });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.match(err[0], /already exists/);
    assert.equal(/storageCapability|rootKeyId/.test(err.join('\n')), false);
  }
});

test('board CLI refuses environment credentials it cannot parse or reconcile', async () => {
  const malformed = await run(['access'], { env: { [BOARD_CREDENTIAL_ENV]: 'not json' } });
  assert.equal(malformed.code, 1);
  assert.match(malformed.err[0], /must contain valid JSON/);

  const first = await client(fakeSkrynia()).initialize();
  const second = await client(fakeSkrynia()).initialize();
  const mismatched = await run(['access'], {
    env: {
      [BOARD_CREDENTIAL_ENV]: serializeBoardCredential(first.credential),
      [BOARD_TRUST_ENV]: serializeBoardTrustAnchor(second.trustAnchor),
    },
  });
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.err[0], /does not match the configured board trust anchor/);
});
