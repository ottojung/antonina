import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-comment-page-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-comment-page-config';

import App from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue } from './model';
import type { BoardAccessState, BoardOverview, IssueCommentPage } from '../../packages/core/src/api';
// Board issue 180's All Issues key, so this fixture mirrors what core's store
// writes: the newest comment's time, or null when the issue has no comments.
import { newestCommentAt } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';
import {
  COMMENT_PAGE_NEWER,
  COMMENT_PAGE_OLDER,
  COMMENT_PAGE_SIZE,
  clampCommentPage,
  commentPageCount,
  commentPageRange,
  hasCommentPages,
  lastCommentPage,
} from './ui-state';
import { parseBoardUrl } from './board-url';

const STAMP = '2026-09-27T12:00:00.000Z';

function message(index: number) {
  return {
    id: `sha256:` + index.toString(16).padStart(43, '0'),
    author: `author ${index}`,
    body: `message ${index}`,
    createdAt: STAMP,
  };
}

function messages(count: number) {
  return Array.from({ length: count }, (_, index) => message(index + 1));
}

function issue(number: number, count = 0): BoardIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body of issue ${number}`,
    state: 'open',
    createdAt: STAMP,
    updatedAt: STAMP,
    messages: messages(count),
  };
}

let board: BoardIssue[] = [];
let reads = 0;
/** Every `(issue, page)` the shell asked the core for, in order. */
const askedPages: Array<[number, number]> = [];

function overview(): BoardOverview {
  reads += 1;
  return {
    boardId: 'board-1',
    head: 'op-' + reads,
    revision: 1,
    deleted: false,
    queue: board.map((each) => each.number),
    issues: board.map((each) => ({
      number: each.number,
      title: each.title,
      state: each.state,
      createdAt: each.createdAt,
      updatedAt: each.updatedAt,
      closedAt: null,
      messageCount: each.messages.length,
      lastActivityAt: newestCommentAt(each.messages),
      hasBody: each.body.length > 0,
    })),
    resources: [],
    targets: [],
    dispatches: [],
  };
}

/**
 * The bounded read, standing in for the store: it hands back the issue's own
 * fields with an empty `messages` array and exactly the requested page, and it
 * records the request. A stub that could return the whole thread would make
 * every assertion below pass, so the fan-out is asserted on the requests this
 * one saw, the way the store test counts shard reads.
 *
 * The window is cut from the NEWEST end, which is what the store does:
 * `readNewestFirstCommentPage` in packages/core. This stub mirrors that
 * arithmetic deliberately rather than slicing from the front, because a stub
 * that disagreed with the store about which end page 1 is would make every
 * ordering assertion below pass for the wrong reason. Board issue 206: the
 * browser and the CLI have to answer "what is on page 1" identically.
 */
function readPage(number: number, page: number): IssueCommentPage {
  askedPages.push([number, page]);
  const found = board.find((each) => each.number === number);
  if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
  const total = found.messages.length;
  const end = Math.max(0, total - (page - 1) * COMMENT_PAGE_SIZE);
  const start = Math.max(0, end - COMMENT_PAGE_SIZE);
  return {
    schemaVersion: 2,
    boardId: 'board-1',
    issue: { ...found, messages: [] },
    page,
    pageCount: commentPageCount(total),
    total,
    messages: found.messages.slice(start, end),
  };
}

const session = {
  api: {
    accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit: true }),
    getIssueCommentPage: vi.fn(async (number: number, page: number): Promise<IssueCommentPage> => readPage(number, page)),
    // The whole-thread read stays on the API for its own callers. The shell is
    // not one of them, and this counts any call so the tests can prove it.
    getIssue: vi.fn(async (number: number): Promise<BoardIssue> => {
      const found = board.find((each) => each.number === number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return found;
    }),
    createIssue: async (title: string, body: string): Promise<BoardIssue> => {
      const next = { ...issue(board.length + 1), title, body };
      board = [...board, next];
      return next;
    },
    // The real `BoardApi.comment` answers with the committed issue, which is how
    // the shell learns the write succeeded.
    comment: vi.fn(async (number: number, _author: string, _body: string): Promise<BoardIssue> => {
      board = board.map((each) => each.number === number
        ? { ...each, messages: [...each.messages, message(each.messages.length + 1)] }
        : each);
      return board.find((each) => each.number === number)!;
    }),
    editIssueBody: async () => null,
    close: async () => undefined,
    reopen: async () => undefined,
    reorderQueue: async (target: number[]) => target,
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

async function mountAt(search: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', '/' + search);
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelectorAll('.issue-row').length).toBeGreaterThan(0));
  return container;
}

async function mountAtIssue(number: number, search = ''): Promise<HTMLElement> {
  const container = await mountAt(`?issue=${number}&filter=all${search}`);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^#${number}`) }));
  await waitFor(() => expect(container.querySelector('.messages')).not.toBeNull());
  return container;
}

function drawnMessages(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.messages .message p')).map((node) => node.textContent ?? '');
}

function positionText(container: HTMLElement): string {
  return container.querySelector('.comment-page-position')?.textContent ?? '';
}

/**
 * The two ways out of a page of a conversation.
 *
 * Board issue 206: these are named for which END of the conversation they reach,
 * because page 1 is the newest window. The page numbers they move to are the
 * list's own arithmetic and are unchanged; only the words differ.
 */
function nextButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: COMMENT_PAGE_OLDER });
}

function previousButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: COMMENT_PAGE_NEWER });
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('antonina:display-name', 'tester');
  window.history.replaceState(null, '', '/');
  board = [issue(1, 0), issue(2, 120), issue(3, 50)];
  reads = 0;
  askedPages.length = 0;
  session.api.getIssueCommentPage.mockClear();
  session.api.getIssue.mockClear();
  session.readOverview.mockClear();
});

afterEach(cleanup);

describe('issue conversation pagination state', () => {
  it('defaults to 50 messages a page, and pages the way the list does', () => {
    expect(COMMENT_PAGE_SIZE).toBe(50);
    expect(commentPageCount(0)).toBe(1);
    expect(commentPageCount(50)).toBe(1);
    expect(commentPageCount(51)).toBe(2);
    expect(commentPageCount(120)).toBe(3);
    expect(lastCommentPage(120)).toBe(3);
    expect(hasCommentPages(50)).toBe(false);
    expect(hasCommentPages(51)).toBe(true);
    // The clamp is the list's rule, unchanged: an out-of-range page moves down
    // onto the last page that exists rather than back to the top.
    expect(clampCommentPage(9, 120)).toBe(3);
    expect(clampCommentPage(0, 120)).toBe(1);
    expect(clampCommentPage(2, 0)).toBe(1);
    // Board issue 206: the RANGE is the one thing that is not the list's. Page 1
    // of a 120-comment thread is the newest window, so it covers comments 71–120,
    // and the line has to say so rather than reporting the window nobody is
    // looking at. The count, the clamp and the "is there another page" question
    // are still the list's own, because none of those depend on direction.
    expect(commentPageRange(120, 1)).toBe('71–120 of 120');
    expect(commentPageRange(120, 2)).toBe('21–70 of 120');
    expect(commentPageRange(120, 3)).toBe('1–20 of 120');
    expect(commentPageRange(0, 1)).toBe('No issues');
    // A thread that fits on one page reports the whole thread whichever end the
    // pages are numbered from.
    expect(commentPageRange(50, 1)).toBe('1–50 of 50');
  });

  it('names the conversation page in the address, separately from the list page', () => {
    // The address carries both: an issue opened from page 4 of the list, reading
    // page 2 of its conversation. Two fields, so neither renumbers the other.
    expect(parseBoardUrl('?issue=2&filter=all&page=4&thread=2')).toMatchObject({ page: 4, commentPage: 2 });
  });
});

describe('the conversation renders one page at a time', () => {
  it('draws the 50 MOST RECENT messages of a 120-message thread, not all 120', async () => {
    const container = await mountAtIssue(2);
    const drawn = drawnMessages(container);
    expect(drawn).toHaveLength(50);
    // Board issue 206: this is the assertion the 21:00Z orchestrator pass could
    // not have made. Opening an issue has to show the END of its conversation,
    // so a reader who reads one page has seen the current state. Under
    // oldest-first numbering this page began at 'message 1' and a reader took it
    // for the whole story.
    expect(drawn.at(-1)).toBe('message 120');
    expect(drawn[0]).toBe('message 71');
    expect(drawn).not.toContain('message 1');
    expect(drawn).not.toContain('message 51');
  });

  it('asks the core for one bounded page, never the whole thread', async () => {
    const container = await mountAtIssue(2);
    await waitFor(() => expect(positionText(container)).not.toBe(''));
    expect(session.api.getIssue.mock.calls).toHaveLength(0);
    expect(session.api.getIssueCommentPage).toHaveBeenCalled();
    // Every request the opening made was for the same page, one at a time. A read
    // that reassembled the thread would be a `getIssue` call and nothing here.
    expect(askedPages.every(([, page]) => page === 1)).toBe(true);
  });

  it('pages backward into older history, reading the page it is asked for', async () => {
    const container = await mountAtIssue(2);
    await waitFor(() => expect(positionText(container)).not.toBe(''));

    // Board issue 206: "Older" increments the page number, because a higher page
    // number reaches further back into the thread. The page numbers the buttons
    // move to are the list's own arithmetic and are unchanged by the direction.
    await act(async () => { fireEvent.click(nextButton()); });
    await waitFor(() => expect(drawnMessages(container)[0]).toBe('message 21'));
    expect(drawnMessages(container)).toHaveLength(50);
    expect(positionText(container)).toContain('Page 2 of 3');
    expect(positionText(container)).toContain('21–70 of 120');
    expect(window.location.search).toContain('thread=2');

    await act(async () => { fireEvent.click(nextButton()); });
    await waitFor(() => expect(drawnMessages(container)).toHaveLength(20));
    expect(drawnMessages(container)[0]).toBe('message 1');
    expect(positionText(container)).toContain('Page 3 of 3');
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
    // There is nothing newer than page 1, so the other control is disabled there.
    expect((previousButton() as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { fireEvent.click(previousButton()); });
    await waitFor(() => expect(positionText(container)).toContain('Page 2 of 3'));
    // Each page change was one request for that page, not a re-read of the thread.
    expect(askedPages).toContainEqual([2, 2]);
    expect(askedPages).toContainEqual([2, 3]);
  });

  it('keeps the message order stable across pages, newest window first', async () => {
    const container = await mountAtIssue(2);
    await waitFor(() => expect(positionText(container)).not.toBe(''));
    const pages: string[][] = [drawnMessages(container)];
    for (let page = 2; page <= 3; page += 1) {
      await act(async () => { fireEvent.click(nextButton()); });
      await waitFor(() => expect(positionText(container)).toContain(`Page ${page} of 3`));
      pages.push(drawnMessages(container));
    }

    // Within a page the order is chronological, so reversing the PAGE sequence
    // reproduces the whole thread. Reversing the flat concatenation would not, and
    // asserting that instead would be asserting an unstable tie-break.
    expect(pages.slice().reverse().flat()).toEqual(messages(120).map((each) => each.body));
    // And the pages partition the thread: nothing lost, nothing drawn twice.
    expect(new Set(pages.flat()).size).toBe(120);
  });

  it('opens the page the address names', async () => {
    // A deep link keeps meaning the same thing it meant before the direction
    // changed, because a page number still selects the same WINDOW -- the windows
    // are just enumerated from the other end. `thread=3` is the oldest page of a
    // 120-comment thread either way.
    const container = await mountAtIssue(2, '&thread=3');
    await waitFor(() => expect(positionText(container)).toContain('Page 3 of 3'));
    expect(drawnMessages(container)[0]).toBe('message 1');
    expect(askedPages).toContainEqual([2, 3]);
  });

  it('gives a stale page the one that exists, and corrects the address', async () => {
    // A link whose page the thread no longer has clamps down onto the last page
    // that does, and the address is rewritten to name what is drawn rather than
    // leaving a link that no longer opens what it says.
    const container = await mountAtIssue(2, '&thread=9');
    await waitFor(() => expect(positionText(container)).toContain('Page 3 of 3'));
    expect(drawnMessages(container)[0]).toBe('message 1');
    expect(parseBoardUrl(window.location.search).commentPage).toBe(3);
    expect(askedPages).toContainEqual([2, 3]);
  });

  it('offers no controls for a thread that fits on one page', async () => {
    const container = await mountAtIssue(3);
    await waitFor(() => expect(container.querySelector('.messages')).not.toBeNull());
    expect(drawnMessages(container)).toHaveLength(50);
    expect(positionText(container)).toBe('');
    expect(container.querySelector('.messages .issue-pagination')).toBeNull();
  });

  it('counts the whole thread, not the page on screen', async () => {
    const container = await mountAtIssue(2);
    await waitFor(() => expect(positionText(container)).not.toBe(''));
    expect(container.querySelector('.thread-title')?.textContent).toContain('120 messages');
  });

  it('lands a new comment on the page it was appended to', async () => {
    // Start on an OLDER page, so "the post went to page 1" is not satisfied
    // vacuously by the reader happening to be there already.
    const container = await mountAtIssue(2, '&thread=3');
    await waitFor(() => expect(positionText(container)).toContain('Page 3 of 3'));
    expect(drawnMessages(container)[0]).toBe('message 1');
    // The composer is reachable because the stub grants write access and a name.
    const composer = container.querySelector('.composer-area textarea') as HTMLTextAreaElement;
    expect(composer).not.toBeNull();
    fireEvent.change(composer, { target: { value: 'the newest comment' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Post/ })); });

    // Board issue 206: a comment is appended to the newest end and page 1 is the
    // newest window, so the reader is taken THERE -- page 1 of a 121-message
    // thread -- and sees their own post. Under oldest-first numbering this jumped
    // to the last page, which is the same swallowed-post bug pointing the other
    // way.
    await waitFor(() => expect(positionText(container)).toContain('Page 1 of 3'));
    expect(drawnMessages(container)).toHaveLength(50);
    // The stub appends the 121st message to the board's copy of the thread; what
    // matters is that the comment written AFTER the reader arrived is on the page
    // they are now looking at.
    expect(drawnMessages(container).at(-1)).toBe('message 121');
    expect(positionText(container)).toContain('72–121 of 121');
    expect(parseBoardUrl(window.location.search).commentPage).toBe(1);
  });
});