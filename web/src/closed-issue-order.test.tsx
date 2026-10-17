import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-closed-order-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-closed-order-config';

import App from './App';
import { DEFAULT_FEED_LIMIT, compareClosedIssues, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue } from './model';
import type { BoardOverview, IssueCommentPage, IssueListSummary } from '../../packages/core/src/api';
import type { BoardAccessState } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';
import { issueLastActivityOf } from '../../packages/core/src/api';
import { ISSUE_PAGE_NEXT, ISSUE_PAGE_SIZE, ISSUE_PAGE_PREVIOUS, issuePage, visibleIssues } from './ui-state';

const STAMP = '2026-09-27T12:00:00.000Z';

/** A minute-resolution stamp `minutes` before the fixture's base. */
function minutesAgo(minutes: number): string {
  return new Date(Date.parse(STAMP) - minutes * 60_000).toISOString();
}

/**
 * A closed issue summary whose three clocks are deliberately uncorrelated:
 * `number`, the closing time (`closedAt`) and the last activity time (carried on
 * `updatedAt`, because a description edit moves it) each get their own
 * permutation, so an order keyed on any one of them cannot be the order keyed on
 * another. `lastActivityAt` is null, so the activity time is the edit time and
 * not a comment -- comments are covered in `issue-activity-order.test.tsx`.
 */
function closedSummary(
  number: number,
  activityMinutesAgo: number,
  closedMinutesAgo: number,
  createdMinutesAgo = 5000,
): IssueListSummary {
  return {
    number,
    title: `Issue ${number}`,
    state: 'closed',
    createdAt: minutesAgo(createdMinutesAgo),
    updatedAt: minutesAgo(activityMinutesAgo),
    lastActivityAt: null,
    closedAt: minutesAgo(closedMinutesAgo),
    messageCount: 0,
    hasBody: false,
  };
}

/**
 * `count` closed issues whose issue numbers ascend while their activity times and
 * their closing times are permuted against the numbers and against each other.
 *
 * `17` and `13` are both coprime with every count used here, so each permutation
 * is total (no ties are doing the work) and, because they differ, the activity
 * order and the closing order disagree row by row. A comparator that still keyed
 * on `closedAt` would therefore draw a different list.
 */
function nonMonotonicClosed(count: number): IssueListSummary[] {
  const first = 500 - count;
  return Array.from({ length: count }, (_, index) => closedSummary(
    first + index + 1,
    ((index * 17) % count + 1) * 7,
    ((index * 13) % count + 1) * 11,
  ));
}

/**
 * The order the fixture's own activity column demands, computed with `Date.parse`
 * and an explicit higher-number tie-break rather than through the comparator under
 * test, so the expectation is a fact about these rows and not a restatement of
 * `visibleIssues`.
 */
function expectedActivityOrder(summaries: readonly IssueListSummary[]): number[] {
  return [...summaries]
    .sort((left, right) =>
      Date.parse(issueLastActivityOf(right)) - Date.parse(issueLastActivityOf(left)) || right.number - left.number)
    .map((each) => each.number);
}

function activityMinutes(summary: IssueListSummary): number {
  return (Date.parse(STAMP) - Date.parse(issueLastActivityOf(summary))) / 60_000;
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
 * summaries arrive in fixture order, i.e. in ascending issue number, so a list
 * that simply trusted the arrival order would draw the exact reverse of an
 * activity order that happens to descend with the number.
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

describe('closed issue ordering by last activity', () => {
  it('orders closed issues by last activity, most recent first, not by issue number or closing time', () => {
    // Read the order off the `activity` column: newest first. The list is
    // supplied in ascending number order and the closing times are a third
    // permutation, so neither a number sort nor a closing-time sort can produce
    // it, and a list that trusted arrival order cannot either.
    const rows = [
      closedSummary(4, 10, 60),
      closedSummary(17, 20, 5),
      closedSummary(2, 30, 40),
      closedSummary(9, 5, 90),
    ];
    const EXPECTED = [9, 4, 17, 2];

    expect(visibleIssues(rows, [], 'closed').map((each) => each.number)).toEqual(EXPECTED);
    // Non-vacuity: the expected order is neither the ascending number order nor
    // the descending closing-time order these same rows carry.
    expect(EXPECTED).not.toEqual([2, 4, 9, 17]);
    expect(EXPECTED).not.toEqual([...rows].sort(compareClosedIssues).map((each) => each.number));
  });

  it('ignores the closing time when it disagrees with the last activity', () => {
    // Issue 3 was closed most recently but edited long ago; issue 8 was closed
    // long ago but edited just now. By `closedAt` the order is 3, 8; by activity
    // it is 8, 3. This is the exact reverse, which is what makes the assertion
    // able to fail against the old closing-time comparator.
    const rows = [
      closedSummary(3, 90, 1),
      closedSummary(8, 2, 900),
    ];

    expect(visibleIssues(rows, [], 'closed').map((each) => each.number)).toEqual([8, 3]);
    expect([...rows].sort(compareClosedIssues).map((each) => each.number)).toEqual([3, 8]);
  });

  it('breaks an activity tie by issue number, most recent first', () => {
    const rows = [closedSummary(3, 15, 1), closedSummary(11, 15, 2), closedSummary(7, 15, 3)];
    for (const each of rows) expect(issueLastActivityOf(each)).toBe(minutesAgo(15));

    expect(visibleIssues(rows, [], 'closed').map((each) => each.number)).toEqual([11, 7, 3]);
  });

  it('ranks a newly commented old closed issue above a more recently closed but quiet one', () => {
    // Acceptance criterion: a comment on an old issue moves it to the top of
    // Closed. Issue 1 was closed 200 minutes ago but commented 1 minute ago;
    // issue 2 was closed 1 minute ago and has been quiet since. Closing time
    // would put 2 first; the comment puts 1 first.
    const rows: IssueListSummary[] = [
      { ...closedSummary(1, 4000, 200), updatedAt: minutesAgo(4000), lastActivityAt: minutesAgo(1), messageCount: 1 },
      closedSummary(2, 3, 1),
    ];

    expect(visibleIssues(rows, [], 'closed').map((each) => each.number)).toEqual([1, 2]);
  });

  it('ranks an old closed issue edited just now by the edit', () => {
    // The description-edit half of the activity key: a closed issue whose only
    // recent change is an edit of its description moves above one closed later
    // but untouched since.
    const rows = [
      closedSummary(1, 2, 300),
      closedSummary(2, 1, 1),
    ];

    expect(visibleIssues(rows, [], 'closed').map((each) => each.number)).toEqual([2, 1]);
    // Flip only the edit time and the order follows it, which is what makes this
    // about the edit rather than about the closing time.
    const edited = [{ ...rows[0]!, updatedAt: minutesAgo(0.5) }, rows[1]!];
    expect(visibleIssues(edited, [], 'closed').map((each) => each.number)).toEqual([1, 2]);
  });

  it('shows a closed filter nothing but closed issues', () => {
    const open: IssueListSummary[] = [
      { ...closedSummary(1, 0, 4000), state: 'open', closedAt: null },
      { ...closedSummary(2, 0, 4000), state: 'open', closedAt: null },
    ];
    const closed = nonMonotonicClosed(6);
    const drawn = visibleIssues([...open, ...closed], [1, 2], 'closed').map((each) => each.number);

    expect(drawn).toEqual(expectedActivityOrder(closed));
    expect(drawn).toHaveLength(closed.length);
    for (const number of drawn) expect(number).not.toBe(1);
    for (const number of drawn) expect(number).not.toBe(2);
  });

  it('leaves open-issue ordering exactly as the shared queue has it', () => {
    const open: IssueListSummary[] = [
      { ...closedSummary(1, 999, 4000), state: 'open', closedAt: null },
      { ...closedSummary(2, 998, 4000), state: 'open', closedAt: null },
      { ...closedSummary(3, 997, 4000), state: 'open', closedAt: null },
    ];
    const closed = nonMonotonicClosed(4);
    const all = [...open, ...closed];

    // The `open` filter is the shared queue, untouched, even though every one of
    // these issues carries an activity time that would order them differently.
    expect(visibleIssues(all, [3, 1, 2], 'open').map((each) => each.number)).toEqual([3, 1, 2]);
  });
});

describe('closed issue ordering across page boundaries', () => {
  it('keeps one global activity order across pages, not an order per page', () => {
    // 60 closed issues so the list spans two pages, with the activity times and
    // the issue numbers non-monotonic across the whole board and across the
    // boundary.
    const rows = nonMonotonicClosed(60);
    const every = visibleIssues(rows, [], 'closed');
    const expected = expectedActivityOrder(rows);

    expect(every).toHaveLength(60);
    expect(issuePage(every, 1)).toHaveLength(ISSUE_PAGE_SIZE);
    expect(issuePage(every, 2)).toHaveLength(10);

    // No page-order expectation is read back off `visibleIssues`: the global
    // order is the fixture's own activity column, and the pages are slices of it.
    expect(every.map((each) => each.number)).toEqual(expected);
    expect(issuePage(every, 1).map((each) => each.number)).toEqual(expected.slice(0, ISSUE_PAGE_SIZE));
    expect(issuePage(every, 2).map((each) => each.number)).toEqual(expected.slice(ISSUE_PAGE_SIZE));

    // The boundary is the point: the newest activity and the oldest sit on
    // different pages, and a list that sorted each page on its own would have
    // page 2 beginning with an activity newer than something on page 1.
    const newest = expected[0]!;
    const oldest = expected.at(-1)!;
    expect(issuePage(every, 1).map((each) => each.number)).toContain(newest);
    expect(issuePage(every, 2).map((each) => each.number)).toContain(oldest);
    expect(issuePage(every, 1).map((each) => each.number)).not.toContain(oldest);
    expect(issuePage(every, 2).map((each) => each.number)).not.toContain(newest);

    // Each page is descending in activity on its own terms too.
    for (const page of [1, 2]) {
      const times = issuePage(every, page).map((each) => activityMinutes(each));
      expect(times).toEqual([...times].sort((left, right) => left - right));
    }

    // Non-vacuity: the activity order is neither the number order nor the
    // closing-time order the same rows carry.
    expect(expected).not.toEqual([...rows].sort((left, right) => left.number - right.number).map((each) => each.number));
    expect(expected).not.toEqual([...rows].sort(compareClosedIssues).map((each) => each.number));
  });
});

describe('the Closed view draws that order', () => {
  it('shows the most recently active issue first and pages the rest of the global order', async () => {
    summaries = nonMonotonicClosed(60);
    board = summaries.map(boardIssueFor);
    const expected = expectedActivityOrder(summaries);

    const container = await mountClosedView();

    expect(drawnRows(container)).toEqual(expected.slice(0, ISSUE_PAGE_SIZE));

    await goNext();
    expect(drawnRows(container)).toEqual(expected.slice(ISSUE_PAGE_SIZE));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: ISSUE_PAGE_PREVIOUS })); });
    expect(drawnRows(container)).toEqual(expected.slice(0, ISSUE_PAGE_SIZE));
  });

  it('is neither the ascending-number order nor the closing-time order', async () => {
    summaries = nonMonotonicClosed(60);
    board = summaries.map(boardIssueFor);

    const container = await mountClosedView();
    const drawn = drawnRows(container);

    expect(drawn).not.toEqual([...drawn].sort((left, right) => left - right));
    expect(drawn).not.toEqual([...summaries].sort(compareClosedIssues).map((each) => each.number).slice(0, ISSUE_PAGE_SIZE));
    expect(drawn[0]).toBe(expectedActivityOrder(summaries)[0]);
  });
});
