import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-feed-pagination-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-feed-pagination-config';

import App from './App';
import {
  DEFAULT_FEED_LIMIT,
  type BoardFeedEntry,
  type BoardFeedEntryKind,
  type BoardFeedPage,
  type BoardFeedRequest,
} from './api';
import type { BoardIssue } from './model';
import type { BoardAccessState, BoardOverview } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';
import {
  BOARD_URL_KEYS,
  boardUrlKeys,
  DEFAULT_FEED_PAGE,
  parseBoardUrl,
} from './board-url';
import {
  clampFeedPage,
  FEED_PAGE_SIZE,
  FEED_PAGES_LABEL,
  feedPageCount,
  feedPageRange,
  hasFeedPages,
  ISSUE_PAGE_NEXT,
  ISSUE_PAGE_PREVIOUS,
  readFeedPage,
} from './ui-state';

/**
 * Board issue 173, mounted: the feed's numbered pagination.
 *
 * `feed-view.test.tsx` mounts the container and pins the read cadence and the
 * one-page-in-the-DOM property. `feed-tab.test.tsx` renders the presentational
 * half through static markup. Neither can see the address bar, and the address
 * bar is half of what this issue asks for: the feed's page has to be a URL a
 * reader can reload, share and press Back through. So this file mounts the real
 * shell against a fake feed log and drives the real address bar, exactly as
 * `board-url-app.test.tsx` drives the issues list's page.
 */
const STAMP = '2026-09-27T12:00:00.000Z';

const SECRET = 'antonina-board-credential-root-1-do-not-share';

const allIssues = new Map<number, BoardIssue>();

/** Every feed read the fake board has been asked for, in order. */
let feedRequests: BoardFeedRequest[] = [];

/** How many entries the fake log holds. A number the tests move to choose a shape. */
let feedTotal = 0;

const session = {
  api: {
    accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit: false }),
    getIssue: async (number: number): Promise<BoardIssue> => {
      const found = allIssues.get(number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return found;
    },
    getIssueCommentPage: async () => {
      throw new Error('this file never opens a conversation');
    },
  },
  readOverview: vi.fn<() => Promise<BoardOverview | null>>(),
  hasCredential: vi.fn(() => true),
  readFeed: vi.fn<(request?: BoardFeedRequest) => Promise<BoardFeedPage>>(),
  trust: vi.fn(),
  initialize: vi.fn(),
  enableEditing: vi.fn(),
  clearCredential: vi.fn(),
  credentialText: vi.fn(() => SECRET),
  trustAnchorText: vi.fn(() => null),
};

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, createBrowserBoardApi: () => session as unknown as BrowserBoardSession };
});

function issue(number: number, state: 'open' | 'closed' = 'open'): BoardIssue {
  return { number, title: `Issue ${number}`, body: '', state, createdAt: STAMP, updatedAt: STAMP, messages: [] };
}

function overview(issues: BoardIssue[]): BoardOverview {
  allIssues.clear();
  for (const each of issues) allIssues.set(each.number, each);
  return {
    boardId: 'board-1',
    head: 'op-1',
    revision: 1,
    deleted: false,
    queue: issues.filter((each) => each.state === 'open').map((each) => each.number),
    issues: issues.map((each) => ({ number: each.number, title: each.title, state: each.state, createdAt: STAMP, updatedAt: STAMP, closedAt: each.state === 'closed' ? STAMP : null, messageCount: 0, hasBody: false })),
    resources: [],
    targets: [],
    dispatches: [],
  };
}

/**
 * One entry of the fake log.
 *
 * Its id is its POSITION, not a counter: a counter would hand the same log
 * different ids on every read, so a reload of the same page would draw rows the
 * test could not compare to the rows it had already seen. A position is also
 * what the real projection's cursor names, so the fake and the real thing agree.
 */
function entry(kind: BoardFeedEntryKind, issueNumber: number, position: number): BoardFeedEntry {
  return { id: `op-${position}`, kind, at: STAMP, position, issueNumber, title: `Issue ${issueNumber}`, state: 'open', messageId: null, author: null, body: null };
}

/**
 * The whole fake log, as a real cursor page would answer it: `total` is the log,
 * and the entries handed back are the ones after the cursor, newest first, up to
 * the requested limit, with a token while entries remain behind them.
 */
function serveFeed(request: BoardFeedRequest = {}): BoardFeedPage {
  feedRequests.push(request);
  const limit = request.limit ?? DEFAULT_FEED_LIMIT;
  const ordered = Array.from({ length: feedTotal }, (_, index) => entry('issue-created', feedTotal - index, feedTotal - index));
  const position = request.cursor === undefined || request.cursor === null ? null : Number(String(request.cursor).replace('v1.', ''));
  const remaining = position === null ? ordered : ordered.filter((each) => each.position < position);
  const entries = remaining.slice(0, limit);
  const last = entries[entries.length - 1];
  return { entries, nextCursor: remaining.length > entries.length && last !== undefined ? `v1.${last.position}` : null, total: ordered.length, limit };
}

async function mount(): Promise<HTMLElement> {
  const { container } = render(<App />);
  expect(container.isConnected).toBe(true);
  await waitFor(() => expect(session.readOverview).toHaveBeenCalled());
  return container;
}

async function openAt(url: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', url);
  return mount();
}

/** A reload of the current URL: the document goes away and a fresh `App` mounts. */
async function reload(): Promise<HTMLElement> {
  cleanup();
  return mount();
}

async function pressHistory(direction: 'back' | 'forward'): Promise<void> {
  const before = window.location.href;
  window.history[direction]();
  await waitFor(() => expect(window.location.href).not.toBe(before));
}

async function clickTab(name: string): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}

/** The feed page the address bar currently names. */
function feedPageInUrl(): number {
  return parseBoardUrl(window.location.search).feedPage;
}

/** The ids of the feed entries the document is actually drawing, in order. */
function drawnFeedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-feed-id]')).map((row) => row.getAttribute('data-feed-id') ?? '');
}

/** The feed's pagination control, or null when the log is one page. */
function feedNav(container: HTMLElement | Document): HTMLElement | null {
  return container.querySelector(`nav[aria-label="${FEED_PAGES_LABEL}"]`);
}

/** The range line inside the feed's pagination control. */
function feedRange(container: HTMLElement): string {
  return feedNav(container)?.querySelector('[role="status"]')?.textContent ?? '';
}

beforeEach(() => {
  window.localStorage.clear();
  allIssues.clear();
  feedRequests = [];
  feedTotal = 0;
  window.history.replaceState(null, '', '/board');
  session.readOverview.mockReset();
  session.readFeed.mockReset();
  session.readFeed.mockImplementation(async (request?: BoardFeedRequest) => serveFeed(request));
  session.readOverview.mockResolvedValue(overview([issue(1), issue(2), issue(3)]));
});

afterEach(cleanup);

describe('the feed page helpers', () => {
  it('is the projection own page size, and the same number every numbered page uses', () => {
    // One default rather than two that can drift: the browser's page, the
    // projection's page and `antonina board feed`'s page are one page.
    expect(FEED_PAGE_SIZE).toBe(DEFAULT_FEED_LIMIT);
    expect(FEED_PAGE_SIZE).toBe(50);
  });

  it('counts, clamps and ranges exactly as the issues list does', () => {
    expect(feedPageCount(120)).toBe(3);
    expect(feedPageCount(120, 50)).toBe(3);
    // An empty log is one page, not a division by zero.
    expect(feedPageCount(0)).toBe(1);
    // Clamping only ever moves a page down, and never to below 1.
    expect(clampFeedPage(4, 120)).toBe(3);
    expect(clampFeedPage(0, 120)).toBe(1);
    expect(clampFeedPage(-3, 120)).toBe(1);
    expect(clampFeedPage(2.5, 120)).toBe(1);
    // The range is about the log, and the last page says it is short.
    expect(feedPageRange(120, 1)).toBe('1–50 of 120');
    expect(feedPageRange(120, 3)).toBe('101–120 of 120');
    expect(hasFeedPages(50)).toBe(false);
    expect(hasFeedPages(51)).toBe(true);
  });

  it('reaches a numbered page through the cursor and keeps only that page', async () => {
    feedTotal = 120;
    const seen: BoardFeedRequest[] = [];
    const read = async (request: BoardFeedRequest = {}) => { seen.push(request); return serveFeed(request); };

    const page3 = await readFeedPage(read, 3);

    // Three requests: the newest page for the total, then two cursor steps. This
    // is the cursor API's cost and is reported as a `packages/core` concern for
    // board 174; the entries held are still one page.
    expect(seen).toEqual([
      { limit: DEFAULT_FEED_LIMIT },
      { limit: DEFAULT_FEED_LIMIT, cursor: 'v1.71' },
      { limit: DEFAULT_FEED_LIMIT, cursor: 'v1.21' },
    ]);
    expect(page3.entries).toHaveLength(20);
    expect(page3.total).toBe(120);
  });
});

describe('the feed page in the address bar', () => {
  it('carries one allowlisted key, and a value that is not a page number is not one', () => {
    // The state is still the allowlisted set, so nothing outside it can ride
    // along in the address bar, and the credential check still holds.
    expect(BOARD_URL_KEYS).toContain('entries');
    expect(boardUrlKeys('?view=feed&entries=3&credential=abc')).toEqual(['credential']);

    expect(parseBoardUrl('?view=feed&entries=3').feedPage).toBe(3);
    expect(DEFAULT_FEED_PAGE).toBe(1);
    // Every degraded form lands on the first page rather than on a blank tab.
    for (const stale of ['', '?entries=0', '?entries=-1', '?entries=2.5', '?entries=abc', '?entries=+2', '?entries=%202']) {
      expect(parseBoardUrl(stale).feedPage).toBe(DEFAULT_FEED_PAGE);
    }
  });

  it('is independent of the issues-list page and of the conversation page', () => {
    // Three screens, three numbers. Paging the feed must not renumber the list a
    // reader came back to, and one shared number would do exactly that.
    const state = parseBoardUrl('?page=4&thread=7&entries=3');
    expect([state.page, state.commentPage, state.feedPage]).toEqual([4, 7, 3]);
  });
});

describe('the feed tab, mounted, paging by number', () => {
  it('opens page 1 with Previous dead and Next live, and names the range', async () => {
    feedTotal = 120;
    const container = await openAt('/board?view=feed');

    await waitFor(() => expect(drawnFeedIds(container)).toHaveLength(50));
    const nav = feedNav(container)!;
    expect(nav).not.toBeNull();
    const [previous, next] = within(nav).getAllByRole('button');
    expect(previous.getAttribute('aria-label')).toBe(ISSUE_PAGE_PREVIOUS);
    expect(next.getAttribute('aria-label')).toBe(ISSUE_PAGE_NEXT);
    expect(previous.hasAttribute('disabled')).toBe(true);
    expect(next.hasAttribute('disabled')).toBe(false);
    expect(feedRange(container)).toBe('1–50 of 120');
    expect(container.querySelector('.feed-count')?.textContent).toBe('50 of 120 recorded entries');
    // The accumulator is gone from the document, not merely unused.
    expect(container.querySelector('.feed-more')).toBeNull();
  });

  it('gives a one-page log no controls at all', async () => {
    feedTotal = 12;
    const container = await openAt('/board?view=feed');

    await waitFor(() => expect(drawnFeedIds(container)).toHaveLength(12));
    expect(feedNav(container)).toBeNull();
    expect(container.textContent).not.toContain(FEED_PAGES_LABEL);
  });

  it('writes the page it moved to into the address, and reads exactly that page', async () => {
    feedTotal = 120;
    const container = await openAt('/board?view=feed');
    await waitFor(() => expect(drawnFeedIds(container)).toHaveLength(50));
    const firstPage = drawnFeedIds(container);
    feedRequests = [];

    await act(async () => { fireEvent.click(within(feedNav(container)!).getAllByRole('button')[1]!); });

    await waitFor(() => expect(feedPageInUrl()).toBe(2));
    expect(window.location.search).toContain('entries=2');
    await waitFor(() => expect(feedRange(container)).toBe('51–100 of 120'));
    // Still 50 rows, and they are page 2's alone: every id page 1 drew is gone
    // from the document rather than sitting above it, which is the assertion the
    // old append-everything view could not have passed.
    expect(drawnFeedIds(container)).toHaveLength(50);
    for (const gone of firstPage) expect(drawnFeedIds(container)).not.toContain(gone);
    expect(session.readFeed).toHaveBeenLastCalledWith({ limit: DEFAULT_FEED_LIMIT, cursor: 'v1.71' });
  });

  it('lands on the same page from a copied link, and survives a reload', async () => {
    feedTotal = 120;
    const container = await openAt('/board?view=feed&entries=3');

    await waitFor(() => expect(drawnFeedIds(container)).toHaveLength(20));
    expect(feedRange(container)).toBe('101–120 of 120');
    const drawn = drawnFeedIds(container);

    const reloaded = await reload();

    await waitFor(() => expect(drawnFeedIds(reloaded)).toHaveLength(20));
    expect(drawnFeedIds(reloaded)).toEqual(drawn);
    expect(feedRange(reloaded)).toBe('101–120 of 120');
    // The last page has no Next, so the boundary is right at the end too.
    expect(within(feedNav(reloaded)!).getAllByRole('button')[1]!.hasAttribute('disabled')).toBe(true);
  });

  it('lands on the last real page when the link names one the log cannot fill', async () => {
    feedTotal = 120;
    const container = await openAt('/board?view=feed&entries=99');

    await waitFor(() => expect(feedRange(container)).toBe('101–120 of 120'));
    expect(drawnFeedIds(container)).toHaveLength(20);
    // Clamped, not blanked and not walked to: the walk stops at the page the
    // log actually has.
    expect(feedRequests.length).toBeLessThan(4);
  });

  it('goes back and forward through the pages it visited, one entry each', async () => {
    feedTotal = 200;
    const container = await openAt('/board?view=feed');
    await waitFor(() => expect(feedRange(container)).toBe('1–50 of 200'));

    const next = () => within(feedNav(container)!).getAllByRole('button')[1]!;
    await act(async () => { fireEvent.click(next()); });
    await waitFor(() => expect(feedRange(container)).toBe('51–100 of 200'));
    await act(async () => { fireEvent.click(next()); });
    await waitFor(() => expect(feedRange(container)).toBe('101–150 of 200'));
    await act(async () => { fireEvent.click(next()); });
    await waitFor(() => expect(feedRange(container)).toBe('151–200 of 200'));

    // Back to page 3, and the document holds page 3 alone — never the three
    // pages a reader has already been through.
    await pressHistory('back');
    await waitFor(() => expect(feedRange(container)).toBe('101–150 of 200'));
    expect(drawnFeedIds(container)).toHaveLength(50);

    await pressHistory('back');
    await waitFor(() => expect(feedRange(container)).toBe('51–100 of 200'));
    expect(drawnFeedIds(container)).toHaveLength(50);

    await pressHistory('forward');
    await waitFor(() => expect(feedRange(container)).toBe('101–150 of 200'));
    expect(drawnFeedIds(container)).toHaveLength(50);
  });

  it('starts the feed at page 1 when the tab is opened, whatever page it held', async () => {
    feedTotal = 200;
    const container = await openAt('/board?view=feed&entries=3');
    await waitFor(() => expect(feedRange(container)).toBe('101–150 of 200'));

    await clickTab('issues');
    await clickTab('feed');

    await waitFor(() => expect(feedRange(container)).toBe('1–50 of 200'));
    expect(parseBoardUrl(window.location.search).feedPage).toBe(DEFAULT_FEED_PAGE);
  });

  it('leaves the issues-list page alone while the feed is paged', async () => {
    // Independence is asserted on the address, because that is where it has to
    // hold: a URL that names both screens' pages has to be able to carry both
    // numbers at once, and the feed moving its own must not rewrite the list's.
    session.readOverview.mockResolvedValue(overview(Array.from({ length: 120 }, (_, index) => issue(index + 1))));
    feedTotal = 200;
    const container = await openAt('/board?view=feed&entries=2&page=3');

    await waitFor(() => expect(feedRange(container)).toBe('51–100 of 200'));
    const state = parseBoardUrl(window.location.search);
    expect([state.feedPage, state.page]).toEqual([2, 3]);

    await act(async () => { fireEvent.click(within(feedNav(container)!).getAllByRole('button')[1]!); });

    await waitFor(() => expect(feedPageInUrl()).toBe(3));
    // The list's page is exactly where it was, and the list itself is untouched
    // by every feed read that happened in between.
    expect(parseBoardUrl(window.location.search).page).toBe(3);
    expect(feedRange(container)).toBe('101–150 of 200');
  });

  it('puts no credential in the feed URL, on a browser that holds one', async () => {
    feedTotal = 120;
    await openAt('/board?view=feed');
    await waitFor(() => expect(feedNav(document.body)).not.toBeNull());
    await act(async () => { fireEvent.click(within(feedNav(document.body)!).getAllByRole('button')[1]!); });
    await waitFor(() => expect(feedPageInUrl()).toBe(2));

    expect(window.location.href).not.toContain(SECRET);
    expect(boardUrlKeys(window.location.search)).toEqual([]);
  });
});
