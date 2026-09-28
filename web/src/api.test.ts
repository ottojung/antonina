import { describe, expect, it } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// Every board in this file is the in-memory fake Skrynia below, and the XDG
// roots are pointed at paths that cannot exist so no code under test can reach
// the real `$XDG_STATE_HOME` or the real `trust.json` / `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-feed-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-feed-config';

import { generateSigningKey } from '../../packages/core/src/canonical';
import {
  BrowserBoardSession,
  BoardTrustRequiredError,
  createBrowserBoardApi,
  DEFAULT_FEED_LIMIT,
  serializeBoardCredential,
  serializeBoardTrustAnchor,
  type BoardCredential,
  type BoardKeyStorage,
} from './api';
import { appendFeedPage, readFeedFirstPage, type FeedRead } from './ui-state';

const STAMP = '2026-09-25T12:00:00.000Z';

function jsonResponse(value: unknown, status = 200, etag?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

/** The CAS storage behaviour the signed board relies on. */
function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed: unknown = null;
  let revision = 0;
  const etag = () => `"v${revision}"`;

  return {
    capability,
    get signed() { return signed; },
    set signed(value: unknown) { signed = value; },
    async fetch(input: string | URL | Request, init: RequestInit = {}) {
      const method = init.method ?? 'GET';
      if (!String(input).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
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
        if (new Headers(init.headers).get('X-Skrynia-Capability') !== capability) return jsonResponse({ error: 'invalid capability' }, 403);
        if (new Headers(init.headers).get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function memoryStorage(): BoardKeyStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

function session(server: ReturnType<typeof fakeSkrynia>, storage: BoardKeyStorage = memoryStorage()): BrowserBoardSession {
  let sequence = 0;
  return new BrowserBoardSession(storage, {
    fetch: (input, init) => server.fetch(String(input), init),
    now: () => new Date(STAMP),
    newId: () => `web-${++sequence}`,
  });
}

function storedCredential(storage: BoardKeyStorage): BoardCredential {
  return JSON.parse(storage.get('antonina:board-v2:credential') ?? 'null') as BoardCredential;
}

async function initializedBoard(storage: BoardKeyStorage = memoryStorage()) {
  const server = fakeSkrynia();
  const owner = session(server, storage);
  return { server, storage, owner, initialized: await owner.initialize() };
}

describe('browser board session', () => {
  it('verifies the stored log once per trust and once per initialize', async () => {
    // Both of these calls read and verify the whole operation log, and both hand
    // back the state that read verified, so nothing has to read the log again
    // for the queue. What must never happen is a second verification inside
    // either of them, so the count after each call is that call's whole budget.
    const server = fakeSkrynia();
    const storage = memoryStorage();
    let gets = 0;
    const counting = () => new BrowserBoardSession(storage, {
      fetch: async (input, init) => {
        if ((init?.method ?? 'GET') === 'GET') gets += 1;
        return server.fetch(String(input), init);
      },
      now: () => new Date(STAMP),
    });
    const owner = counting();
    const initialized = await owner.initialize();
    // A fresh client checks v3 and then legacy v2 before creating the board,
    // followed by one read-back of the board it created. There is no duplicate
    // v3 probe on that read-back.
    expect(gets).toBe(3);
    expect(initialized.state.board.issues).toEqual([]);
    expect(initialized.state.queue).toEqual([]);

    const reader = counting();
    const state = await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));
    // A fresh reader probes v3 once, then reads/verifies legacy v2 once. It
    // returns that verified state directly, so no third read follows it.
    expect(gets).toBe(5);
    expect(state.board.issues).toEqual([]);
    expect(state.queue).toEqual([]);
  });

  it('reports a missing board on a plain page load without creating it', async () => {
    const server = fakeSkrynia();
    const methods: Array<string | undefined> = [];
    const client = new BrowserBoardSession(memoryStorage(), {
      fetch: async (input, init) => {
        methods.push(init?.method);
        return server.fetch(String(input), init);
      },
    });

    await expect(client.readState()).resolves.toBeNull();
    expect(methods).not.toContain('POST');
    expect(server.signed).toBeNull();
  });

  it('creates the board and its keys in this browser only on explicit initialization', async () => {
    const storage = memoryStorage();
    const before = await initializedBoard(storage);
    const reader = session(before.server, storage);

    expect(reader.credentialText()).toBe(serializeBoardCredential(before.initialized.credential));
    expect(reader.trustAnchorText()).toBe(serializeBoardTrustAnchor(before.initialized.trustAnchor));
    expect(storage.get('antonina:board-v2:accepted-head')).toBe(before.initialized.state.head);
    expect((await reader.api.verifyCredential()).canEdit).toBe(true);
    expect(reader.api.hasWriteAccess()).toBe(true);
  });

  it('holds a stored credential without claiming edit access before reading the board', async () => {
    const { server, storage } = await initializedBoard();
    const reopened = session(server, storage);

    expect(reopened.hasCredential()).toBe(true);
    expect(reopened.api.hasWriteAccess()).toBe(false);
  });

  it('refuses a second initializer instead of taking the trust root', async () => {
    const { server } = await initializedBoard();
    const log = server.signed;
    const second = session(server);

    await expect(second.initialize()).rejects.toThrow('The Antonina signed board already exists');
    expect(server.signed).toBe(log);
    expect(second.hasCredential()).toBe(false);
  });

  it('needs a trust anchor before it can read an existing board', async () => {
    const { server, initialized } = await initializedBoard();
    const reader = session(server);

    await expect(reader.readState()).rejects.toBeInstanceOf(BoardTrustRequiredError);
    const state = await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));
    expect(state.board.issues).toEqual([]);
  });

  it('reads a board through a trust anchor alone, and stays read-only', async () => {
    const server = fakeSkrynia();
    const owner = session(server);
    const initialized = await owner.initialize();
    await owner.api.createIssue('Visible', 'signed board');

    const reader = session(server);
    const state = await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));

    expect(state.board.issues[0]).toMatchObject({ number: 1, title: 'Visible', createdAt: STAMP });
    expect(reader.hasCredential()).toBe(false);
    expect(reader.api.hasWriteAccess()).toBe(false);
    await expect(reader.api.createIssue('Blocked')).rejects.toThrow('credential is required');
  });

  it('refuses a malformed or forged trust anchor', async () => {
    const { server, initialized } = await initializedBoard();
    const reader = session(server);

    await expect(reader.trust('not json')).rejects.toThrow('not valid JSON');
    await expect(reader.trust(JSON.stringify({ boardId: 'b', rootKeyId: 'ed25519:AAAA', rootPublicKey: 'AAAA' })))
      .rejects.toThrow('trust anchor is malformed');
    const foreign = await generateSigningKey();
    await expect(reader.trust(serializeBoardTrustAnchor({ ...initialized.trustAnchor, rootPublicKey: foreign.publicKey })))
      .rejects.toThrow('key ID does not match its public key');
    expect(reader.api.getTrustAnchor()).toBeNull();
  });

  it('enables editing from a shared credential and keeps read-only mode honest', async () => {
    const server = fakeSkrynia();
    const owner = session(server);
    const initialized = await owner.initialize();
    const storage = memoryStorage();
    const other = session(server, storage);
    await other.trust(serializeBoardTrustAnchor(initialized.trustAnchor));

    const access = await other.enableEditing(serializeBoardCredential(initialized.credential));

    expect(access.canEdit).toBe(true);
    expect(storedCredential(storage).keyId).toBe(initialized.credential.keyId);
    await expect(other.api.createIssue('Edited here')).resolves.toMatchObject({ number: 1 });

    other.clearCredential();
    expect(other.hasCredential()).toBe(false);
    expect(storage.get('antonina:board-v2:credential')).toBeNull();
    expect(storage.get('antonina:board-v2:trust')).not.toBeNull();
    await expect(other.api.createIssue('Blocked')).rejects.toThrow('credential is required');
  });

  it('never writes to the board while reading, polling, or claiming edit access', async () => {
    const { server, storage, initialized } = await initializedBoard();
    await session(server, storage).api.createIssue('Existing');
    const methods: Array<string | undefined> = [];
    const reopened = new BrowserBoardSession(storage, {
      fetch: async (input, init) => {
        methods.push(init?.method);
        return server.fetch(String(input), init);
      },
      now: () => new Date(STAMP),
    });

    await reopened.readState();
    await reopened.readState();
    expect(reopened.hasCredential()).toBe(true);
    expect(reopened.api.hasWriteAccess()).toBe(true);
    expect(reopened.api.accessState().storageRejected).toBe(false);

    expect(methods).not.toContain('POST');
    expect(methods).not.toContain('PUT');
    expect(methods.every((method) => method === undefined)).toBe(true);
    expect((server.signed as { operations: unknown[] }).operations.length).toBe(2);
    expect(initialized.credential.keyId).toBe(reopened.api.getCredential()?.keyId);
  });

  it('surfaces a stale storage capability on the first mutation and then drops edit access', async () => {
    const server = fakeSkrynia();
    const owner = session(server);
    const initialized = await owner.initialize();
    const other = session(server);
    await other.trust(serializeBoardTrustAnchor(initialized.trustAnchor));

    const stale = { ...initialized.credential, storageCapability: 'b'.repeat(64) };
    const access = await other.enableEditing(serializeBoardCredential(stale));

    expect(access.canEdit).toBe(true);
    await expect(other.api.createIssue('Refused')).rejects.toThrow('copy a fresh credential');
    expect(other.api.hasWriteAccess()).toBe(false);
    expect(other.api.accessState().storageRejected).toBe(true);
    expect((server.signed as { operations: unknown[] }).operations.length).toBe(1);
  });

  it('refuses a credential whose key ID does not match its public key', async () => {
    const server = fakeSkrynia();
    const owner = session(server);
    const initialized = await owner.initialize();
    const other = session(server);
    const forged = {
      ...initialized.credential,
      keyId: `ed25519:${'A'.repeat(43)}`,
    };

    await expect(other.enableEditing(JSON.stringify(forged))).rejects.toThrow('key ID does not match its public key');
    expect(other.hasCredential()).toBe(false);
  });

  it('stays read-only when a stored credential names a live authority but holds another key', async () => {
    const { server, storage } = await initializedBoard();
    await session(server, storage).api.createIssue('Visible');
    const other = await generateSigningKey();
    storage.set('antonina:board-v2:credential', JSON.stringify({
      ...storedCredential(storage),
      publicKey: other.publicKey,
      privateKey: other.privateKey,
    }));

    const reopened = session(server, storage);
    await expect(reopened.readState()).resolves.toMatchObject({ board: { issues: [{ title: 'Visible' }] } });
    expect(reopened.api.hasWriteAccess()).toBe(false);
    expect(reopened.api.getEffectiveCapabilities()).toEqual([]);
    await expect(reopened.api.createIssue('Impostor')).rejects.toThrow('key ID does not match its public key');
    expect((server.signed as { operations: unknown[] }).operations.length).toBe(2);
    expect(reopened.api.accessState().keyId).toBeNull();
  });

  it('reports a rejected stored credential after a read that still succeeds', async () => {
    const { server, storage } = await initializedBoard();
    await session(server, storage).api.createIssue('Visible');
    const foreign = await generateSigningKey();
    storage.set('antonina:board-v2:credential', JSON.stringify({
      ...storedCredential(storage),
      privateKey: foreign.privateKey,
    }));

    const reopened = session(server, storage);
    await expect(reopened.readState()).resolves.toMatchObject({ board: { issues: [{ title: 'Visible' }] } });

    const access = reopened.api.accessState();
    expect(reopened.hasCredential()).toBe(true);
    expect(access.credentialRejection).toBe('unverified');
    expect(access.keyId).toBeNull();
    expect(access.canEdit).toBe(false);
    expect(reopened.api.hasWriteAccess()).toBe(false);
    expect((server.signed as { operations: unknown[] }).operations.length).toBe(2);
  });

  it('remembers the accepted head so a replaced history is refused after a reload', async () => {
    const server = fakeSkrynia();
    const storage = memoryStorage();
    const owner = session(server, storage);
    await owner.initialize();
    await owner.api.createIssue('Kept');

    const reopened = session(server, storage);
    await expect(reopened.readState()).resolves.toMatchObject({ board: { issues: [{ title: 'Kept' }] } });

    const log = server.signed as { head: string; operations: Array<{ opId: string }> };
    server.signed = { ...log, head: log.operations[0].opId, operations: log.operations.slice(0, 1) };
    await expect(reopened.readState()).rejects.toThrow('previously accepted head');
  });

  it('ignores unreadable stored keys instead of failing the whole page load', () => {
    const storage = memoryStorage();
    storage.set('antonina:board-v2:credential', '{oops');
    storage.set('antonina:board-v2:trust', '{oops');

    const client = createBrowserBoardApi(storage);

    expect(client.hasCredential()).toBe(false);
    expect(client.api.getTrustAnchor()).toBeNull();
  });
});

describe('the shared priority queue through the session', () => {
  async function boardWithThreeIssues() {
    const server = fakeSkrynia();
    const storage = memoryStorage();
    const owner = session(server, storage);
    const initialized = await owner.initialize();
    await owner.api.createIssue('First');
    await owner.api.createIssue('Second');
    await owner.api.createIssue('Third');
    return { server, storage, owner, initialized };
  }

  it('reads the board and its queue in one pass', async () => {
    const { server, storage } = await boardWithThreeIssues();
    const reader = session(server, storage);

    const state = await reader.readState();

    expect(state?.board.issues.map((issue) => issue.number)).toEqual([1, 2, 3]);
    expect(state?.queue).toEqual([1, 2, 3]);
  });

  it('seeds the queue oldest-issue first at initialization', async () => {
    const { server, storage } = await boardWithThreeIssues();
    await session(server, storage).api.reorderQueue([3, 1, 2]);
    await session(server, storage).api.createIssue('Fourth');

    expect((await session(server, storage).readState())?.queue).toEqual([3, 1, 2, 4]);
  });

  it('commits a reorder and shows the same order to a second client that only reads', async () => {
    const { server, storage, initialized } = await boardWithThreeIssues();
    const writer = session(server, storage);

    const committed = await writer.api.reorderQueue([2, 3, 1]);

    expect(committed).toEqual([2, 3, 1]);
    const reader = session(server);
    await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));
    expect((await reader.readState())?.queue).toEqual([2, 3, 1]);
    expect(await reader.api.getQueue()).toEqual([2, 3, 1]);
  });

  it('leaves the stored board untouched when a reorder is refused', async () => {
    const { server, storage } = await boardWithThreeIssues();
    const before = server.signed;

    await expect(session(server, storage).api.reorderQueue([1, 2])).rejects.toThrow('every open issue exactly once');
    expect(server.signed).toBe(before);
    expect((await session(server, storage).api.getQueue())).toEqual([1, 2, 3]);
  });

  it('never lets a read-only credential reorder the shared queue', async () => {
    const { server, initialized } = await boardWithThreeIssues();
    const reader = session(server);
    await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));

    expect(reader.api.hasWriteAccess()).toBe(false);
    await expect(reader.api.reorderQueue([3, 2, 1])).rejects.toThrow('credential is required');
    expect((server.signed as { operations: unknown[] }).operations.length).toBe(4);
  });

  it('keeps a newly opened issue in the queue a client re-reads after a close', async () => {
    const { server, storage } = await boardWithThreeIssues();
    const client = session(server, storage);
    await client.api.close(2);
    expect((await client.readState())?.queue).toEqual([1, 3]);
    await client.api.reopen(2);
    expect((await client.readState())?.queue).toEqual([1, 3, 2]);
  });
});

describe('the board feed through the session', () => {
  /** A board with one of every event the projection reports, in commit order. */
  async function boardWithActivity() {
    const server = fakeSkrynia();
    const storage = memoryStorage();
    const owner = session(server, storage);
    await owner.initialize();
    await owner.api.createIssue('First', 'the first body');
    await owner.api.comment(1, 'Lubko', 'on it');
    await owner.api.createIssue('Second');
    await owner.api.close(2);
    await owner.api.reopen(2);
    await owner.api.editIssueBody(1, 'an edited body');
    return { server, storage, writer: session(server, storage) };
  }

  it('projects the signed log itself, newest first, with each operation as its own entry', async () => {
    const { server, writer } = await boardWithActivity();
    const log = server.signed as { operations: Array<{ opId: string; timestamp: string; kind: string }> };

    const page = await writer.readFeed();
    // The entries are the log's own operations, in reverse commit order, each
    // carrying that operation's instant. A view-derived list could not do this:
    // the board view holds one `updatedAt` per issue, so it can say an issue
    // exists but not that a comment, a closure and a reopen were three separate
    // recorded events at three separate instants.
    expect(page.entries.map((entry) => entry.id)).toEqual([...log.operations].filter((operation) => operation.kind !== 'board.initialize').reverse().map((operation) => operation.opId));
    expect(page.entries.map((entry) => entry.kind)).toEqual([
      'issue-edited', 'issue-reopened', 'issue-closed', 'issue-created', 'comment-added', 'issue-created',
    ]);
    expect(page.entries[0].at).toBe(log.operations[log.operations.length - 1].timestamp);
    // Log positions are unique, so the order is total even when two operations
    // share a millisecond: no entry can share a position, and the walk is
    // strictly decreasing.
    const positions = page.entries.map((entry) => entry.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([...positions].sort((left, right) => right - left));
    expect(page.total).toBe(6);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps a close, a reopen and an edit apart, and does not infer one from an updatedAt', async () => {
    const { server, writer } = await boardWithActivity();
    const log = server.signed as { operations: Array<{ kind: string }> };

    expect(log.operations.filter((operation) => operation.kind === 'issue.close' || operation.kind === 'issue.reopen')
      .map((operation) => operation.kind)).toEqual(['issue.close', 'issue.reopen']);

    const page = await writer.readFeed();
    const forIssueTwo = page.entries.filter((entry) => entry.issueNumber === 2 && (entry.kind === 'issue-closed' || entry.kind === 'issue-reopened'));

    // Two entries, two different kinds, two different instants — and the state
    // each left behind, which is how a reader can tell a reopened issue from a
    // closed one without consulting the board view at all.
    expect(forIssueTwo.map((entry) => [entry.kind, entry.state])).toEqual([
      ['issue-reopened', 'open'],
      ['issue-closed', 'closed'],
    ]);
    // This board's clock is frozen, so both operations share an instant and the
    // log position is the only thing that orders them. That is the case the
    // projection is built for: two distinct entries, ordered by the log, and
    // never merged into one "last changed" line.
    expect(forIssueTwo.map((entry) => entry.at)).toEqual([STAMP, STAMP]);
    expect(forIssueTwo[0].position).toBeGreaterThan(forIssueTwo[1].position);
  });

  it('reads the newest 50 entries by default and hands back the token for the rest', async () => {
    const server = fakeSkrynia();
    const owner = session(server);
    await owner.initialize();
    for (let index = 1; index <= 55; index += 1) await owner.api.createIssue(`Issue ${index}`);

    const page = await owner.readFeed();

    expect(page.limit).toBe(50);
    expect(page.entries).toHaveLength(50);
    expect(page.total).toBe(55);
    expect(page.nextCursor).not.toBeNull();
    // The 50 kept are the 50 newest, and the top of the page is the last
    // operation the log committed.
    expect(page.entries[0].title).toBe('Issue 55');
    expect(page.entries[49].title).toBe('Issue 6');
  });

  it('walks the whole feed through the backend cursor without skipping or repeating an entry', async () => {
    const server = fakeSkrynia();
    const owner = session(server);
    await owner.initialize();
    for (let index = 1; index <= 12; index += 1) await owner.api.createIssue(`Issue ${index}`);

    const reader = owner;
    const first = await reader.readFeed({ limit: 5 });
    const second = await reader.readFeed({ limit: 5, cursor: first.nextCursor });
    const third = await reader.readFeed({ limit: 5, cursor: second.nextCursor });
    const whole = await reader.readFeed();

    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([5, 5, 2]);
    expect([...first.entries, ...second.entries, ...third.entries].map((entry) => entry.id))
      .toEqual(whole.entries.map((entry) => entry.id));
    // The continuation token names a position, not an offset, so every page
    // starts strictly earlier than the one before it and the walk ends exactly
    // where the single-page read ends.
    expect(third.nextCursor).toBeNull();
    expect([...first.entries, ...second.entries, ...third.entries]).toHaveLength(whole.total);
  });

  it('refuses a cursor it did not issue instead of silently paging from the top', async () => {
    const { writer } = await boardWithActivity();

    await expect(writer.readFeed({ cursor: 'v1.not-base64' })).rejects.toThrow('cursor is malformed');
    await expect(writer.readFeed({ cursor: 'v9.eyJhdCI6IiJ9' })).rejects.toThrow('cursor is malformed');
    await expect(writer.readFeed({ limit: 0 })).rejects.toThrow('limit must be a positive integer');
  });

  it('hands the tab a read that still has its session once the view has detached it', async () => {
    // The feed tab receives the session's read as a bare function prop and calls
    // it on its own, so `owner.readFeed` below is the exact value the view
    // holds: no receiver, nothing to fall back on. Every other read in this
    // file is called as a method, which is why a read that lost its session
    // passed the whole suite and threw only in the app.
    const server = fakeSkrynia();
    const owner = session(server);
    await owner.initialize();
    for (let index = 1; index <= 55; index += 1) await owner.api.createIssue(`Issue ${index}`);

    const detached: FeedRead = owner.readFeed;
    const first = await readFeedFirstPage(detached);
    const second = await appendFeedPage(detached, first, first.nextCursor!);

    expect(first.limit).toBe(DEFAULT_FEED_LIMIT);
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    // The walk still reaches the whole log through the same detached read, and
    // the newest entry is still the top of the page.
    expect(second.entries).toHaveLength(55);
    expect(second.nextCursor).toBeNull();
    expect(first.entries[0].title).toBe('Issue 55');
  });

  it('keeps its read off the prototype, so it cannot be handed over unbound', () => {
    // The cheap structural half of the same guard: a read on the prototype is
    // exactly the shape that detaches to nothing, so its absence here is what
    // makes the test above a property of the class rather than of one fixture.
    expect((BrowserBoardSession.prototype as { readFeed?: unknown }).readFeed).toBeUndefined();
  });

  it('reads the feed without a credential and without writing anything', async () => {
    const server = fakeSkrynia();
    const storage = memoryStorage();
    const owner = session(server, storage);
    const initialized = await owner.initialize();
    await owner.api.createIssue('Readable');
    const before = server.signed;
    const methods: Array<string | undefined> = [];
    const reader = new BrowserBoardSession(memoryStorage(), {
      fetch: async (input, init) => { methods.push(init?.method); return server.fetch(String(input), init); },
      now: () => new Date(STAMP),
    });
    await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));

    const page = await reader.readFeed();

    expect(page.entries.map((entry) => entry.kind)).toEqual(['issue-created']);
    expect(reader.hasCredential()).toBe(false);
    expect(server.signed).toBe(before);
    expect(methods.every((method) => method === undefined)).toBe(true);
  });
});
