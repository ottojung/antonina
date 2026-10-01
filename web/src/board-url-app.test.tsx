import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-url-state-mount-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-url-state-mount-config';

import App, { issueLinkClick } from './App';
import { ISSUE_PAGE_NEXT, ISSUE_PAGE_PREVIOUS } from './ui-state';

/** The pagination control's accessible names, so the tests speak 140's language. */
const NEXT_PAGE = ISSUE_PAGE_NEXT;
const PREVIOUS_PAGE = ISSUE_PAGE_PREVIOUS;
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

/**
 * The issue numbers the list is actually drawing, in the order it draws them.
 *
 * This is the assertion the `data-issue-page` attribute cannot replace. On the
 * broken two-sources-of-truth merge the attribute reported the URL's page while
 * the rows came from a different `useState`, so every attribute-only assertion
 * passed on a board that was demonstrably showing the wrong page.
 */
function drawnRows(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.issue-row')).map((row) => Number(row.getAttribute('data-issue')));
}

/** The pagination position line, which names the range of rows on screen. */
function rangeText(container: HTMLElement): string {
  return container.querySelector('.issue-page-range')?.textContent ?? '';
}

/** A board of `count` open issues, numbered 1..count, in queue order. */
function boardOf(count: number): BoardIssue[] {
  return Array.from({ length: count }, (_, index) => issue(index + 1));
}

/** The first and last issue numbers of the `page`th page of a `count`-issue board. */
function pageBounds(page: number, count = 120, size = 50): number[] {
  const first = (page - 1) * size + 1;
  const last = Math.min(page * size, count);
  return [first, last];
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

  it('restores the issues-page number from the URL and draws that page', async () => {
    // 120 open issues, so page 3 is a page that exists. On the three-issue
    // fixture this test used to run against, `?page=3` named a page the board
    // could not supply, so the only thing it could assert was the attribute —
    // and the attribute was satisfiable while the list drew page 1.
    session.readOverview.mockResolvedValue(overview(boardOf(120)));
    const container = await openAt('/board?page=3');
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    // The rows drawn are page 3's rows. This is the assertion that fails on a
    // tree with two page sources, because there the address says 3 and the
    // rows are 1–50.
    expect(drawnRows(container)).toEqual(Array.from({ length: 20 }, (_, index) => index + 101));
    expect(rangeText(container)).toBe('101–120 of 120');
    // The attribute stays, but it now names the page being drawn rather than the
    // number that arrived in the URL.
    expect(document.querySelector('.workspace')?.getAttribute('data-issue-page')).toBe('3');

    await reload();
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    expect(drawnRows(document.body)).toEqual(Array.from({ length: 20 }, (_, index) => index + 101));
    expect(document.querySelector('.workspace')?.getAttribute('data-issue-page')).toBe('3');
  });

  it('puts a page the reader reached with Next into the URL', async () => {
    // The other direction, and the one the merge broke: 140's control moved a
    // page that was never written to the address, so the reader's chosen page was
    // not copyable, not shareable and not restorable by Back.
    session.readOverview.mockResolvedValue(overview(boardOf(120)));
    const container = await openAt('/board');
    await waitFor(() => expect(drawnRows(container)).toHaveLength(50));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: NEXT_PAGE })); });

    // The address now names the page on screen, and the rows are that page's.
    expect(search()).toBe('?page=2');
    expect(drawnRows(container)).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
    expect(rangeText(container)).toBe('51–100 of 120');

    // And the copied address really does reopen that page, from cold.
    const reopened = await openAt(search());
    expect(drawnRows(reopened)).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
  });

  it('re-slices when Back returns to a page in the URL', async () => {
    session.readOverview.mockResolvedValue(overview(boardOf(120)));
    const container = await openAt('/board');
    await waitFor(() => expect(drawnRows(container)).toHaveLength(50));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: NEXT_PAGE })); });
    expect(drawnRows(container)[0]).toBe(51);

    await goBack();
    // The popstate handler parses the URL into `location`, and the slice is
    // derived from `location`, so Back moves the rows rather than only the
    // address.
    await waitFor(() => expect(drawnRows(document.body)[0]).toBe(1));
    expect(search()).toBe('');
  });

  it('lands an out-of-range page number on the last page that exists', async () => {
    // Board issue 139 does not clamp: it publishes the number and leaves the
    // slice to the front that owns it. That division of labour survives the merge
    // deliberately. Normalising the address to the clamp instead was tried and
    // reverted: it is destructive, because the clamp is also how a *filter*
    // change is handled, so rewriting the URL resets the reader's page whenever
    // the new filter is shorter than the page they were on
    // (`issues-pagination.test.tsx` "lands on a valid page when the filter
    // shrinks the list under the reader"). A `?page=99999` link is nonetheless
    // stable — reopening it resolves to the same last page every time.
    session.readOverview.mockResolvedValue(overview(boardOf(120)));
    const container = await openAt('/board?page=99999');
    const [first, last] = pageBounds(3);
    expect(await screen.findByRole('complementary', { name: 'Shared issue list' })).toBeDefined();
    // The drawn rows are the clamped page's rows. The original test asserted
    // only that issue 3 appeared and that the attribute was '99999', so it passed
    // on a tree whose rows had nothing to do with the page.
    expect(drawnRows(container)).toEqual(Array.from({ length: last - first + 1 }, (_, index) => index + first));
    expect(rangeText(container)).toBe(`${first}–${last} of 120`);
    // The attribute now names the page being drawn, not the number that arrived.
    expect(document.querySelector('.workspace')?.getAttribute('data-issue-page')).toBe('3');
    expect(search()).toBe('?page=99999');
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

  it('cancels the browser navigation on every anchor it turned into a link', async () => {
    // The whole SPA-navigation contract rests on `preventDefault` being called,
    // and it was unguarded: deleting it left this file fully green, because jsdom
    // does not follow an `<a href>` on a synthetic click. So the cancellation is
    // asserted directly. `fireEvent.click` returns `dispatchEvent`'s result, which
    // is `false` only when a cancelable event had `preventDefault` called on it —
    // remove the call and this returns `true` and fails.
    await openAt('/board');
    // A default-state anchor, a non-default tab and a non-default filter: three
    // anchors with three different inline handlers, so a `preventDefault` removed
    // from any one of them is caught.
    const anchors = (selector: string): HTMLAnchorElement[] => Array.from(document.querySelectorAll(selector)) as HTMLAnchorElement[];
    const brand = document.querySelector('.brand') as HTMLAnchorElement;
    const tabs = anchors('.main-nav a');
    const filters = anchors('.filters a');
    expect(brand.getAttribute('href')).toBeTruthy();
    expect(tabs).toHaveLength(4);
    expect(filters).toHaveLength(3);
    expect(fireEvent.click(brand)).toBe(false);
    // The filter nav is only rendered on the Issues tab, so it is clicked before
    // the tab changes — a detached node has no listener left to cancel with.
    expect(fireEvent.click(filters[2]!)).toBe(false);
    await waitFor(() => expect(search()).toBe('?filter=all'));
    expect(fireEvent.click(tabs[3]!)).toBe(false);
    // The app state really did move, so the cancellation did not also stop it.
    await waitFor(() => expect(search()).toBe('?view=targets&filter=all'));
  });

  it('keeps the nav anchors natively keyboard-activatable', async () => {
    // Finding 3's secondary claim, checked rather than assumed. `<a href>` is
    // focusable and Enter-activatable in a real browser without any key handler,
    // which is a property the `<button>` it replaced also had — so keyboard
    // reachability is not lost, and the property that guarantees it is the `href`
    // itself. That is assertable here even though the activation is not.
    await openAt('/board');
    const nav = Array.from(document.querySelectorAll('.main-nav a')) as HTMLAnchorElement[];
    expect(nav).toHaveLength(4);
    for (const anchor of nav) {
      // An anchor with no href is not focusable and not Enter-activatable, and
      // would silently have been a div with a click handler.
      expect(anchor.getAttribute('href')).toBeTruthy();
      expect(anchor.getAttribute('role')).toBe('button');
    }
    // No onKeyDown is needed for that, and none is asserted to exist.
    expect(document.querySelector('.main-nav a[href=""]')).toBeNull();
  });

  it('cancels the browser navigation on the shared issue-link handler', async () => {
    // The other three anchors — the issue links on Resources, Targets and Feed —
    // share one exported handler rather than an inline one, so it is checked where
    // it can be: `issueLinkClick` must call `preventDefault` on the event it is
    // given, and open the issue. Dropping the `preventDefault` leaves all three
    // callers navigating, and nothing else in the suite would notice. The issue
    // rows inside the Issues list are `<button>`s, not anchors, so they are not
    // part of this contract.
    let prevented = false;
    const opened: number[] = [];
    issueLinkClick((number) => { opened.push(number); }, 42)({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(opened).toEqual([42]);
    // The event is optional so a static render can drive the handler; with no
    // event it must still open the issue rather than throw.
    expect(issueLinkClick((number) => { opened.push(number); }, 43)()).toBeUndefined();
    expect(opened).toEqual([42, 43]);
  });

  it('replaces the first write and pushes every one after it', async () => {
    // Finding 4. The mode of the first write was unasserted: forcing `push` left
    // every Back and Forward test green, because they all start from a URL whose
    // serialized form is unchanged and so never write at all. The distinction is
    // observable on the history methods themselves.
    const replace = window.history.replaceState.bind(window.history);
    const push = window.history.pushState.bind(window.history);
    const replaced: string[] = [];
    const pushed: string[] = [];
    const replaceSpy = vi.spyOn(window.history, 'replaceState').mockImplementation((data, unused, url) => {
      replaced.push(String(url));
      replace(data, unused, url);
    });
    const pushSpy = vi.spyOn(window.history, 'pushState').mockImplementation((data, unused, url) => {
      pushed.push(String(url));
      push(data, unused, url);
    });

    try {
      // Arriving on a stale URL and having the app clean it up must not leave a
      // dead entry behind Back, so that first write replaces.
      await openAt('/board?view=timeline');
      await waitFor(() => expect(search()).toBe(''));
      expect(replaced).toContain('/board');
      // Nothing was pushed yet: the first write replaced the entry the reader
      // arrived on rather than stacking a second one behind it.
      expect(pushed).toEqual([]);

      await clickTab('feed');
      await waitFor(() => expect(search()).toBe('?view=feed'));
      // Every navigation after the first is a real history entry.
      expect(pushed).toEqual(['/board?view=feed']);

      // And Back therefore returns to the board the reader was on, not to the
      // stale URL they arrived on.
      await goBack();
      await waitFor(() => expect(search()).toBe(''));
      await goForward();
      await waitFor(() => expect(search()).toBe('?view=feed'));
    } finally {
      replaceSpy.mockRestore();
      pushSpy.mockRestore();
    }
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