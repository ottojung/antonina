import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '../../packages/core/src/canonical';
import {
  BrowserBoardSession,
  BoardTrustRequiredError,
  createBrowserBoardApi,
  serializeBoardCredential,
  serializeBoardTrustAnchor,
  type BoardCredential,
  type BoardKeyStorage,
} from './api';

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
  it('reports a missing board on a plain page load without creating it', async () => {
    const server = fakeSkrynia();
    const methods: Array<string | undefined> = [];
    const client = new BrowserBoardSession(memoryStorage(), {
      fetch: async (input, init) => {
        methods.push(init?.method);
        return server.fetch(String(input), init);
      },
    });

    await expect(client.read()).resolves.toBeNull();
    expect(methods).not.toContain('POST');
    expect(server.signed).toBeNull();
  });

  it('creates the board and its keys in this browser only on explicit initialization', async () => {
    const storage = memoryStorage();
    const before = await initializedBoard(storage);
    const reader = session(before.server, storage);

    expect(reader.credentialText()).toBe(serializeBoardCredential(before.initialized.credential));
    expect(reader.trustAnchorText()).toBe(serializeBoardTrustAnchor(before.initialized.trustAnchor));
    expect(storage.get('antonina:board-v2:accepted-head')).toBe(before.initialized.head);
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

    await expect(reader.read()).rejects.toBeInstanceOf(BoardTrustRequiredError);
    const board = await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));
    expect(board.issues).toEqual([]);
  });

  it('reads a board through a trust anchor alone, and stays read-only', async () => {
    const server = fakeSkrynia();
    const owner = session(server);
    const initialized = await owner.initialize();
    await owner.api.createIssue('Visible', 'signed board');

    const reader = session(server);
    const board = await reader.trust(serializeBoardTrustAnchor(initialized.trustAnchor));

    expect(board.issues[0]).toMatchObject({ number: 1, title: 'Visible', createdAt: STAMP });
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

    await reopened.read();
    await reopened.read();
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
    const { server, storage, initialized } = await initializedBoard();
    await session(server, storage).api.createIssue('Visible');
    const other = await generateSigningKey();
    storage.set('antonina:board-v2:credential', JSON.stringify({
      ...storedCredential(storage),
      publicKey: other.publicKey,
      privateKey: other.privateKey,
    }));

    const reopened = session(server, storage);
    await expect(reopened.read()).resolves.toMatchObject({ issues: [{ title: 'Visible' }] });
    expect(reopened.api.hasWriteAccess()).toBe(false);
    expect(reopened.api.getEffectiveCapabilities()).toEqual([]);
    await expect(reopened.api.createIssue('Impostor')).rejects.toThrow('key ID does not match its public key');
    expect((server.signed as { operations: unknown[] }).operations.length).toBe(2);
    expect(initialized.credential.keyId).toBe(storedCredential(storage).keyId);
  });

  it('remembers the accepted head so a replaced history is refused after a reload', async () => {
    const server = fakeSkrynia();
    const storage = memoryStorage();
    const owner = session(server, storage);
    await owner.initialize();
    await owner.api.createIssue('Kept');

    const reopened = session(server, storage);
    await expect(reopened.read()).resolves.toMatchObject({ issues: [{ title: 'Kept' }] });

    const log = server.signed as { head: string; operations: Array<{ opId: string }> };
    server.signed = { ...log, head: log.operations[0].opId, operations: log.operations.slice(0, 1) };
    await expect(reopened.read()).rejects.toThrow('previously accepted head');
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
