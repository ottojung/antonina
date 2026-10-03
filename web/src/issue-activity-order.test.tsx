// Board issue 180: in the All Issues view, sort by last activity, newest first.
//
// "Last activity" is the timestamp of an issue's most recent comment, or the
// issue's creation time when it has never been commented on. This file pins all
// three parts of that: the key itself, the never-commented fallback (the case a
// `updatedAt` sort gets wrong and the one this board is most likely to regress),
// and that the order is one global order which pagination only slices.
//
// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-activity-order-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-activity-order-config';

import { createHash } from 'node:crypto';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BrowserBoardSession } from './api';
import type { BoardIssue } from './model';
import type { BoardAccessState, BoardOverview, IssueCommentPage, IssueListSummary } from '../../packages/core/src/api';
import { compareIssueActivity, issueLastActivityOf, newestCommentAt } from '../../packages/core/src/api';
import { SignedBoardStore } from '../../packages/core/src/board-store';
import {
  activityIssueOrder,
  closedIssueOrder,
  ISSUE_PAGE_SIZE,
  ISSUE_PAGE_NEXT,
  issuePage,
  openQueueOrder,
  visibleIssues,
} from './ui-state';

const CREATED = '2026-09-27T12:00:00.000Z';

/**
 * A list summary whose only interesting field is when it was last commented on.
 *
 * These are the summaries the web actually receives -- `visibleIssues` sorts what
 * the overview carries, not whole `BoardIssue`s -- so the order tests are written
 * against this shape rather than against an issue, which has no `lastActivityAt`
 * and would silently sort by creation time instead.
 */
function summary(number: number, options: {
  state?: 'open' | 'closed';
  createdAt?: string;
  commentAt?: string | null;
  /** A later `updatedAt` than any comment, standing in for an edit or a close. */
  updatedAt?: string;
} = {}): IssueListSummary {
  const createdAt = options.createdAt ?? CREATED;
  const hasComment = options.commentAt !== undefined && options.commentAt !== null;
  const state = options.state ?? 'open';
  return {
    number,
    title: `Issue ${number}`,
    state,
    createdAt,
    updatedAt: options.updatedAt ?? createdAt,
    closedAt: state === 'closed' ? (options.updatedAt ?? createdAt) : null,
    messageCount: hasComment ? 1 : 0,
    lastActivityAt: hasComment ? options.commentAt! : null,
    hasBody: true,
  };
}

/** The summary the store would hand the web for a board issue. */
function boardIssueOfSummary(entry: BoardIssue): IssueListSummary {
  return {
    number: entry.number,
    title: entry.title,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    closedAt: entry.state === 'closed' ? entry.updatedAt : null,
    messageCount: entry.messages.length,
    lastActivityAt: newestCommentAt(entry.messages),
    hasBody: entry.body.length > 0,
  };
}

/**
 * The board issue behind a summary, for the rendered-view cases. The thread is
 * reconstructed from `lastActivityAt` so the stub and the summary cannot disagree
 * about whether the issue was commented on.
 */
function boardIssueOf(entry: IssueListSummary): BoardIssue {
  return {
    number: entry.number,
    title: entry.title,
    body: 'Body of issue ' + entry.number,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    // `== null` rather than `=== null`: an absent `lastActivityAt` is unknown
    // rather than recorded as "never commented", and this fixture has no thread
    // to reconstruct for either of those.
    messages: entry.lastActivityAt == null
      ? []
      : [{ id: `op-${entry.number}`, author: 'operator', body: `Comment on ${entry.number}`, createdAt: entry.lastActivityAt }],
  };
}

/**
 * n summaries whose issue numbers ascend while their comment activity is permuted
 * against them, so an order keyed on issue number, creation order or closing time
 * cannot reproduce it.
 *
 * `rank = (index * 17) % n`, and 17 is coprime with every n used here, so all n
 * comment times are distinct and no tie-break is ever what makes the assertions
 * pass.
 */
function nonMonotonicByActivity(n: number, state: 'open' | 'closed' = 'open'): IssueListSummary[] {
  return Array.from({ length: n }, (_, index) => summary(index + 1, {
    state,
    // Creation time ascends with the number, so creation order and activity order
    // disagree about every pair.
    createdAt: new Date(Date.parse(CREATED) + index * 60_000).toISOString(),
    commentAt: new Date(Date.parse(CREATED) + ((index * 17) % n) * 60_000).toISOString(),
  }));
}

function numbers(issues: readonly { number: number }[]): number[] {
  return issues.map((entry) => entry.number);
}

// --- the key itself, in core ------------------------------------------------

describe('last activity is the newest comment, or creation time when there is none', () => {
  it('uses the newest comment when the issue has been commented on', () => {
    expect(issueLastActivityOf(summary(1, {
      commentAt: '2026-09-27T18:00:00.000Z',
      createdAt: '2026-09-27T12:00:00.000Z',
    }))).toBe('2026-09-27T18:00:00.000Z');
  });

  it('falls back to creation time when the issue has never been commented on', () => {
    // The easy case to get wrong, so it is asserted directly rather than only
    // through an ordering: a never-commented issue has `lastActivityAt: null`,
    // and the key it contributes is its creation time.
    const untouched = summary(1, { createdAt: '2026-09-27T12:00:00.000Z' });
    expect(untouched.messageCount).toBe(0);
    expect(untouched.lastActivityAt).toBeNull();
    expect(issueLastActivityOf(untouched)).toBe('2026-09-27T12:00:00.000Z');
  });

  it('keys on the newest comment rather than on updatedAt', () => {
    // `updatedAt` moves on a title or body edit and on close, and the issue
    // forbids both as the key. Here updatedAt is far later than every comment,
    // so an updatedAt sort would produce a completely different order.
    const edited = summary(1, {
      createdAt: '2026-09-27T12:00:00.000Z',
      commentAt: '2026-09-27T13:00:00.000Z',
      updatedAt: '2026-09-28T23:00:00.000Z',
    });
    expect(issueLastActivityOf(edited)).toBe('2026-09-27T13:00:00.000Z');
  });

  it('reads the newest comment rather than assuming append order is chronological', () => {
    // Nothing validates that operation timestamps ascend, so "most recent
    // comment" has to mean the newest comment and not the last-appended one.
    const messages = [
      { createdAt: '2026-09-27T18:00:00.000Z' },
      { createdAt: '2026-09-27T13:00:00.000Z' },
    ];
    expect(newestCommentAt(messages)).toBe('2026-09-27T18:00:00.000Z');
    expect(newestCommentAt([])).toBeNull();
  });

  it('treats a summary that never carried the field as never commented', () => {
    // A summary from a shard written before this key existed. It must read as
    // creation time rather than throwing or sorting on undefined.
    const legacy = { number: 1, createdAt: CREATED } as IssueListSummary;
    expect(issueLastActivityOf(legacy)).toBe(CREATED);
  });

  it('breaks an activity tie by higher issue number first', () => {
    const left = summary(1, { createdAt: CREATED });
    const right = summary(2, { createdAt: CREATED });
    expect(compareIssueActivity(left, right)).toBeGreaterThan(0);
    expect(compareIssueActivity(right, left)).toBeLessThan(0);
    expect(compareIssueActivity(left, left)).toBe(0);
  });
});

// --- the order the All Issues view draws ------------------------------------

describe('the All Issues order', () => {
  it('is last activity descending, on issues whose activity disagrees with their numbers', () => {
    const issues = nonMonotonicByActivity(12);
    const ordered = activityIssueOrder(issues);
    const expected = [...issues]
      .sort((left, right) => issueLastActivityOf(right).localeCompare(issueLastActivityOf(left)))
      .map((entry) => entry.number);
    expect(numbers(ordered)).toEqual(expected);
    // Guard against the fixture having degenerated into something issue number
    // would also produce, which would make every ordering assertion above vacuous.
    expect(numbers(ordered)).not.toEqual(numbers(issues));
  });

  it('is the core comparator applied to the whole list', () => {
    const issues = nonMonotonicByActivity(12);
    expect(numbers(activityIssueOrder(issues))).toEqual(
      numbers([...issues].sort((left, right) => compareIssueActivity(left, right))));
  });

  it('places a never-commented issue by its creation time among commented ones', () => {
    // Issue 2 has never been commented on, so its key is its creation time even
    // though the issues around it have comments, and it lands between them.
    const issues = [
      summary(1, { createdAt: '2026-09-27T10:00:00.000Z', commentAt: '2026-09-27T09:00:00.000Z' }),
      summary(2, { createdAt: '2026-09-27T11:00:00.000Z' }),
      summary(3, { createdAt: '2026-09-27T09:00:00.000Z', commentAt: '2026-09-27T12:00:00.000Z' }),
    ];
    expect(numbers(activityIssueOrder(issues))).toEqual([3, 2, 1]);
    // An updatedAt sort would answer 2, 1, 3 instead, because issue 1 was edited
    // more recently than issue 2 was created even though issue 1's last comment
    // is older than issue 2's creation.
    expect(numbers([...issues].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))).toEqual([2, 1, 3]);
  });

  it('ranks an issue whose last comment predates another issue\'s creation by that comment', () => {
    const issues = [
      summary(1, { createdAt: '2026-09-27T12:00:00.000Z' }),
      summary(2, { createdAt: '2026-09-27T08:00:00.000Z', commentAt: '2026-09-27T09:00:00.000Z' }),
    ];
    // Issue 2's creation is four hours earlier, so a creation-order sort puts it
    // last; its comment is three hours before issue 1's creation, so the
    // activity order still puts it last too -- by the comment, not by creation.
    expect(numbers(activityIssueOrder(issues))).toEqual([1, 2]);
  });

  it('interleaves open and closed issues by activity rather than listing one state first', () => {
    const issues = [
      summary(1, { state: 'open', createdAt: '2026-09-27T12:00:00.000Z' }),
      summary(2, { state: 'closed', createdAt: '2026-09-27T08:00:00.000Z', commentAt: '2026-09-27T20:00:00.000Z' }),
      summary(3, { state: 'open', createdAt: '2026-09-27T08:00:00.000Z', commentAt: '2026-09-27T15:00:00.000Z' }),
    ];
    expect(numbers(visibleIssues(issues, [1, 3], 'all'))).toEqual([2, 3, 1]);
  });

  it('does not disturb the open queue order or the closed order', () => {
    // Board issue 19 removed a presentation sort from the open list because a
    // timestamp sort is browser-local priority the shared queue forbids. Board
    // 180's order is All Issues only, and both of these are untouched by it.
    const issues = [summary(1, { commentAt: '2026-09-27T01:00:00.000Z' }), summary(2), summary(3, { state: 'closed' })];
    expect(openQueueOrder(issues, [2, 3, 1])).toEqual([2, 1]);
    expect(numbers(visibleIssues(issues, [2, 1], 'open'))).toEqual([2, 1]);
    expect(numbers(visibleIssues(issues, [2, 1], 'closed'))).toEqual([3]);
    expect(closedIssueOrder(issues)).toEqual([3]);
  });
});

// --- global across pagination ----------------------------------------------

describe('the order is global across pages', () => {
  it('slices one order, so a page boundary lands mid-order rather than restarting it', () => {
    // 60 issues, two pages of 50 at the web page size. The decisive assertion is
    // that the newest activity and the oldest land on different pages: an order
    // applied independently within each page cannot produce that, because every
    // page would then start with its own newest item.
    const issues = nonMonotonicByActivity(60);
    const ordered = activityIssueOrder(issues);
    const page1 = issuePage(ordered, 1);
    const page2 = issuePage(ordered, 2);

    expect(page1).toHaveLength(ISSUE_PAGE_SIZE);
    expect(page2).toHaveLength(10);
    // Pages 1 then 2 reproduce the global order exactly.
    expect(numbers([...page1, ...page2])).toEqual(numbers(ordered));
    // The globally newest activity is first overall and so is on page 1; the
    // globally oldest is last overall and so is on page 2.
    expect(page1).toContain(ordered[0]);
    expect(page1).not.toContain(ordered.at(-1));
    expect(page2).toContain(ordered.at(-1));
    // Each page is itself descending, and the two pages agree at the seam.
    expect(page1.map(issueLastActivityOfOf)).toEqual([...page1.map(issueLastActivityOfOf)].sort().reverse());
    expect(issueLastActivityOfOf(page1.at(-1)!).localeCompare(issueLastActivityOfOf(page2[0]!))).toBeGreaterThanOrEqual(0);
  });

  it('does not restart the order on page 2 when activity ascends with the issue number', () => {
    // The adversarial shape: issue numbers ascend with comment activity, so a
    // per-page sort and a global sort happen to agree on page 1 and disagree from
    // the second page onward.
    const issues = Array.from({ length: 60 }, (_, index) => summary(index + 1, {
      commentAt: new Date(Date.parse(CREATED) + index * 60_000).toISOString(),
    }));
    const ordered = activityIssueOrder(issues);
    // Ascending activity, so the global order is the reverse of the input.
    expect(numbers(ordered)).toEqual(numbers([...issues].reverse()));
    expect(numbers(issuePage(ordered, 1))).toEqual(numbers(ordered).slice(0, ISSUE_PAGE_SIZE));
    expect(numbers(issuePage(ordered, 2))).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  function issueLastActivityOfOf(entry: IssueListSummary): string {
    return issueLastActivityOf(entry);
  }
});

// --- the rendered view ------------------------------------------------------

let board: BoardIssue[] = [];
let reads = 0;

function overview(): BoardOverview {
  reads += 1;
  return {
    boardId: 'board-1',
    head: 'op-' + reads,
    revision: 1,
    deleted: false,
    queue: board.filter((each) => each.state === 'open').map((each) => each.number),
    issues: board.map(boardIssueOfSummary),
    resources: [],
    targets: [],
    dispatches: [],
  };
}

const session = {
  api: {
    accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit: false }),
    getIssueCommentPage: async (number: number, page: number): Promise<IssueCommentPage> => {
      const found = board.find((each) => each.number === number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return { schemaVersion: 2, boardId: 'board-1', issue: { ...found, messages: [] }, page, pageCount: 1, total: found.messages.length, messages: found.messages };
    },
    getIssue: async (number: number): Promise<BoardIssue> => {
      const found = board.find((each) => each.number === number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return found;
    },
    createIssue: async (): Promise<BoardIssue> => { throw new Error('this board is read only'); },
    comment: async () => null,
    editIssueBody: async () => null,
    close: async () => null,
    reopen: async () => null,
    reorderQueue: vi.fn(async () => []),
  },
  readOverview: vi.fn(async () => overview()),
  hasCredential: vi.fn(() => true),
  readFeed: vi.fn<(request?: BoardFeedRequest) => Promise<BoardFeedPage>>(async () => ({ entries: [], nextCursor: null, total: 0, limit: DEFAULT_FEED_LIMIT })),
  trust: vi.fn(),
  initialize: vi.fn(),
  enableEditing: vi.fn(),
  clearCredential: vi.fn(),
  credentialText: vi.fn(() => null),
  trustAnchorText: vi.fn(() => null),
};

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, createBrowserBoardApi: () => session as unknown as BrowserBoardSession };
});

async function mountAllIssues(): Promise<HTMLElement> {
  const { container } = render(<App />);
  await waitFor(() => expect(session.readOverview).toHaveBeenCalled());
  // Await the control rather than clicking optimistically: the shell shows a
  // loading line until the overview resolves, and a click before that lands on
  // nothing.
  fireEvent.click(await screen.findByRole('button', { name: /^All/ }));
  await waitFor(() => expect(container.querySelectorAll('.issue-row').length).toBeGreaterThan(0));
  return container;
}

function drawnRows(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.issue-row')).map((row) => Number(row.getAttribute('data-issue')));
}

beforeEach(() => {
  window.localStorage.clear();
  // Each case starts from the board's own opening URL, so the previous case's
  // page number is never this one's starting page.
  window.history.replaceState(null, '', '/');
  board = [];
  reads = 0;
  session.readOverview.mockClear();
});

afterEach(cleanup);

describe('the drawn All Issues view', () => {
  it('draws the global order across two pages, newest activity first', async () => {
    board = nonMonotonicByActivity(60).map(boardIssueOf);
    const expected = numbers(activityIssueOrder(board.map(boardIssueOfSummary)));
    const container = await mountAllIssues();

    const page1 = drawnRows(container);
    expect(page1).toHaveLength(ISSUE_PAGE_SIZE);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: ISSUE_PAGE_NEXT })); });
    const page2 = drawnRows(container);

    // The two pages together are the whole order, in that order.
    expect([...page1, ...page2]).toEqual(expected);
    // The globally newest activity and the globally oldest are on different
    // pages, which is what makes this a global order rather than two sorts: a
    // within-page sort would start each page at its own newest item.
    expect(page1).toEqual(expected.slice(0, ISSUE_PAGE_SIZE));
    expect(page1).toContain(expected[0]);
    expect(page2).toContain(expected.at(-1));
    expect(page1).not.toContain(expected.at(-1));
  });

  it('draws a never-commented issue by its creation time', async () => {
    board = [
      summary(1, { createdAt: '2026-09-27T12:00:00.000Z', commentAt: '2026-09-27T09:00:00.000Z' }),
      summary(2, { createdAt: '2026-09-27T11:00:00.000Z' }),
      summary(3, { createdAt: '2026-09-27T09:00:00.000Z', commentAt: '2026-09-27T20:00:00.000Z' }),
    ].map(boardIssueOf);
    const container = await mountAllIssues();
    // Issue 2 has no comments at all and is drawn between the two that do.
    expect(drawnRows(container)).toEqual([3, 2, 1]);
  });
});

// --- the field is minted by the store, not by a fixture ---------------------

/**
 * The sections above hand-build `IssueListSummary` values, which is right for
 * testing the order but leaves one thing open -- and it is the thing boards 171
 * and 177 each got wrong: that the field they sort on is one the store actually
 * writes. A test whose fixtures carry `lastActivityAt` by hand passes whether or
 * not the real `readOverview` ever sets it, so a key nothing produces looks
 * identical to a working feature.
 *
 * So this section closes that by execution. It drives a real `ShardedBoardStore`
 * over a fake Skrynia, lets the store itself mint the field, and feeds
 * `readOverview`'s output straight into the same `visibleIssues` the All Issues
 * view calls -- with no hand-built field anywhere in between. It then deletes the
 * field to show the order really does depend on it.
 *
 * The fake Skrynia implements only what this store exercises: conditional GET,
 * capability-minted creation, ETag-checked update and delete. It is a transport
 * double, not a board model, so it makes no claim about Skrynia itself.
 */
function jsonResponse(value: unknown, status: number, etag?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function capabilityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fakeSkrynia() {
  const objects = new Map<string, { value: unknown; mode: string; capabilityHash: string | null; revision: number }>();
  const issued = new Map<string, string>();
  const capability = 'a'.repeat(64);
  let mintCount = 0;

  const keyOf = (url: string) => decodeURIComponent(String(url).split('/').at(-1)!);
  const etag = (entry: { revision: number }) => `"v${entry.revision}"`;

  return {
    capability,
    objects,
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      const method = init.method ?? 'GET';
      const key = keyOf(url);
      const body = init.body === undefined ? null : JSON.parse(String(init.body));
      const current = objects.get(key);
      const headers = new Headers(init.headers);

      if (method === 'GET') {
        return current === undefined
          ? new Response(null, { status: 404 })
          : jsonResponse(current.value, 200, etag(current));
      }

      if (method === 'POST') {
        if (current !== undefined) return new Response(null, { status: 409 });
        const mode = headers.get('X-Skrynia-Mode');
        if (!['capability-write', 'public-write', 'immutable'].includes(mode!)) {
          return jsonResponse({ error: 'mode required' }, 400);
        }
        const minted = capabilityHash(`skrynia-minted:${key}:${++mintCount}`);
        objects.set(key, {
          value: body,
          mode: mode!,
          capabilityHash: mode === 'capability-write' ? capabilityHash(minted) : null,
          revision: 1,
        });
        if (mode === 'capability-write') issued.set(key, minted);
        return jsonResponse(mode === 'capability-write' ? { mode, capability: minted } : { mode }, 201);
      }

      if (current === undefined) return new Response(null, { status: 404 });
      if (current.mode === 'immutable') return jsonResponse({ error: 'immutable' }, 403);
      if (current.capabilityHash !== null
          && capabilityHash(headers.get('X-Skrynia-Capability') ?? '') !== current.capabilityHash) {
        return jsonResponse({ error: 'invalid capability' }, 403);
      }

      if (method === 'PUT') {
        const match = headers.get('If-Match');
        if (match !== null && match !== etag(current)) return jsonResponse({ error: 'etag_mismatch' }, 412);
        current.value = body;
        current.revision += 1;
        return jsonResponse({ ok: true }, 200);
      }

      if (method === 'DELETE') {
        objects.delete(key);
        return jsonResponse({ ok: true }, 200);
      }

      return new Response(null, { status: 405 });
    },
  };
}

describe('the store mints the field the web order consumes', () => {
  const BASE = '2026-09-28T17:00:00.000Z';
  const COMMENTED = '2026-09-28T18:00:00.000Z';

  /**
   * Creation order ascends with the issue number and comment activity does not,
   * so every pair disagrees about which is newer. The most recently active issue
   * is also the lowest-numbered one, which is what makes any order keyed on issue
   * number, creation order or closing time come out backwards rather than merely
   * different.
   */
  function boardWithCommentedOldest() {
    const base = Date.parse(BASE);
    const issues = [5, 4, 3].map((minutesAgo, index) => {
      const createdAt = new Date(base - minutesAgo * 60_000).toISOString();
      return {
        number: index + 1,
        title: `Issue ${index + 1}`,
        body: '',
        state: 'open' as const,
        createdAt,
        updatedAt: createdAt,
        messages: [] as { id: string; author: string; body: string; createdAt: string }[],
      };
    });
    issues[0].messages.push({
      id: `sha256:${'A'.repeat(43)}`,
      author: 'tester',
      body: 'newest comment on the whole board, on the lowest-numbered issue',
      createdAt: COMMENTED,
    });
    return { schemaVersion: 3 as const, nextIssueNumber: 4, issues, resources: [], targets: [], dispatches: [] };
  }

  it('reads back a minted activity time and orders by it, and depends on it', async () => {
    const server = fakeSkrynia();
    let id = 0;
    const store = new SignedBoardStore({
      fetch: server.fetch.bind(server) as unknown as typeof fetch,
      newId: () => `board-180-${(id += 1)}`,
      now: () => new Date(COMMENTED),
    });
    const initialized = await store.initialize(boardWithCommentedOldest());

    const overview = await store.readOverview(initialized.credential);
    expect(overview.issues).toHaveLength(3);

    // 1. The store put the key on the wire. No fixture, no hand-built field.
    expect(overview.issues.filter((entry) => Object.hasOwn(entry, 'lastActivityAt'))).toHaveLength(3);
    const oldest = overview.issues.find((entry) => entry.number === 1)!;
    const newest = overview.issues.find((entry) => entry.number === 3)!;
    expect(oldest.lastActivityAt).toBe(COMMENTED);
    expect(newest.lastActivityAt).toBeNull();

    // 2. It is a real key on the read path, distinct from the numbers around it.
    expect(issueLastActivityOf(oldest)).not.toBe(issueLastActivityOf(newest));

    // 3. THE CONSUMPTION PROOF. readOverview's output goes straight into the
    //    All Issues path, and issue 1 -- the lowest number -- comes first.
    const order = numbers(visibleIssues(overview.issues, overview.queue, 'all'));
    expect(order).toEqual([1, 3, 2]);

    // 4. Negative control on identical data. If deleting the field did not change
    //    the order, step 3 would have passed for reasons unrelated to it.
    const stripped = overview.issues.map(({ lastActivityAt: _dropped, ...rest }) => rest);
    expect(numbers(visibleIssues(stripped, overview.queue, 'all'))).not.toEqual(order);

    // 5. And the comparator the web itself imports agrees with that pipeline.
    expect(numbers([...overview.issues].sort(compareIssueActivity))).toEqual(order);
  });
});
