import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardApi, type CapabilityStorage } from './api';
import { emptyBoard, parseBoard, type Board, type BoardIssue } from './model';

const CAPABILITY = 'a'.repeat(64);
const URL = '/_skrynia/store/antonina/board-v1';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200, etag?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: etag === undefined ? {} : { ETag: etag },
  });
}

function issue(number = 1, overrides: Partial<BoardIssue> = {}): BoardIssue {
  const timestamp = '2026-09-24T00:00:00.000Z';
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    ...overrides,
  };
}

function board(issues: BoardIssue[] = [], nextIssueNumber = issues.length + 1): Board {
  return { ...emptyBoard(), issues, nextIssueNumber };
}

function api(fetcher: ReturnType<typeof vi.fn>, overrides = {}): BoardApi {
  return new BoardApi({
    fetch: fetcher,
    capability: CAPABILITY,
    maxAttempts: 4,
    now: () => new Date('2026-09-24T01:00:00.000Z'),
    newId: () => 'message-1',
    ...overrides,
  });
}

function storage(): CapabilityStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

describe('BoardApi', () => {
  it('calls the default fetch with the global receiver', async () => {
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response(board(), 200, '"one"'));
    });
    vi.stubGlobal('fetch', receiverSensitiveFetch);

    await expect(new BoardApi().loadBoard()).resolves.toEqual(board());
    expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
  });

  it('rejects a missing ETag instead of writing unconditionally', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(board([issue()]), 200))
      .mockResolvedValueOnce(response(board([issue()])));

    await expect(api(fetcher).createIssue('Next')).rejects.toThrow('returned no ETag');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('exposes capability access without exposing a default DOM value', () => {
    const persisted = storage();
    const client = new BoardApi({ capabilityStorage: persisted });

    expect(client.hasWriteAccess()).toBe(false);
    expect(client.getCapability()).toBeNull();
    client.setCapability(`  ${CAPABILITY}  `);
    expect(client.hasWriteAccess()).toBe(true);
    expect(client.getCapability()).toBe(CAPABILITY);
    expect(persisted.get('antonina:skrynia:capability:board-v1')).toBe(CAPABILITY);
    client.clearCapability();
    expect(client.hasWriteAccess()).toBe(false);
    expect(persisted.get('antonina:skrynia:capability:board-v1')).toBeNull();
    expect(() => client.setCapability('   ')).toThrow('capability is required');
    expect(() => client.setCapability('not-a-capability')).toThrow('64 hexadecimal characters');
  });

  it('requires a capability for every mutation', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(board([issue()]), 200, '"one"'));
    const client = api(fetcher, { capability: null });

    await expect(client.createIssue('Next')).rejects.toThrow('write capability is required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('creates a capability-write board and persists its capability', async () => {
    const persisted = storage();
    const created = emptyBoard();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: 'not_found' }, 404))
      .mockResolvedValueOnce(response({ ok: true, mode: 'capability-write', capability: CAPABILITY }, 201))
      .mockResolvedValueOnce(response(created, 200, '"created"'));

    await expect(new BoardApi({ fetch: fetcher, capability: null, capabilityStorage: persisted }).ensureBoard()).resolves.toEqual(created);
    expect(fetcher.mock.calls[1][1].headers['X-Skrynia-Mode']).toBe('capability-write');
    expect(persisted.get('antonina:skrynia:capability:board-v1')).toBe(CAPABILITY);
  });

  it('loads the winner and remains read-only when creation races without a capability', async () => {
    const winner = board([issue()]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: 'not_found' }, 404))
      .mockResolvedValueOnce(response({ error: 'already_exists' }, 409))
      .mockResolvedValueOnce(response(winner, 200, '"winner"'));
    const client = new BoardApi({ fetch: fetcher });

    await expect(client.ensureBoard()).resolves.toEqual(winner);
    await expect(client.createIssue('Blocked')).rejects.toThrow('write capability is required');
  });

  it('uses conditional PUT and succeeds on the current ETag', async () => {
    const original = board([issue()]);
    const created = issue(2, { title: 'Second', createdAt: '2026-09-24T01:00:00.000Z' });
    const updated = board([issue(), created], 3);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(original, 200, '"one"'))
      .mockResolvedValueOnce(response({ ok: true }, 200))
      .mockResolvedValueOnce(response(updated, 200, '"two"'));

    await expect(api(fetcher).createIssue('Second')).resolves.toMatchObject({ number: 2, title: 'Second' });
    const put = fetcher.mock.calls[1];
    expect(put[0]).toBe(URL);
    expect(put[1]).toMatchObject({ method: 'PUT', headers: { 'If-Match': '"one"', 'X-Skrynia-Capability': CAPABILITY } });
  });

  it('re-reads and reapplies a create after 412, preserving messages and allocating once', async () => {
    const observed = board([issue(1, { messages: [{ id: 'existing', author: 'human', body: 'keep me', createdAt: '2026-09-24T00:00:00.000Z' }] })]);
    const concurrent = board([issue(1, { messages: [{ id: 'existing', author: 'human', body: 'keep me', createdAt: '2026-09-24T00:00:00.000Z' }] }), issue(2)], 3);
    const final = board([...concurrent.issues, issue(3, { createdAt: '2026-09-24T01:00:00.000Z' })], 4);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(observed, 200, '"one"'))
      .mockResolvedValueOnce(response({ error: 'etag_mismatch' }, 412))
      .mockResolvedValueOnce(response(concurrent, 200, '"two"'))
      .mockResolvedValueOnce(response({ ok: true }, 200))
      .mockResolvedValueOnce(response(final, 200, '"three"'));

    const result = await api(fetcher).createIssue('Retried');
    expect(result.number).toBe(3);
    expect(fetcher.mock.calls[1][1].body).toContain('"number":2');
    expect(fetcher.mock.calls[3][1].body).toContain('"number":3');
    expect(fetcher.mock.calls[3][1].body).toContain('keep me');
  });

  it('merges a comment after 412 with a later winner timestamp under caller clock skew', async () => {
    const originalMessage = { id: 'original', author: 'human', body: 'first', createdAt: '2026-09-24T00:00:00.000Z' };
    const winnerMessage = { id: 'winner', author: 'agent-a', body: 'concurrent', createdAt: '2026-09-24T02:00:00.000Z' };
    const original = board([issue(1, { messages: [originalMessage] })]);
    const concurrent = board([issue(1, { messages: [originalMessage, winnerMessage], updatedAt: winnerMessage.createdAt })]);
    const newMessage = { id: 'message-1', author: 'human', body: 'mine', createdAt: winnerMessage.createdAt };
    const final = board([issue(1, { messages: [originalMessage, winnerMessage, newMessage], updatedAt: newMessage.createdAt })]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(original, 200, '"one"'))
      .mockResolvedValueOnce(response({ error: 'etag_mismatch' }, 412))
      .mockResolvedValueOnce(response(concurrent, 200, '"two"'))
      .mockResolvedValueOnce(response({ ok: true }, 200))
      .mockResolvedValueOnce(response(final, 200, '"three"'));

    await expect(api(fetcher).comment(1, 'human', 'mine')).resolves.toMatchObject({ messages: [originalMessage, winnerMessage, newMessage] });
    const firstCandidate = parseBoard(JSON.parse(String(fetcher.mock.calls[1][1].body)));
    const retriedCandidate = parseBoard(JSON.parse(String(fetcher.mock.calls[3][1].body)));
    expect(firstCandidate.issues[0].messages.at(-1)?.id).toBe('message-1');
    expect(retriedCandidate.issues[0].messages.map((message) => message.id)).toEqual(['original', 'winner', 'message-1']);
    expect(retriedCandidate.issues[0].updatedAt).toBe(winnerMessage.createdAt);
  });

  it('edits open bodies, rejects closed bodies, and preserves dependencies on status changes', async () => {
    let current = board([issue()]);
    let version = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { current = JSON.parse(String(init.body)) as Board; return response({ ok: true }); }
      version += 1; return response(current, 200, `"${version}"`);
    });
    const client = api(fetcher);
    await expect(client.editIssueBody(1, 'line one\nline two')).resolves.toMatchObject({ body: 'line one\nline two', updatedAt: '2026-09-24T01:00:00.000Z' });
    await client.addResourceDependency('lubko://server', '/protected/path', 1);
    await expect(client.close(1)).resolves.toMatchObject({ state: 'closed' });
    expect(current.resources[0].issueNumbers).toEqual([1]);
    await expect(client.editIssueBody(1, 'blocked')).rejects.toThrow('Closed issue descriptions cannot be edited');
    await expect(client.reopen(1)).resolves.toMatchObject({ state: 'open' });
    expect(current.resources[0].issueNumbers).toEqual([1]);
  });

  it('treats repeated resource dependency registration as idempotent', async () => {
    let current = board([issue(1), issue(2)]);
    let version = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { current = JSON.parse(String(init.body)) as Board; return response({ ok: true }); }
      version += 1;
      return response(current, 200, `"${version}"`);
    });
    const client = api(fetcher);

    const first = await client.addResourceDependency('lubko://server', '/shared', 1);
    const second = await client.addResourceDependency('lubko://server', '/shared', 1);

    expect(second).toEqual(first);
    expect(current.resources).toHaveLength(1);
    expect(current.resources[0].issueNumbers).toEqual([1]);
  });

  it('adds sorted open dependencies and removes the record with the last dependency', async () => {
    let current = board([issue(1), issue(2), issue(3, { state: 'closed' })]);
    let version = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { current = JSON.parse(String(init.body)) as Board; return response({ ok: true }); }
      version += 1; return response(current, 200, `"${version}"`);
    });
    const client = api(fetcher);
    await expect(client.addResourceDependency('lubko://server', '/shared', 2)).resolves.toMatchObject({ issueNumbers: [2] });
    await expect(client.addResourceDependency('lubko://server', '/shared', 1)).resolves.toMatchObject({ issueNumbers: [1, 2] });
    await expect(client.addResourceDependency('lubko://server', '/shared', 3)).rejects.toThrow('requires an open issue');
    await expect(client.addResourceDependency('lubko://server', '/bad/', 1)).rejects.toThrow('normalized POSIX path');
    await client.removeResourceDependency('lubko://server', '/shared', 1);
    expect(current.resources).toHaveLength(1);
    await client.removeResourceDependency('lubko://server', '/shared', 2);
    expect(current.resources).toEqual([]);
  });

  it('closes and reopens with issue-scoped mutations', async () => {
    let current = board([issue()]);
    let version = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        current = JSON.parse(String(init.body)) as Board;
        return response({ ok: true }, 200);
      }
      version += 1;
      return response(current, 200, `"${version}"`);
    });
    const client = api(fetcher);

    await expect(client.close(1)).resolves.toMatchObject({ state: 'closed' });
    await expect(client.reopen(1)).resolves.toMatchObject({ state: 'open' });
  });

  it('rejects malformed and incompatible stored documents', () => {
    expect(() => parseBoard({ schemaVersion: 3, nextIssueNumber: 1, issues: [], resources: [] })).toThrow('incompatible');
    expect(() => parseBoard({ schemaVersion: 2, nextIssueNumber: 1, issues: [{ number: 1 }], resources: [] })).toThrow('incompatible');

    const withAssignee = { ...issue(), assignee: 'agent-a' };
    expect(() => parseBoard(board([withAssignee as BoardIssue], 2))).toThrow('incompatible');

    const withUnknownMessageField = {
      ...issue(),
      messages: [{ id: 'm1', author: 'human', body: 'hello', createdAt: '2026-09-24T00:00:00.000Z', extra: true }],
    };
    expect(() => parseBoard(board([withUnknownMessageField as BoardIssue], 2))).toThrow('incompatible');

    const outOfOrder = board([issue(1, {
      messages: [
        { id: 'later', author: 'human', body: 'later', createdAt: '2026-09-24T00:01:00.000Z' },
        { id: 'earlier', author: 'human', body: 'earlier', createdAt: '2026-09-24T00:00:00.000Z' },
      ],
    })]);
    expect(() => parseBoard(outOfOrder)).toThrow('out of chronological order');
  });
});
