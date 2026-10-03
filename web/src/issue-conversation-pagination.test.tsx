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
import type { BrowserBoardSession } from './api';
import {
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
 */
function readPage(number: number, page: number): IssueCommentPage {
  askedPages.push([number, page]);
  const found = board.find((each) => each.number === number);
  if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
  const total = found.messages.length;
  return {
    schemaVersion: 2,
    boardId: 'board-1',
    issue: { ...found, messages: [] },
    page,
    pageCount: commentPageCount(total),
    total,
    messages: found.messages.slice((page - 1) * COMMENT_PAGE_SIZE, page * COMMENT_PAGE_SIZE),
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

function nextButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Next page' });
}

function previousButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Previous page' });
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
    expect(commentPageRange(120, 2)).toBe('51–100 of 120');
    expect(commentPageRange(120, 3)).toBe('101–120 of 120');
    expect(commentPageRange(0, 1)).toBe('No issues');
  });

  it('names the conversation page in the address, separately from the list page', () => {
    // The address carries both: an issue opened from page 4 of the list, reading
    // page 2 of its conversation. Two fields, so neither renumbers the other.
    expect(parseBoardUrl('?issue=2&filter=all&page=4&thread=2')).toMatchObject({ page: 4, commentPage: 2 });
  });
});

describe('the conversation renders one page at a time', () => {
  it('draws 50 messages of a 120-message thread, not all 120', async () => {
    const container = await mountAtIssue(2);
    const drawn = drawnMessages(container);
    expect(drawn).toHaveLength(50);
    expect(drawn[0]).toBe('message 1');
    expect(drawn[49]).toBe('message 50');
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

  it('pages forward and back, reading the page it is asked for', async () => {
    const container = await mountAtIssue(2);
    await waitFor(() => expect(positionText(container)).not.toBe(''));

    await act(async () => { fireEvent.click(nextButton()); });
    await waitFor(() => expect(drawnMessages(container)[0]).toBe('message 51'));
    expect(drawnMessages(container)).toHaveLength(50);
    expect(positionText(container)).toContain('Page 2 of 3');
    expect(positionText(container)).toContain('51–100 of 120');
    expect(window.location.search).toContain('thread=2');

    await act(async () => { fireEvent.click(nextButton()); });
    await waitFor(() => expect(drawnMessages(container)).toHaveLength(20));
    expect(drawnMessages(container)[0]).toBe('message 101');
    expect(positionText(container)).toContain('Page 3 of 3');
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { fireEvent.click(previousButton()); });
    await waitFor(() => expect(positionText(container)).toContain('Page 2 of 3'));
    // Each page change was one request for that page, not a re-read of the thread.
    expect(askedPages).toContainEqual([2, 2]);
    expect(askedPages).toContainEqual([2, 3]);
  });

  it('keeps the message order stable across pages', async () => {
    const container = await mountAtIssue(2);
    await waitFor(() => expect(positionText(container)).not.toBe(''));
    const paged: string[] = [];
    paged.push(...drawnMessages(container));
    for (let page = 2; page <= 3; page += 1) {
      await act(async () => { fireEvent.click(nextButton()); });
      await waitFor(() => expect(positionText(container)).toContain(`Page ${page} of 3`));
      paged.push(...drawnMessages(container));
    }
    expect(paged).toEqual(messages(120).map((each) => each.body));
  });

  it('opens the page the address names', async () => {
    const container = await mountAtIssue(2, '&thread=3');
    await waitFor(() => expect(positionText(container)).toContain('Page 3 of 3'));
    expect(drawnMessages(container)[0]).toBe('message 101');
    expect(askedPages).toContainEqual([2, 3]);
  });

  it('gives a stale page the one that exists, and corrects the address', async () => {
    // A link whose page the thread no longer has clamps down onto the last page
    // that does, and the address is rewritten to name what is drawn rather than
    // leaving a link that no longer opens what it says.
    const container = await mountAtIssue(2, '&thread=9');
    await waitFor(() => expect(positionText(container)).toContain('Page 3 of 3'));
    expect(drawnMessages(container)[0]).toBe('message 101');
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
    const container = await mountAtIssue(2);
    await waitFor(() => expect(positionText(container)).not.toBe(''));
    // The composer is reachable because the stub grants write access and a name.
    const composer = container.querySelector('.composer-area textarea') as HTMLTextAreaElement;
    expect(composer).not.toBeNull();
    fireEvent.change(composer, { target: { value: 'the newest comment' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Post/ })); });

    // A comment is appended to the end of the thread, so the reader is taken to
    // the page it is on: page 3 of a 121-message thread.
    await waitFor(() => expect(positionText(container)).toContain('Page 3 of 3'));
    expect(drawnMessages(container)).toHaveLength(21);
    expect(parseBoardUrl(window.location.search).commentPage).toBe(3);
  });
});