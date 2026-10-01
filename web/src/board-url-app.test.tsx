import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-url-state-mount-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-url-state-mount-config';

import App from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue } from './model';
import type { BoardAccessState, BoardOverview } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';

/**
 * Board issue 139, mounted: the browser behaviors the URL state has to hold.
 *
 * `board-url.test.ts` pins the pure translation between a search string and the
 * board's UI state. This file mounts the real shell and drives the real address
 * bar, because the parts that matter here cannot be seen from a pure function:
 * a direct load, a reload, Back and Forward, and a copied link opened with no
 * credential in this browser at all. jsdom's `history` is the same one the
 * browser hands the app, so `replaceState` here stands in for reloading the page
 * and `popstate` for pressing Back.
 */
const STAMP = '2026-09-27T12:00:00.000Z';

/** The board credential as the browser holds it. Nothing below may put this in a URL. */
const SECRET = 'antonina-board-credential-root-1-do-not-share';

const allIssues = new Map<number, BoardIssue>();

const session = {
  api: {
    accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit: false }),
    getIssue: async (number: number): Promise<BoardIssue> => {
      const found = allIssues.get(number);
      if (found === undefined) throw new Error('Antonina issue ' + number + ' does not exist');
      return found;
    },
  },
  readOverview: vi.fn<() => Promise<BoardOverview | null>>(),
  // The browser does hold the credential — `hasCredential` and `credentialText`
  // say so — so the credential-safety case below is the real one: this browser
  // is authorized, and its URL still carries nothing but selectors.
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

function issue(number: number, overrides: Partial<BoardIssue> = {}): BoardIssue {
  return { number, title: `Issue ${number}`, body: `Body of issue ${number}`, state: 'open', createdAt: STAMP, updatedAt: STAMP, messages: [], ...overrides };
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
    issues: issues.map((each) => ({
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

const FEED_EMPTY: BoardFeedPage = { entries: [], nextCursor: null, total: 0, limit: DEFAULT_FEED_LIMIT };

/** The board's search string as the address bar currently holds it. */
function search(): string {
  return window.location.search;
}

/**
 * A reload of the current URL: the document goes away and a fresh `App` mounts
 * from the address bar. A second `App` is never mounted at once — `cleanup` runs
 * between the two — so this is the real reload, not a second app sharing a DOM.
 */
async function reload(): Promise<HTMLElement> {
  cleanup();
  return mount();
}

async function mount(): Promise<HTMLElement> {
  const { container } = render(<App />);
  expect(container.isConnected).toBe(true);
  await waitFor(() => expect(session.readOverview).toHaveBeenCalled());
  return container;
}

/** Loads the app at a URL, the way opening a copied link does. */
async function openAt(url: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', url);
  return mount();
}

/**
 * Presses Back (or Forward) the way a browser does: the history index moves and
 * `popstate` fires at the app.
 *
 * `window.history.back()` schedules that transition, so the press is a real one
 * only once the address has actually moved — which is what waiting for the href
 * to change asserts. The app's own `popstate` handler then re-renders, and the
 * assertions that follow read the settled tree through `findBy*`.
 */
async function pressHistory(direction: 'back' | 'forward'): Promise<void> {
  const before = window.location.href;
  window.history[direction]();
  await waitFor(() => expect(window.location.href).not.toBe(before));
}

async function goBack(): Promise<void> {
  await pressHistory('back');
}

async function goForward(): Promise<void> {
  await pressHistory('forward');
}

async function clickTab(name: string): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}

async function clickFilter(name: string): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp('^' + name) })); });
}

beforeEach(() => {
  window.localStorage.clear();
  allIssues.clear();
  // Every test starts from the board's own opening URL, so one test's
  // navigation is never the next test's starting screen.
  window.history.replaceState(null, '', '/board');
  session.readOverview.mockReset();
  session.readFeed.mockReset();
  session.readFeed.mockResolvedValue(FEED_EMPTY);
  session.readOverview.mockResolvedValue(overview([issue(1), issue(2), issue(3, { state: 'closed' })]));
});

afterEach(cleanup);

describe('the board addressed by URL, mounted', () => {
  it('opens on the Issues tab at its bare URL', async () => {
    await openAt('/board');
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeDefined();
    expect(screen.getByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    expect(search()).toBe('');
  });

  it('cleans a stale URL on arrival instead of leaving it in the address bar', async () => {
    // A link from a build that had a tab this one does not. The reader lands on
    // a working board and the address is rewritten to the screen they are on, so
    // a refresh of what they now see does not repeat the stale value.
    await openAt('/board?view=timeline&filter=mine');
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    expect(search()).toBe('');
  });

  it('gives each tab a stable URL of its own', async () => {
    await openAt('/board');

    await clickTab('feed');
    expect(search()).toBe('?view=feed');
    expect(screen.getByRole('complementary', { name: 'Board activity feed' })).toBeDefined();

    await clickTab('targets');
    expect(search()).toBe('?view=targets');

    await clickTab('issues');
    expect(search()).toBe('');
    expect(screen.getByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
  });

  it('opens each tab directly from its URL', async () => {
    await openAt('/board?view=feed');
    expect(await screen.findByRole('complementary', { name: 'Board activity feed' })).toBeDefined();
    await clickTab('resources');
    expect(await screen.findByRole('complementary', { name: 'Registered resources' })).toBeDefined();
    expect(search()).toBe('?view=resources');
  });

  it('names an open issue in the URL and restores it on reload', async () => {
    await openAt('/board');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Issue 1/ })); });

    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();
    expect(search()).toBe('?issue=1');

    const reloaded = await reload();
    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();
    expect(reloaded.querySelector('.workspace')?.className).toContain('has-selection');
    // The same screen, from the address bar alone.
    expect(search()).toBe('?issue=1');
  });

  it('opens an issue directly from a copied link', async () => {
    await openAt('/board?issue=2&filter=all');
    expect(await screen.findByRole('heading', { name: 'Issue 2' })).toBeDefined();
    expect(screen.getByText('Body of issue 2')).toBeDefined();
  });

  it('links to an issue from the feed, with the issue route in the href', async () => {
    session.readFeed.mockResolvedValue({
      entries: [{ id: 'op-1', kind: 'comment-added', at: STAMP, position: 1, issueNumber: 2, title: 'Issue 2', state: 'open', messageId: null, author: 'Lubko', body: 'on it' }],
      nextCursor: null,
      total: 1,
      limit: DEFAULT_FEED_LIMIT,
    });
    await openAt('/board');
    await clickTab('feed');

    const link = await screen.findByRole('button', { name: '#2 Issue 2' });
    expect(link.getAttribute('href')).toBe('/board?issue=2&filter=all');

    await act(async () => { fireEvent.click(link); });
    expect(await screen.findByRole('heading', { name: 'Issue 2' })).toBeDefined();
    expect(search()).toBe('?issue=2&filter=all');
  });

  it('restores the issue filter from the URL', async () => {
    await openAt('/board');
    // Open is the default filter, so the closed issue is behind it.
    expect(screen.queryByText('Issue 3')).toBeNull();

    await clickFilter('Closed');
    expect(search()).toBe('?filter=closed');
    expect(screen.getByText('Issue 3')).toBeDefined();

    await reload();
    expect(await screen.findByText('Issue 3')).toBeDefined();
    expect(screen.queryByText('Issue 1')).toBeNull();
    expect(search()).toBe('?filter=closed');
  });

  it('opens the filter named in the URL directly', async () => {
    await openAt('/board?filter=all');
    expect(await screen.findByText('Issue 3')).toBeDefined();
    expect(screen.getByText('Issue 1')).toBeDefined();
  });

  it('clears an issue the board no longer holds, and lands on the list', async () => {
    // A link to an issue that has been deleted since it was shared. The board
    // says so once it has been read, and the URL is rewritten to the list, so a
    // refresh of what the reader is now looking at is not the same dead link.
    await openAt('/board?issue=404&filter=all');
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    await waitFor(() => expect(search()).toBe('?filter=all'));
    // No thread for an issue the board does not hold, and no error page either:
    // the reader is on the Issues list with the filter their link named.
    expect(screen.queryByRole('heading', { name: 'Issue 404' })).toBeNull();
    expect(screen.getByText('Choose an issue to join the conversation.')).toBeDefined();
  });

  it('restores the issues-page number from the URL', async () => {
    await openAt('/board?page=3');
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    // Board issue 140 owns the slicing; what this side owns is the number
    // surviving a reload and a shared link, published for that front to read.
    expect(document.querySelector('.workspace')?.getAttribute('data-issue-page')).toBe('3');

    await reload();
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    expect(document.querySelector('.workspace')?.getAttribute('data-issue-page')).toBe('3');
  });

  it('lands an out-of-range page number on a usable board view', async () => {
    await openAt('/board?page=99999&filter=closed');
    expect(await screen.findByText('Issue 3')).toBeDefined();
    expect(document.querySelector('.workspace')?.getAttribute('data-issue-page')).toBe('99999');
  });

  it('degrades a page number that is not one to the first page', async () => {
    await openAt('/board?page=zero');
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    expect(document.querySelector('.workspace')?.getAttribute('data-issue-page')).toBe('1');
  });

  it('restores the previous board screen on Back and Forward', async () => {
    await openAt('/board');
    await clickTab('feed');
    await clickTab('targets');
    expect(search()).toBe('?view=targets');

    await goBack();
    expect(await screen.findByRole('complementary', { name: 'Board activity feed' })).toBeDefined();

    await goBack();
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();

    await goForward();
    expect(await screen.findByRole('complementary', { name: 'Board activity feed' })).toBeDefined();
    await goForward();
    expect(await screen.findByRole('complementary', { name: 'Execution target overview' })).toBeDefined();
  });

  it('restores an open issue on Back after leaving it', async () => {
    await openAt('/board');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Issue 1/ })); });
    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /All issues/ })); });
    expect(screen.queryByRole('heading', { name: 'Issue 1' })).toBeNull();
    expect(search()).toBe('');

    await goBack();
    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();
  });

  it('navigates without a document load', async () => {
    // A full-page reload would tear the app down and rebuild it. Nothing here
    // does: every screen change is a state change in the mounted tree.
    await openAt('/board');
    await clickTab('targets');
    await clickTab('issues');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Issue 1/ })); });
    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();
    // One read of the board for the whole run: nothing was re-mounted from a URL.
    expect(session.readOverview).toHaveBeenCalledTimes(1);
  });

  it('keeps the board credential out of the URL on every screen', async () => {
    // The security model, stated as an assertion about the address bar. This
    // browser holds the credential (`hasCredential` is true), so the URL is being
    // written by an authorized session — and it still carries nothing but
    // selectors. The credential lives in localStorage and is never read from or
    // written to the URL, so a link copied from here opens a useful board view
    // in a browser that has none of it, and leaks nothing to the many places a
    // URL travels that a credential does not.
    await openAt('/board');
    await clickTab('resources');
    await clickTab('feed');
    await clickTab('targets');
    await clickTab('issues');
    await clickFilter('Closed');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Issue 3/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Settings$/ })); });

    const url = window.location.href;
    expect(url).not.toContain(SECRET);
    expect(url).not.toMatch(/credential|token|secret|root-1/i);
    for (const key of [...new URLSearchParams(search).keys()]) {
      expect(['view', 'issue', 'filter', 'page', 'settings']).toContain(key);
    }
    // And the credential is where the credential model says it is: in this
    // browser's storage, not in anything a link could carry.
    expect(window.localStorage.getItem('antonina:board-v2:credential')).toBeNull();
  });

  it('opens a copied link usefully in a browser that holds no credential', async () => {
    // The consequence of the criterion above: a link is a selector, so a browser
    // without the credential is not given access by it. It reads the board it
    // can read and is told, by the app's own existing copy, that writing needs
    // the credential — degraded, and leaking nothing.
    session.hasCredential.mockReturnValue(false);
    await openAt('/board?issue=1&filter=all');

    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();
    expect(document.querySelector('.access-pill')?.textContent).toContain('Read only');
    expect(screen.getAllByText('Board credential required').length).toBeGreaterThan(0);
    expect(window.location.href).not.toContain(SECRET);
  });

  it('restores the settings panel from its own URL', async () => {
    await openAt('/board');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Settings$/ })); });
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(search()).toBe('?settings=1');

    await reload();
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(search()).toBe('?settings=1');
  });
});