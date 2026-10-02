import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-pagination-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-pagination-config';

import App, { IssuePagination } from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue } from './model';
import type { BoardOverview } from '../../packages/core/src/api';
import type { BoardAccessState } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';
import {
  clampIssuePage,
  ISSUE_PAGE_SIZE,
  ISSUE_PAGE_NEXT,
  ISSUE_PAGE_PREVIOUS,
  issuePage,
  issuePageCount,
  issuePageRange,
  hasIssuePages,
  visibleIssues,
} from './ui-state';

const STAMP = '2026-09-27T12:00:00.000Z';

function issue(number: number, state: 'open' | 'closed' = 'open'): BoardIssue {
  return { number, title: `Issue ${number}`, body: `Body of issue ${number}`, state, createdAt: STAMP, updatedAt: STAMP, messages: [] };
}

/** A board of `open` open issues numbered 1..open, plus `closed` closed ones after them. */
function boardOf(open: number, closed = 0): BoardIssue[] {
  return [
    ...Array.from({ length: open }, (_, index) => issue(index + 1)),
    ...Array.from({ length: closed }, (_, index) => issue(open + index + 1, 'closed')),
  ];
}

/** The queue this fake board commits: every open issue, in ascending number. */
function queueOf(issues: readonly BoardIssue[]): number[] {
  return issues.filter((each) => each.state === 'open').map((each) => each.number);
}

let board: BoardIssue[] = [];
let reads = 0;
const sentQueues: number[][] = [];

function overview(): BoardOverview {
  reads += 1;
  return {
    boardId: 'board-1',
    // A real board advances its head on every accepted write, and the shell
    // refetches the open thread when it does. A stub that reported one head
    // forever would leave the thread showing a stale state after every close.
    head: 'op-' + reads,
    revision: 1,
    deleted: false,
    queue: queueOf(board),
    issues: board.map((each) => ({
      number: each.number,
      title: each.title,
      state: each.state,
      createdAt: each.createdAt,
      updatedAt: each.updatedAt,
      closedAt: each.state === 'closed' ? each.updatedAt : null,
      messageCount: each.messages.length,
      hasBody: each.body.length > 0,
    })),
    resources: [],
    targets: [],
    dispatches: [],
  };
}

function withState(number: number, state: 'open' | 'closed'): void {
  board = board.map((each) => (each.number === number ? { ...each, state } : each));
}

function withQueue(queue: number[]): void {
  const byNumber = new Map(board.map((each) => [each.number, each]));
  board = queue.map((number) => byNumber.get(number)!).concat(board.filter((each) => !queue.includes(each.number)));
}

const session = {
  api: {
    accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit: true }),
    getIssue: async (number: number): Promise<BoardIssue> => {
      const found = board.find((each) => each.number === number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return found;
    },
    createIssue: async (title: string, body: string): Promise<BoardIssue> => {
      const created = issue(board.length + 1);
      const next = { ...created, title, body };
      board = [...board, next];
      return next;
    },
    comment: async () => null,
    editIssueBody: async () => null,
    close: async (number: number) => { withState(number, 'closed'); },
    reopen: async (number: number) => { withState(number, 'open'); },
    reorderQueue: vi.fn(async (target: number[]) => { sentQueues.push(target); withQueue(target); return target; }),
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

async function mountApp(): Promise<HTMLElement> {
  const { container } = render(<App />);
  await waitFor(() => expect(session.readOverview).toHaveBeenCalled());
  await waitFor(() => expect(container.querySelectorAll('.issue-row').length).toBeGreaterThan(0));
  return container;
}

/** The issue numbers currently drawn as rows, in the order they are drawn. */
function drawnRows(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.issue-row')).map((row) => Number(row.getAttribute('data-issue')));
}

function list(container: HTMLElement): HTMLElement {
  return container.querySelector('.issue-list') as HTMLElement;
}

function rangeText(container: HTMLElement): string {
  const range = container.querySelector('.issue-page-range');
  return range === null ? '' : (range.textContent ?? '');
}

function pagination(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.issue-pagination');
}

function nextButton(container: HTMLElement): HTMLButtonElement {
  return screen.getByRole('button', { name: ISSUE_PAGE_NEXT });
}

function previousButton(container: HTMLElement): HTMLButtonElement {
  return screen.getByRole('button', { name: ISSUE_PAGE_PREVIOUS });
}

async function goNext(container: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(nextButton(container)); });
}

async function goPrevious(container: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(previousButton(container)); });
}

function chooseFilter(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp('^' + name) }));
}

beforeEach(() => {
  window.localStorage.clear();
  // Every test starts from the board's own opening URL, so one test's paging is
  // never the next test's starting page. The Issues-page number is addressable
  // UI state (board issue 139) as well as local state, so a mount reads it out of
  // `window.location.search`; without this the reader would arrive on whatever
  // page the previous case left behind. This mirrors the reset the URL suite
  // already makes, and weakens no assertion: each case still asserts the page
  // the reader actually ends up on.
  window.history.replaceState(null, '', '/');
  board = [];
  reads = 0;
  sentQueues.length = 0;
  session.api.reorderQueue.mockClear();
  session.readOverview.mockClear();
  session.hasCredential.mockReturnValue(true);
});

afterEach(cleanup);

describe('issue list pagination state', () => {
  it('defaults to 50 issues a page', () => {
    expect(ISSUE_PAGE_SIZE).toBe(50);
    // The default is a default argument, so the count, the slice and the
    // position line all agree without a number repeated at a call site.
    expect(issuePageCount(50)).toBe(1);
    expect(issuePageCount(51)).toBe(2);
    expect(issuePageCount(126)).toBe(3);
    expect(issuePageCount(0)).toBe(1);
    expect(issuePage(boardOf(126), 1)).toHaveLength(50);
    expect(issuePage(boardOf(126), 3)).toHaveLength(26);
    // An explicit size is honoured, so the same functions serve a smaller board.
    expect(issuePageCount(126, 10)).toBe(13);
  });

  it('slices the semantic order rather than re-ordering it, for every filter', () => {
    // Deliberately awkward: the board's queue is 60, 40, 10, ... and the closed
    // tail is not in it. Open must stay in queue order, closed in ascending
    // number, and all open-queue-first.
    const all = [...Array.from({ length: 60 }, (_, index) => issue(index + 1)),
      ...Array.from({ length: 20 }, (_, index) => issue(100 + index, 'closed'))];
    // A complete queue: every open issue exactly once, which is what the board
    // commits, with the head deliberately not in ascending number order.
    const queue = [60, 40, 10, ...Array.from({ length: 60 }, (_, index) => index + 1).filter((number) => number !== 10 && number !== 40 && number !== 60)];

    const open = visibleIssues(all, queue, 'open');
    const closed = visibleIssues(all, queue, 'closed');
    const every = visibleIssues(all, queue, 'all');

    expect(open.slice(0, 3)).toEqual([60, 40, 10].map((number) => all.find((each) => each.number === number)));
    expect(issuePage(open, 1).map((each) => each.number)).toEqual(open.slice(0, ISSUE_PAGE_SIZE).map((each) => each.number));
    expect(issuePage(open, 2).map((each) => each.number)).toEqual(open.slice(50).map((each) => each.number));
    // Closed issues keep their stable order across pages, and `all` is still the
    // open queue first with the closed tail after it.
    expect(issuePage(closed, 1).map((each) => each.number)).toEqual(closed.slice(0, 20).map((each) => each.number));
    expect(every.slice(0, 60).map((each) => each.number)).toEqual(open.map((each) => each.number));
    expect(every.slice(60).map((each) => each.number)).toEqual(closed.map((each) => each.number));
    expect(issuePage(every, 2).map((each) => each.number)).toEqual(every.slice(50, 100).map((each) => each.number));
    // No page is a re-sort: the concatenation of the pages is the whole list.
    expect([1, 2].flatMap((page) => issuePage(every, page).map((each) => each.number))).toEqual(every.map((each) => each.number));
  });

  it('clamps a page index into the range that exists, and never upward', () => {
    expect(clampIssuePage(3, 126)).toBe(3);
    // Closing, reopening, deleting or creating can shorten the list under the
    // reader. The page they were on is preserved whenever it still exists.
    expect(clampIssuePage(2, 51)).toBe(2);
    expect(clampIssuePage(2, 50)).toBe(1);
    expect(clampIssuePage(3, 26)).toBe(1);
    expect(clampIssuePage(3, 0)).toBe(1);
    // A filter change lands on a valid page too, rather than on an empty one.
    expect(clampIssuePage(3, 60)).toBe(2);
    expect(clampIssuePage(3, 101)).toBe(3);
    // A page number that was never a page, or is not a whole one, is page 1.
    expect(clampIssuePage(0, 126)).toBe(1);
    expect(clampIssuePage(-4, 126)).toBe(1);
    expect(clampIssuePage(1.5, 126)).toBe(1);
  });

  it('names the slice on screen out of the whole filtered list', () => {
    expect(issuePageRange(126, 1)).toBe('1–50 of 126');
    expect(issuePageRange(126, 2)).toBe('51–100 of 126');
    // The last page is short and says how short it is, rather than claiming 50.
    expect(issuePageRange(126, 3)).toBe('101–126 of 126');
    expect(issuePageRange(50, 1)).toBe('1–50 of 50');
    expect(issuePageRange(0, 1)).toBe('No issues');
    expect(issuePageRange(126, 9)).toBe('101–126 of 126');
  });

  it('offers the controls only when there is more than one page', () => {
    expect(hasIssuePages(50)).toBe(false);
    expect(hasIssuePages(51)).toBe(true);
  });
});

describe('the pagination control', () => {
  it('says which slice is shown and disables each control at its own end', () => {
    const container = document.createElement('div');
    render(<IssuePagination total={126} page={1} onPage={() => {}} />, { container });
    expect(container.textContent).toContain('1–50 of 126');
    expect(within(container).getByRole('button', { name: ISSUE_PAGE_PREVIOUS }).hasAttribute('disabled')).toBe(true);
    expect(within(container).getByRole('button', { name: ISSUE_PAGE_NEXT }).hasAttribute('disabled')).toBe(false);

    cleanup();

    const last = document.createElement('div');
    render(<IssuePagination total={126} page={3} onPage={() => {}} />, { container: last });
    expect(last.textContent).toContain('101–126 of 126');
    expect(within(last).getByRole('button', { name: ISSUE_PAGE_PREVIOUS }).hasAttribute('disabled')).toBe(false);
    expect(within(last).getByRole('button', { name: ISSUE_PAGE_NEXT }).hasAttribute('disabled')).toBe(true);
  });

  it('renders nothing at all for a list that fits on one page', () => {
    const container = document.createElement('div');
    render(<IssuePagination total={50} page={1} onPage={() => {}} />, { container });
    // A board with three issues is not given two permanently disabled buttons and
    // a position line: there is nothing there to page through.
    expect(container.querySelector('.issue-pagination')).toBeNull();
  });
});

describe('the issues list, paginated', () => {
  it('draws one page of the list and not the whole of it', async () => {
    board = boardOf(126);
    const container = await mountApp();

    // The exact page size, and no more: a list that rendered every visible issue
    // would put 126 rows in the DOM here.
    expect(drawnRows(container)).toHaveLength(ISSUE_PAGE_SIZE);
    expect(drawnRows(container)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(rangeText(container)).toBe('1–50 of 126');
    expect(previousButton(container).disabled).toBe(true);
    expect(nextButton(container).disabled).toBe(false);
  });

  it('walks forwards and backwards through the pages without losing or repeating a row', async () => {
    board = boardOf(126);
    const container = await mountApp();

    await goNext(container);
    expect(drawnRows(container)).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
    expect(rangeText(container)).toBe('51–100 of 126');
    expect(previousButton(container).disabled).toBe(false);
    expect(nextButton(container).disabled).toBe(false);

    await goNext(container);
    expect(drawnRows(container)).toEqual(Array.from({ length: 26 }, (_, index) => index + 101));
    expect(rangeText(container)).toBe('101–126 of 126');
    // The end of the list is the end of the controls, not a wrap-around.
    expect(nextButton(container).disabled).toBe(true);

    await goPrevious(container);
    expect(rangeText(container)).toBe('51–100 of 126');
    await goPrevious(container);
    expect(rangeText(container)).toBe('1–50 of 126');
    expect(previousButton(container).disabled).toBe(true);
  });

  it('paginates each filter on its own total and lands on a valid page', async () => {
    board = boardOf(120, 60);
    const container = await mountApp();

    await act(async () => { chooseFilter('Closed'); });
    // The closed tail pages on its own total, in its own stable order, and does
    // not carry the open list's queue positions with it.
    expect(rangeText(container)).toBe('1–50 of 60');
    expect(drawnRows(container)).toEqual(Array.from({ length: 50 }, (_, index) => index + 121));
    await goNext(container);
    expect(drawnRows(container)).toEqual(Array.from({ length: 10 }, (_, index) => index + 171));
    expect(rangeText(container)).toBe('51–60 of 60');
    expect(previousButton(container).disabled).toBe(false);
    expect(nextButton(container).disabled).toBe(true);

    await act(async () => { chooseFilter('All'); });
    expect(rangeText(container)).toBe('51–100 of 180');
    // All is open-queue-first, so the second page is still open work in queue
    // order and paging did not reorder anything.
    expect(drawnRows(container)).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));

    await goNext(container);
    // The open queue ends mid-page: page 3 is the last twenty open issues
    // followed by the first thirty closed ones, in that order.
    expect(drawnRows(container)).toEqual(Array.from({ length: 50 }, (_, index) => index + 101));
    expect(rangeText(container)).toBe('101–150 of 180');

    await goNext(container);
    expect(drawnRows(container)).toEqual(Array.from({ length: 30 }, (_, index) => index + 151));
    expect(rangeText(container)).toBe('151–180 of 180');
    expect(nextButton(container).disabled).toBe(true);

    await act(async () => { chooseFilter('Open'); });
    expect(rangeText(container)).toBe('101–120 of 120');
    expect(nextButton(container).disabled).toBe(true);
  });

  it('lands on a valid page when the filter shrinks the list under the reader', async () => {
    board = boardOf(126, 3);
    const container = await mountApp();
    await goNext(container);
    await goNext(container);
    expect(rangeText(container)).toBe('101–126 of 126');

    // Three closed issues cannot fill a page of their own, so the reader lands on
    // the only page there is rather than on an empty third one.
    await act(async () => { chooseFilter('Closed'); });
    // Three closed issues are one page, so the reader lands on it and the
    // controls are gone rather than left disabled on a page that does not exist.
    expect(rangeText(container)).toBe('');
    expect(drawnRows(container)).toEqual([127, 128, 129]);
    expect(pagination(container)).toBeNull();

    await act(async () => { chooseFilter('Open'); });
    expect(rangeText(container)).toBe('101–126 of 126');
  });

  it('clamps back onto the last page that exists when a close empties one', async () => {
    board = boardOf(101);
    const container = await mountApp();
    await goNext(container);
    await goNext(container);
    expect(rangeText(container)).toBe('101–101 of 101');
    expect(drawnRows(container)).toEqual([101]);

    // Close the only issue on that page. The reader was on page 3 of a list that
    // is now two pages long, so the page is clamped down onto page 2 — a full,
    // valid page — instead of being left showing nothing or thrown back to page 1.
    await act(async () => { fireEvent.click(within(list(container)).getByRole('button', { name: /Issue 101/ })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Close issue' })); });

    expect(rangeText(container)).toBe('51–100 of 100');
    expect(drawnRows(container)).toHaveLength(50);
    expect(previousButton(container).disabled).toBe(false);
    expect(nextButton(container).disabled).toBe(true);
  });

  it('keeps the page the reader was on when a close leaves it valid', async () => {
    board = boardOf(120);
    const container = await mountApp();
    await goNext(container);
    expect(rangeText(container)).toBe('51–100 of 120');

    // Closing an issue that is not on this page shortens the list by one and the
    // second page still exists, so the reader stays exactly where they were.
    await act(async () => { fireEvent.click(within(list(container)).getByRole('button', { name: /Issue 61/ })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Close issue' })); });

    expect(rangeText(container)).toBe('51–100 of 119');
    // The closed issue left the open queue, so the one row that shifted is the
    // gap it left: everything after 60 moved up one. The page itself never moved.
    expect(drawnRows(container)).toEqual([...Array.from({ length: 10 }, (_, index) => index + 51), ...Array.from({ length: 40 }, (_, index) => index + 62)]);
  });

  it('reopens an issue and keeps the page it belonged to', async () => {
    board = boardOf(51);
    const container = await mountApp();
    await goNext(container);
    expect(rangeText(container)).toBe('51–51 of 51');
    // All, so the closed issue is still listed and its thread stays open. The
    // reader is on page 2 of 2 and page 2 is a page of this filter too.
    await act(async () => { chooseFilter('All'); });
    expect(rangeText(container)).toBe('51–51 of 51');

    await act(async () => { fireEvent.click(within(list(container)).getByRole('button', { name: /Issue 51/ })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Close issue' })); });
    expect(rangeText(container)).toBe('51–51 of 51');
    expect(drawnRows(container)).toEqual([51]);

    // Reopening puts the issue back in the queue, and the reader is left on the
    // page that issue was on rather than sent back to the beginning of the list.
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Reopen issue' })); });
    expect(rangeText(container)).toBe('51–51 of 51');
    expect(drawnRows(container)).toEqual([51]);
    expect(list(container).querySelector('.state-label.open')).not.toBeNull();
  });

  it('keeps the reader on their page when an issue is created', async () => {
    board = boardOf(120);
    const container = await mountApp();
    await goNext(container);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Create an issue'), { target: { value: 'Fresh issue' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    });

    // Creating opens the new issue's thread, and the list behind it is still on
    // the page the reader chose rather than reset to the first one.
    expect(rangeText(container)).toBe('51–100 of 121');
    expect(drawnRows(container)).toHaveLength(50);
  });

  it('commits the whole queue from a control on the last page, not the page', async () => {
    board = boardOf(120);
    const container = await mountApp();
    await goNext(container);
    await goNext(container);
    expect(drawnRows(container)).toHaveLength(20);

    // The move-to control of the selected row offers every slot in the queue,
    // because the queue is the whole one and not the twenty rows on screen.
    const row = container.querySelector('.issue-row[data-issue="101"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Issue 101/ }));
    const control = await within(list(container)).findByRole('combobox', { name: /positions run from 1 to 120/ });
    expect(within(control).getAllByRole('option')).toHaveLength(120);

    await act(async () => { fireEvent.change(control, { target: { value: '1' } }); });

    expect(session.api.reorderQueue).toHaveBeenCalledTimes(1);
    const committed = session.api.reorderQueue.mock.calls[0]![0];
    // Every open issue exactly once: the full queue, not a page of it and not
    // the dragged pair. Pagination changed what is drawn, not what a move means.
    expect(committed).toHaveLength(120);
    expect([...committed].sort((left, right) => left - right)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1));
    expect(committed[0]).toBe(101);
    // The page the reader was on is still a page of the reordered queue.
    expect(rangeText(container)).toBe('101–120 of 120');
  });

  it('keeps a moved issue on the page the reader is looking at', async () => {
    board = boardOf(120);
    const container = await mountApp();
    await goNext(container);

    // Issue 51 is the first row of the second page. Moving it later keeps the
    // page itself valid and shifts exactly one row into it.
    const row = container.querySelector('.issue-row[data-issue="51"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Move one place later in the priority queue (#51)' }));
    });

    expect(sentQueues).toHaveLength(1);
    expect(sentQueues[0]).toHaveLength(120);
    expect(rangeText(container)).toBe('51–100 of 120');
    // The one place the two swapped is inside this page; the other 49 rows did
    // not move, which is the point: paging did not change what a move means.
    expect(drawnRows(container)).toHaveLength(50);
    expect(drawnRows(container).slice(0, 3)).toEqual([52, 51, 53]);
    expect(drawnRows(container)[49]).toBe(100);
  });

  it('returns to the list on the page it was left on', async () => {
    board = boardOf(120);
    const container = await mountApp();
    await goNext(container);

    await act(async () => { fireEvent.click(within(list(container)).getByRole('button', { name: /Issue 60/ })); });
    expect(await screen.findByRole('heading', { name: 'Issue 60' })).toBeDefined();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /All issues/ })); });

    // Not the beginning of the list: the page is the one the reader opened the
    // issue from, and it is still a page of the board as it is now.
    expect(rangeText(container)).toBe('51–100 of 120');
    expect(drawnRows(container)).toContain(60);
  });

  it('leaves the feed its own cursor-based paging', async () => {
    // The feed has no page controls and reads one cursor page at a time; the
    // list's Previous/Next are the issue list's alone.
    board = boardOf(126);
    const container = await mountApp();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'feed' })); });

    expect(container.querySelector('.feed-more')).toBeNull();
    expect(container.querySelector('.issue-pagination')).toBeNull();
    expect(session.readFeed).toHaveBeenCalledWith({ limit: DEFAULT_FEED_LIMIT });
  });
});