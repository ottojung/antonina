import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-closed-order-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-closed-order-config';

import App from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue } from './model';
import type { BoardOverview, IssueCommentPage, IssueListSummary } from '../../packages/core/src/api';
import type { BoardAccessState } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';
import { ISSUE_PAGE_NEXT, ISSUE_PAGE_SIZE, ISSUE_PAGE_PREVIOUS, issuePage, visibleIssues } from './ui-state';

const STAMP = '2026-09-27T12:00:00.000Z';

/**
 * A minute-resolution stamp `minutes` after the fixture's own base, so a closing
 * time can be stated as an offset and be read as the time it is.
 */
function closedMinutesAgo(minutes: number): string {
  return new Date(Date.parse(STAMP) - minutes * 60_000).toISOString();
}

/**
 * A closed issue summary whose closing time and issue number are deliberately
 * non-monotonic: `number` counts down while `closedAt` counts up, so no sort by
 * either one alone can produce the board's order.
 */
function closedSummary(number: number, minutesAgo: number): IssueListSummary {
  const closedAt = closedMinutesAgo(minutesAgo);
  return {
    number,
    title: `Issue ${number}`,
    state: 'closed',
    createdAt: STAMP,
    // The issue was last touched well after it was closed -- a reopen/edit that
    // never reopened it, or a label change -- so `updatedAt` is deliberately not
    // the closing time and any sort that reaches for it is wrong here.
    //
    // The shift is keyed to the issue number, not to the closing time, so it is
    // NOT a constant offset of `closedAt`. A constant offset would leave
    // `updatedAt` order identical to `closedAt` order in every row of every
    // fixture below, and then the whole file would pass with a comparator that
    // sorted closed issues by last update instead of by closing time. Keying the
    // shift to the number makes the two orders disagree row by row.
    updatedAt: closedMinutesAgo(minutesAgo - 500 - ((number * 37) % 400)),
    closedAt,
    messageCount: 0,
    hasBody: false,
  };
}

/**
 * `count` closed issues whose issue numbers ascend while their closing times are
 * permuted against them, so neither ascending nor descending issue number
 * reproduces the closing order and a fixture that only shuffled the arrival
 * order could not pass on it.
 *
 * `17` is coprime with the counts used here, so the permutation is total: every
 * closing time is distinct, and no tie-break is doing the work.
 */
function nonMonotonicClosed(count: number): IssueListSummary[] {
  const first = 500 - count;
  return Array.from({ length: count }, (_, index) => {
    const rank = (index * 17) % count;
    return closedSummary(first + index + 1, (rank + 1) * 7);
  });
}

/** The issue closed most recently, and the one closed least recently. */
function newestAndOldest(summaries: readonly IssueListSummary[]): { newest: number; oldest: number } {
  const times = summaries.map((each) => Date.parse(each.closedAt!));
  return {
    newest: summaries[times.indexOf(Math.max(...times))]!.number,
    oldest: summaries[times.indexOf(Math.min(...times))]!.number,
  };
}

let board: BoardIssue[] = [];
let summaries: IssueListSummary[] = [];
let reads = 0;

function boardIssueFor(summary: IssueListSummary): BoardIssue {
  return {
    number: summary.number,
    title: summary.title,
    body: '',
    state: summary.state,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messages: [],
  };
}

/**
 * The stub's overview, which is what the Closed view is ordered from. The
 * summaries arrive in fixture order, i.e. in descending issue number, so a list
 * that simply trusted the arrival order would draw the exact reverse of the
 * order the board defines.
 */
function overview(): BoardOverview {
  reads += 1;
  return {
    boardId: 'board-1',
    head: 'op-' + reads,
    revision: 1,
    deleted: false,
    queue: [],
    issues: summaries,
    resources: [],
    targets: [],
    dispatches: [],
  };
}

const session = {
  api: {
    accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit: true }),
    getIssueCommentPage: async (number: number, page: number): Promise<IssueCommentPage> => {
      const found = board.find((each) => each.number === number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return {
        schemaVersion: 2,
        boardId: 'board-1',
        issue: { ...found, messages: [] },
        page,
        pageCount: 1,
        total: found.messages.length,
        messages: found.messages,
      };
    },
    getIssue: async (number: number): Promise<BoardIssue> => {
      const found = board.find((each) => each.number === number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return found;
    },
    createIssue: async (): Promise<BoardIssue> => { throw new Error('not used here'); },
    comment: async () => null,
    editIssueBody: async () => null,
    close: async () => null,
    reopen: async () => null,
    reorderQueue: vi.fn(async (target: number[]) => target),
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

async function mountClosedView(): Promise<HTMLElement> {
  const { container } = render(<App />);
  // The filter control only exists once the board read has resolved, so it is
  // waited for rather than clicked optimistically: clicking a control that is
  // not there yet is a race, not a failure of the order under test.
  const closedFilter = await screen.findByRole('button', { name: /^Closed/ });
  await waitFor(() => expect(session.readOverview).toHaveBeenCalled());
  fireEvent.click(closedFilter);
  await waitFor(() => expect(container.querySelectorAll('.issue-row').length).toBeGreaterThan(0));
  return container;
}

function drawnRows(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.issue-row')).map((row) => Number(row.getAttribute('data-issue')));
}

async function goNext(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ISSUE_PAGE_NEXT })); });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  board = [];
  summaries = [];
  reads = 0;
  session.readOverview.mockClear();
  session.hasCredential.mockReturnValue(true);
});

afterEach(cleanup);

describe('closed issue ordering by closing time', () => {
  it('orders closed issues by closing timestamp, most recent first, not by issue number', () => {
    const summaries = [
      closedSummary(4, 10),
      closedSummary(17, 20),
      closedSummary(2, 30),
      closedSummary(9, 5),
    ];
    const queue: number[] = [];

    expect(visibleIssues(summaries, queue, 'closed').map((each) => each.number)).toEqual([9, 4, 17, 2]);
  });

  it('reads the closing time from closedAt rather than from the last update', () => {
    // Issue 8 closed most recently and has not been touched since; issue 3 was
    // closed long ago but edited just now. The two keys disagree on these two
    // rows: by `closedAt` the order is 8, 3; by `updatedAt` it would be 3, 8.
    // Sorting by `updatedAt` therefore yields the exact reverse of what is
    // asserted below, which is what makes this test able to fail at all. The rows
    // are also supplied oldest-first, so a call site that simply trusted the
    // arrival order would draw 3, 8 rather than 8, 3.
    const summaries = [
      { ...closedSummary(3, 90), updatedAt: closedMinutesAgo(2) },
      { ...closedSummary(8, 1), updatedAt: closedMinutesAgo(900) },
    ];

    expect(visibleIssues(summaries, [], 'closed').map((each) => each.number)).toEqual([8, 3]);
  });

  it('breaks a closing-time tie by issue number, most recent first', () => {
    const at = closedMinutesAgo(15);
    const summaries = [closedSummary(3, 15), closedSummary(11, 15), closedSummary(7, 15)];
    for (const each of summaries) expect(each.closedAt).toBe(at);

    expect(visibleIssues(summaries, [], 'closed').map((each) => each.number)).toEqual([11, 7, 3]);
  });

  it('is the comparator core orders the materialized closed pages with', () => {
    // This order used to be computed by sorting the fixture with
    // `compareClosedIssues` -- the function under test -- and comparing the
    // result against `visibleIssues`, which calls that same comparator. Expected
    // and actual then came from one implementation, so the assertion held for
    // every comparator, correct or reversed. The fixture is spelled out here and
    // the order is written down beside it instead, so the claim is a fact about
    // these rows rather than a restatement of the sort.
    //
    // Read the order off the `closedAt` column: newest first, and the two rows
    // closed at 11:00 tie, so the higher issue number comes first. The list is
    // non-monotonic in both columns -- descending issue number would give
    // 23,17,12,9,4 and ascending would give 4,9,12,17,23 -- so neither can pass.
    const summaries = [
      { ...closedSummary(17, 60), closedAt: '2026-09-27T11:00:00.000Z' },
      { ...closedSummary(4, 150), closedAt: '2026-09-27T09:30:00.000Z' },
      { ...closedSummary(23, 75), closedAt: '2026-09-27T10:45:00.000Z' },
      { ...closedSummary(9, 0), closedAt: '2026-09-27T12:00:00.000Z' },
      { ...closedSummary(12, 60), closedAt: '2026-09-27T11:00:00.000Z' },
    ];
    const EXPECTED_ORDER = [9, 17, 12, 23, 4];

    expect(visibleIssues(summaries, [], 'closed').map((each) => each.number)).toEqual(EXPECTED_ORDER);
    // And it is neither of the two orders a plain issue-number sort would give.
    expect(EXPECTED_ORDER).not.toEqual([4, 9, 12, 17, 23]);
    expect(EXPECTED_ORDER).not.toEqual([23, 17, 12, 9, 4]);
  });

  it('is not the creation order the rows happen to carry', () => {
    // `createdAt` is the same `STAMP` in every fixture so far, which meant a
    // comparator that keyed on creation time instead of closing time would have
    // passed all of them. Here the two orders are exact reverses of each other:
    // reading the rows newest-created first gives 4, 11, 7, while reading them
    // newest-closed first gives 7, 11, 4. Three rows, so the closing order is
    // non-monotonic in issue number too -- descending number gives 11, 7, 4 and
    // ascending gives 4, 7, 11 -- and no single column of this fixture yields
    // the asserted order but `closedAt`.
    const summaries = [
      { ...closedSummary(7, 5), createdAt: '2018-01-01T00:00:00.000Z' },
      { ...closedSummary(4, 100), createdAt: '2026-09-01T00:00:00.000Z' },
      { ...closedSummary(11, 50), createdAt: '2021-01-01T00:00:00.000Z' },
    ];

    expect(visibleIssues(summaries, [], 'closed').map((each) => each.number)).toEqual([7, 11, 4]);
  });

  it('shows a closed filter nothing but closed issues', () => {
    // The state filter inside `closedIssueOrder` is what keeps open work out of
    // the Closed view, and it was untested: every other case in this file feeds
    // `visibleIssues` a list that is already entirely closed, so an
    // implementation that dropped `issue.state === 'closed'` and sorted the
    // whole board passed all of them -- and the whole web suite.
    //
    // The open rows here are given a `closedAt` of `null`, so a filter-less
    // implementation resolves them through core's comparator to their
    // `updatedAt`, which `closedSummary` places far older than any closure in the
    // fixture. They would therefore land at the *end* of the list rather than
    // interleaved, which is why the assertion checks membership by number and
    // not just the order of the first few rows.
    const open: IssueListSummary[] = [
      { ...closedSummary(1, 4000), state: 'open', closedAt: null },
      { ...closedSummary(2, 3000), state: 'open', closedAt: null },
    ];
    const closed = nonMonotonicClosed(6);
    const drawn = visibleIssues([...open, ...closed], [1, 2], 'closed').map((each) => each.number);

    // Expected order is read off the fixture's own `closedAt` column, not back
    // off `visibleIssues`, so the assertion is a fact about these six rows rather
    // than a restatement of the sort under test.
    const expected = closed
      .map((each) => ({ number: each.number, at: Date.parse(each.closedAt!) }))
      .sort((left, right) => right.at - left.at || right.number - left.number)
      .map((each) => each.number);

    expect(drawn).toEqual(expected);
    expect(drawn).toHaveLength(closed.length);
    for (const number of drawn) expect(number).not.toBe(1);
    for (const number of drawn) expect(number).not.toBe(2);
  });

  it('leaves open-issue ordering exactly as the shared queue has it', () => {
    const open: IssueListSummary[] = [
      { ...closedSummary(1, 999), state: 'open', closedAt: null },
      { ...closedSummary(2, 998), state: 'open', closedAt: null },
      { ...closedSummary(3, 997), state: 'open', closedAt: null },
    ];
    const closed = nonMonotonicClosed(4);
    const all = [...open, ...closed];

    expect(visibleIssues(all, [3, 1, 2], 'open').map((each) => each.number)).toEqual([3, 1, 2]);
    expect(visibleIssues(all, [3, 1, 2], 'all').map((each) => each.number).slice(0, 3)).toEqual([3, 1, 2]);
  });
});

describe('closed issue ordering across page boundaries', () => {
  it('keeps one global closing-time order across pages, not an order per page', () => {
    // 60 closed issues so the list spans two pages, with the closing times and
    // the issue numbers non-monotonic across the whole board and across the
    // boundary: issue 450 closed most recently and belongs on page 1, while
    // issue 441 -- a higher number -- closed least recently and belongs last.
    const summaries = nonMonotonicClosed(60);
    const every = visibleIssues(summaries, [], 'closed');

    expect(every).toHaveLength(60);
    expect(issuePage(every, 1)).toHaveLength(ISSUE_PAGE_SIZE);
    expect(issuePage(every, 2)).toHaveLength(10);

    // No page-order expectation here is derived from `visibleIssues`: the two
    // assertions that once compared the pages against `every.map(...)` read their
    // expectation back off the function under test, so they held for any ordering
    // at all, including no ordering. Everything below is anchored on
    // `newestAndOldest`, which is computed from the fixture's own `closedAt`.

    // The boundary is the point: the newest closure and the oldest sit on
    // different pages, and a list that sorted each page on its own would have
    // page 2 beginning with a closure newer than something on page 1.
    const { newest, oldest } = newestAndOldest(summaries);
    expect(issuePage(every, 1)[0]!.number).toBe(newest);
    expect(issuePage(every, 2).at(-1)!.number).toBe(oldest);
    // A non-default page size is still a slice of the same global order: on a grid
    // of 25, every closure drawn on the second page is older than every closure
    // drawn on the first. The expectation comes from the fixture's own `closedAt`
    // values, so a reversed comparator -- which would swap the two pages -- fails
    // here.
    const quarter = issuePage(every, 2, 25).map((each) => each.closedAt!);
    expect(quarter).toHaveLength(25);
    expect(Math.min(...quarter.map(Date.parse))).toBeLessThan(
      Math.min(...issuePage(every, 1, 25).map((each) => Date.parse(each.closedAt!))),
    );
    // The newest closure is not the highest issue number, so this fixture cannot
    // pass on any issue-number sort at all.
    expect(newest).not.toBe(Math.max(...summaries.map((each) => each.number)));
    expect(issuePage(every, 1).map((each) => each.number)).toContain(newest);
    expect(issuePage(every, 1).map((each) => each.number)).not.toContain(oldest);
    expect(issuePage(every, 2).map((each) => each.number)).toContain(oldest);
    expect(issuePage(every, 2).map((each) => each.number)).not.toContain(newest);
    // Each page is descending in closing time on its own terms too.
    for (const page of [1, 2]) {
      const times = issuePage(every, page).map((each) => each.closedAt!);
      expect(times).toEqual([...times].sort().reverse());
    }
  });
});

describe('the Closed view draws that order', () => {
  it('shows the most recently closed issue first and pages the rest of the global order', async () => {
    summaries = nonMonotonicClosed(60);
    board = summaries.map(boardIssueFor);

    const container = await mountClosedView();

    // Written out rather than read back off `visibleIssues`: this test used to
    // derive its expectation from the function under test, so it stayed green
    // under both a reversed core comparator and a call site that did not sort at
    // all. These are the 60 issue numbers of the fixture in the order its
    // `closedAt` values demand -- `nonMonotonicClosed(60)` issues number
    // `441 + index` a closing time of `7 * (((index * 17) mod 60) + 1)` minutes
    // before the stamp, so the closing order is by ascending rank, i.e. by
    // ascending `(number - 441) * 17 mod 60`.
    const EXPECTED_ORDER = [441, 494, 487, 480, 473, 466, 459, 452, 445, 498, 491, 484, 477, 470, 463, 456, 449, 442, 495, 488, 481, 474, 467, 460, 453, 446, 499, 492, 485, 478, 471, 464, 457, 450, 443, 496, 489, 482, 475, 468, 461, 454, 447, 500, 493, 486, 479, 472, 465, 458, 451, 444, 497, 490, 483, 476, 469, 462, 455, 448];
    // Self-checking against the fixture: the two ends of the literal must be the
    // fixture's own most and least recent closures, computed from its `closedAt`
    // and not from the list being checked. (Comparing the literal to itself would
    // assert nothing.)
    const { newest, oldest } = newestAndOldest(summaries);
    expect(EXPECTED_ORDER[0]).toBe(newest);
    expect(EXPECTED_ORDER.at(-1)).toBe(oldest);
    expect(EXPECTED_ORDER).toHaveLength(summaries.length);

    expect(drawnRows(container)).toEqual(EXPECTED_ORDER.slice(0, ISSUE_PAGE_SIZE));

    await goNext();
    expect(drawnRows(container)).toEqual(EXPECTED_ORDER.slice(ISSUE_PAGE_SIZE));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: ISSUE_PAGE_PREVIOUS })); });
    expect(drawnRows(container)).toEqual(EXPECTED_ORDER.slice(0, ISSUE_PAGE_SIZE));
  });

  it('is not the ascending-issue-number order the view used to draw', async () => {
    summaries = nonMonotonicClosed(60);
    board = summaries.map(boardIssueFor);

    const container = await mountClosedView();
    const drawn = drawnRows(container);

    expect(drawn).not.toEqual([...drawn].sort((left, right) => left - right));
    expect(drawn[0]).toBe(newestAndOldest(summaries).newest);
    expect(drawn.at(-1)).not.toBe(Math.min(...drawn));
  });
});