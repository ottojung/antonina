import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-resources-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-resources-config';

import App from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue, BoardResource } from './model';
import type { BoardOverview, IssueCommentPage } from '../../packages/core/src/api';
import type { BoardAccessState } from '../../packages/core/src/api';
// Board issue 180's All Issues key, so this fixture mirrors what core's store
// writes: the newest comment's time, or null when the issue has no comments.
import { newestCommentAt } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';
import { DEFAULT_ISSUE_PAGE, DEFAULT_RESOURCE_PAGE, parseBoardUrl } from './board-url';
import {
  clampResourcePage,
  ISSUE_PAGE_NEXT,
  ISSUE_PAGE_PREVIOUS,
  RESOURCE_LIST_PAGES_LABEL,
  RESOURCE_PAGE_SIZE,
  resourcePage,
} from './ui-state';

const STAMP = '2026-09-27T12:00:00.000Z';

function issue(number: number, state: 'open' | 'closed' = 'open'): BoardIssue {
  return { number, title: `Issue ${number}`, body: `Body of issue ${number}`, state, createdAt: STAMP, updatedAt: STAMP, messages: [] };
}

/** One registered path protected by `dependents`, on the given host. */
function resource(host: string, path: string, dependents: number[] = [1]): BoardResource {
  return { host, path, issueNumbers: dependents, createdAt: STAMP, updatedAt: STAMP };
}

/**
 * A board of `count` registered paths on one host, path `/registered/NN`, each
 * protected by issue 1. `count` above 100 crosses a page boundary, so the last
 * path is deliberately not page-aligned.
 */
function resourcesOn(host: string, count: number): BoardResource[] {
  return Array.from({ length: count }, (_, index) => resource(host, `/registered/${String(index + 1).padStart(3, '0')}`));
}

let board: BoardIssue[] = [];
let registered: BoardResource[] = [];
let reads = 0;
// The board's write access, so a case can mount the same board read-only. Reset
// to true in `beforeEach` like every other piece of per-test state.
let canEdit = true;

function overview(): BoardOverview {
  reads += 1;
  return {
    boardId: 'board-1',
    head: 'op-' + reads,
    revision: 1,
    deleted: false,
    queue: board.filter((each) => each.state === 'open').map((each) => each.number),
    issues: board.map((each) => ({
      number: each.number,
      title: each.title,
      state: each.state,
      createdAt: each.createdAt,
      updatedAt: each.updatedAt,
      closedAt: each.state === 'closed' ? each.updatedAt : null,
      messageCount: each.messages.length,
      lastActivityAt: newestCommentAt(each.messages),
      hasBody: each.body.length > 0,
    })),
    // The stub holds the whole collection, exactly as `store.readOverview` does:
    // the board's resources live inline in the board state, so the overview
    // carries all of them. This file is about what the view draws, not about
    // bounding that read — see the bounded-read note in ui-state.ts.
    resources: registered,
    targets: [],
    dispatches: [],
  };
}

const addedDependencies: Array<{ host: string; path: string; number: number }> = [];
const removedDependencies: Array<{ host: string; path: string; number: number }> = [];

const session = {
  api: {
    accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit }),
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
    createIssue: async () => issue(1),
    comment: async () => null,
    editIssueBody: async () => null,
    close: async () => undefined,
    reopen: async () => undefined,
    reorderQueue: async (target: number[]) => target,
    addResourceDependency: vi.fn(async (host: string, path: string, number: number) => {
      addedDependencies.push({ host, path, number });
      registered = registered.map((entry) => (entry.host === host && entry.path === path
        ? { ...entry, issueNumbers: [...entry.issueNumbers, number] }
        : entry));
      return resource(host, path);
    }),
    removeResourceDependency: vi.fn(async (host: string, path: string, number: number) => {
      removedDependencies.push({ host, path, number });
      // Production-shaped, from `packages/core/src/operations.ts`: a resource
      // whose last dependency goes is DELETED, not left behind with an empty
      // list. That is the only mutation that can shorten the collection under a
      // reader, which is exactly what the clamp exists for.
      registered = registered.flatMap((entry) => {
        if (entry.host !== host || entry.path !== path) return [entry];
        const issueNumbers = entry.issueNumbers.filter((each) => each !== number);
        return issueNumbers.length === 0 ? [] : [{ ...entry, issueNumbers }];
      });
      return undefined;
    }),
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

/** The resources view, mounted on the Resources tab with whatever URL the test left. */
async function mountResources(): Promise<HTMLElement> {
  // The board must have RENDERED, not merely have called the API: between the two
  // the DOM is still App's loading branch — `<main class="centered">… Loading
  // your shared board…</main>` — which has no tab in it to click. So this waits
  // on the DOM the way the sibling helpers do (`issues-pagination.test.tsx`
  // waits for `.issue-row`; there is no `.issue-row` on this tab yet, so it
  // waits for the loaded board's own nav), and then on the resources it draw.
  // `readsBefore` is what keeps a second mount in one test honest: without it
  // the call count from the FIRST mount is already there, so the wait would be
  // satisfied before the new render had done anything.
  const readsBefore = session.readOverview.mock.calls.length;
  const { container } = render(<App />);
  await waitFor(() => expect(session.readOverview.mock.calls.length).toBeGreaterThan(readsBefore));
  await waitFor(() => expect(container.querySelector('.main-nav')).not.toBeNull());
  if (!container.querySelector('.resources-view')) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'resources' })); });
  }
  await waitFor(() => expect(container.querySelectorAll('.resource-card').length).toBeGreaterThan(0));
  return container;
}

function drawnPaths(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.resource-card')).map((card) => card.querySelector('code')!.textContent ?? '');
}

/** The host headings the view drew, in the order it drew them. */
function drawnHosts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.resource-host h2')).map((heading) => heading.textContent ?? '');
}

function rangeText(container: HTMLElement): string {
  // `.resources-view` is the only container class the Resources tab draws
  // (App.tsx). This selector used to carry a second, singular-prefixed half that
  // named nothing anywhere in the app, which made the helper's reach look wider
  // than it is and left its empty-string answer ambiguous between "the control is
  // absent" and "I looked in the wrong place".
  const range = container.querySelector('.resources-view .issue-page-range');
  return range === null ? '' : (range.textContent ?? '');
}

function pagination(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.resources-view .issue-pagination');
}

/** The controls of the page currently drawn; there is at most one run of them. */
function controls(): HTMLElement {
  return document.querySelector('.resources-view .issue-pagination') as HTMLElement;
}

function nextButton(): HTMLButtonElement {
  return within(controls()).getByRole('button', { name: ISSUE_PAGE_NEXT });
}

function previousButton(): HTMLButtonElement {
  return within(controls()).getByRole('button', { name: ISSUE_PAGE_PREVIOUS });
}

async function goNext(): Promise<void> {
  await act(async () => { fireEvent.click(nextButton()); });
}

async function goPrevious(): Promise<void> {
  await act(async () => { fireEvent.click(previousButton()); });
}

beforeEach(() => {
  window.localStorage.clear();
  // Every test starts from the board's own opening URL, so one test's paging is
  // never the next test's starting page: the Resources page number is addressable
  // UI state, so a mount reads it out of `window.location.search`.
  window.history.replaceState(null, '', '/');
  board = [issue(1), issue(2), issue(3)];
  registered = [];
  reads = 0;
  canEdit = true;
  addedDependencies.length = 0;
  removedDependencies.length = 0;
  session.api.addResourceDependency.mockClear();
  session.api.removeResourceDependency.mockClear();
  session.readOverview.mockClear();
  session.hasCredential.mockReturnValue(true);
});

afterEach(cleanup);

describe('resource paging arithmetic', () => {
  it('holds 50 resources a page and pages the board\'s own resource order', () => {
    expect(RESOURCE_PAGE_SIZE).toBe(50);
    // There is no resource-scoped page-count helper to assert against, on
    // purpose: the drawn boundary is asserted below instead, against the DOM —
    // "50 rows, Next live, range 1–50 of 126" is what a reader can check, and
    // the arithmetic behind it is the Issues list's `issuePageCount`, tested in
    // `issues-pagination.test.tsx`.
    const resources = resourcesOn('lubko://one', 126);
    expect(resourcePage(resources, 1)).toEqual(resources.slice(0, 50));
    expect(resourcePage(resources, 2)).toEqual(resources.slice(50, 100));
    expect(resourcePage(resources, 3)).toHaveLength(26);
    // Pagination is a window onto the board's order, never a re-sort of it: the
    // concatenation of the pages is the whole collection, in order.
    expect([1, 2, 3].flatMap((page) => resourcePage(resources, page))).toEqual(resources);
    expect(clampResourcePage(3, 126)).toBe(3);
    // Out of range moves down onto the last page that exists, and a page number
    // that was never one is page 1 — the same rule the Issues list uses.
    expect(clampResourcePage(9, 126)).toBe(3);
    expect(clampResourcePage(0, 126)).toBe(1);
    expect(clampResourcePage(1.5, 126)).toBe(1);

    // The clamp is `resourcePage`'s own, not a courtesy to the caller. The
    // collection shortens under the reader — a dependency is removed, the board
    // is re-read — while the address still names a page that no longer exists,
    // and `resourcePage` itself must then land the reader on the last page that
    // does rather than slicing past the end into an empty window. Slicing on the
    // raw page instead would draw nothing at all for `resources` of 9, and would
    // draw the wrong window for 1.5.
    expect(resourcePage(resources, 9)).toEqual(resources.slice(100, 126));
    expect(resourcePage(resources, 4)).toEqual(resources.slice(100, 126));
    expect(resourcePage(resources, 0)).toEqual(resources.slice(0, 50));
    expect(resourcePage(resources, 1.5)).toEqual(resources.slice(0, 50));
    // Same rule against a collection that has already been emptied: page 1 of
    // nothing is nothing, and no page number invents rows out of it.
    expect(resourcePage([], 3)).toEqual([]);
  });

  it('reads the page number out of the address, and leaves the other page fields alone', () => {
    // The reading half only. The writing half is `boardUrlFor`/`boardSearch`,
    // and it is asserted against this same field in `board-url.test.ts`; naming a
    // write here that the body does not perform is how an assertion goes missing.
    expect(parseBoardUrl('?view=resources&resources=3').resourcePage).toBe(3);
    expect(parseBoardUrl('?view=resources').resourcePage).toBe(DEFAULT_RESOURCE_PAGE);
    // A value that is not a positive integer is page 1, like every other page
    // field: a stale or hand-edited link lands on a usable screen.
    expect(parseBoardUrl('?resources=0').resourcePage).toBe(DEFAULT_RESOURCE_PAGE);
    expect(parseBoardUrl('?resources=-2').resourcePage).toBe(DEFAULT_RESOURCE_PAGE);
    expect(parseBoardUrl('?resources=two').resourcePage).toBe(DEFAULT_RESOURCE_PAGE);
    // Paging Resources says nothing about the Issues list's own page.
    expect(parseBoardUrl('?page=2&resources=3').page).toBe(2);
    expect(parseBoardUrl('?resources=3').page).toBe(1);
  });
});

describe('the resources view, paginated', () => {
  it('draws one page of the collection and not the whole of it', async () => {
    registered = resourcesOn('lubko://one', 126);
    const container = await mountResources();

    expect(drawnPaths(container)).toHaveLength(RESOURCE_PAGE_SIZE);
    expect(drawnPaths(container)).toEqual(registered.slice(0, 50).map((each) => each.path));
    expect(rangeText(container)).toBe('1–50 of 126');
    expect(previousButton().disabled).toBe(true);
    expect(nextButton().disabled).toBe(false);
    // The controls announce what they page, so this run of pages is not mistaken
    // for the Issues list's own.
    expect(controls().getAttribute('aria-label')).toBe(RESOURCE_LIST_PAGES_LABEL);
  });

  it('walks forwards and backwards, with Previous and Next disabled at their own ends', async () => {
    registered = resourcesOn('lubko://one', 126);
    const container = await mountResources();

    await goNext();
    expect(drawnPaths(container)).toEqual(registered.slice(50, 100).map((each) => each.path));
    expect(rangeText(container)).toBe('51–100 of 126');
    expect(previousButton().disabled).toBe(false);
    expect(nextButton().disabled).toBe(false);

    await goNext();
    expect(drawnPaths(container)).toEqual(registered.slice(100).map((each) => each.path));
    expect(rangeText(container)).toBe('101–126 of 126');
    // The end of the collection is the end of the controls, not a wrap-around.
    expect(nextButton().disabled).toBe(true);
    expect(drawnPaths(container)).toHaveLength(26);

    await goPrevious();
    expect(rangeText(container)).toBe('51–100 of 126');
    await goPrevious();
    expect(rangeText(container)).toBe('1–50 of 126');
    expect(previousButton().disabled).toBe(true);
  });

  it('gives no controls at all to a collection that fits on one page', async () => {
    registered = resourcesOn('lubko://one', 50);
    const container = await mountResources();

    expect(drawnPaths(container)).toHaveLength(50);
    expect(pagination(container)).toBeNull();
    // No range assertion here: with no controls there is no `.issue-page-range`
    // at all, and `rangeText` answers "absent" as `''`, so `toBe('')` would pass
    // on the helper's default rather than on anything the view drew.
  });

  it('keeps the page state in the URL, so it survives a reload', async () => {
    registered = resourcesOn('lubko://one', 126);
    const container = await mountResources();
    await goNext();

    // The address names the page, so a reload — or a copied link — opens the page
    // the reader was on rather than the first one.
    expect(window.location.search).toContain('resources=2');
    expect(window.location.search).toContain('view=resources');

    cleanup();
    const reloaded = await mountResources();
    expect(rangeText(reloaded)).toBe('51–100 of 126');
    expect(drawnPaths(reloaded)).toEqual(registered.slice(50, 100).map((each) => each.path));
    expect(nextButton().disabled).toBe(false);

    // A shared link is the same thing: a URL naming page 3 opens page 3.
    cleanup();
    window.history.replaceState(null, '', '/?view=resources&resources=3');
    const linked = await mountResources();
    expect(rangeText(linked)).toBe('101–126 of 126');
    expect(nextButton().disabled).toBe(true);
    // No container-identity assertion here: `container` and `linked` are two
    // different `render()` roots by construction, so `not.toBe` is true before
    // the view is asked to do anything and cannot fail if it regresses. What
    // proves the third mount is a fresh read of the address is the range line
    // and the disabled boundary above.
  });

  it('pages a read-only board exactly as an editable one, and draws the callout instead of the write controls', async () => {
    // Both arms of one case, deliberately in one `it`: paging is a window onto
    // what the browser already holds and is not a write, so the page, its
    // position line and its boundaries must not depend on whether the reader may
    // commit anything. Only the write affordances do. Running both here is what
    // keeps that claim honest — the access-conditional branches of `ResourcesView`
    // (App.tsx: `access === 'editable' && …` for the register form, the
    // add-dependency form and the remove control, against the `access-callout`)
    // were otherwise reachable by no test in this file at all.
    for (const editable of [true, false]) {
      canEdit = editable;
      registered = resourcesOn('lubko://one', 126);
      window.history.replaceState(null, '', '/?view=resources');
      const container = await mountResources();

      expect(rangeText(container)).toBe('1–50 of 126');
      expect(drawnPaths(container)).toEqual(registered.slice(0, 50).map((each) => each.path));
      expect(previousButton().disabled).toBe(true);
      expect(nextButton().disabled).toBe(false);

      await goNext();
      expect(rangeText(container)).toBe('51–100 of 126');
      expect(drawnPaths(container)).toEqual(registered.slice(50, 100).map((each) => each.path));
      expect(previousButton().disabled).toBe(false);
      expect(nextButton().disabled).toBe(false);

      // The read link to a dependency is not a write, so the chips and their
      // state labels are drawn either way; the per-dependency remove button,
      // the add-dependency form and the register form are writes.
      const card = container.querySelector('.resource-card') as HTMLElement;
      expect(within(card).getByRole('button', { name: /#1 Issue 1/ })).toBeDefined();
      expect(card.querySelector('.state-label.open')).not.toBeNull();
      if (editable) {
        expect(card.querySelector('.dependency-add')).not.toBeNull();
        expect(within(card).getByRole('button', { name: 'Remove issue 1' })).toBeDefined();
        expect(container.querySelector('.resource-form')).not.toBeNull();
        expect(container.querySelector('.resources-view .access-callout')).toBeNull();
      } else {
        expect(card.querySelector('.dependency-add')).toBeNull();
        expect(within(card).queryByRole('button', { name: 'Remove issue 1' })).toBeNull();
        expect(container.querySelector('.resource-form')).toBeNull();
        // Scoped to `.resources-view`: the Issues pane draws its own callout at
        // the same class, so an unscoped selector would pass on the wrong tab.
        expect(container.querySelector('.resources-view .access-callout')).not.toBeNull();
      }

      cleanup();
    }
  });

  it('clamps an out-of-range page from the address onto the last page that exists', async () => {
    registered = resourcesOn('lubko://one', 126);
    window.history.replaceState(null, '', '/?view=resources&resources=9');
    const container = await mountResources();

    expect(rangeText(container)).toBe('101–126 of 126');
    expect(drawnPaths(container)).toHaveLength(26);
    expect(nextButton().disabled).toBe(true);
  });

  it('does not renumber the Issues list when Resources is paged', async () => {
    board = Array.from({ length: 120 }, (_, index) => issue(index + 1));
    registered = resourcesOn('lubko://one', 126);
    const container = await mountResources();
    await goNext();
    expect(window.location.search).toContain('resources=2');
    // Exactly, not by substring: `not.toContain('page=2')` also matches
    // `page=20`, so it would pass on a renumbered Issues list. The parsed field
    // is the claim "the Issues list's page is untouched".
    expect(parseBoardUrl(window.location.search).page).toBe(DEFAULT_ISSUE_PAGE);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'issues' })); });
    // A tab change returns both lists to their first page, which is what the tab
    // link itself advertises.
    expect(window.location.search).not.toContain('resources=');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Open/ })); });
    expect(container.querySelectorAll('.issue-row')).toHaveLength(50);
  });
});

describe('grouping and dependency controls while paged', () => {
  it('still groups the page by host and sorts hosts and paths', async () => {
    // PRODUCTION-SHAPED, which the old fixture here was not: it emitted 40
    // `lubko://zulu` and then 40 `lubko://alpha`, a host-descending order no real
    // board can hold, because `packages/core/src/operations.ts` re-sorts the
    // whole collection by host then path on every add. So this is the order that
    // sort produces — all of alpha, then all of zulu — and the page boundary at
    // index 50 therefore falls INSIDE `lubko://zulu`, which is where a boundary
    // almost always falls in practice and is the case worth testing: the host
    // heading repeats across the two pages instead of each host sitting neatly
    // on one page.
    registered = [
      ...Array.from({ length: 30 }, (_, index) => resource('lubko://alpha', `/alpha/${String(index + 1).padStart(2, '0')}`)),
      ...Array.from({ length: 60 }, (_, index) => resource('lubko://zulu', `/zulu/${String(index + 1).padStart(2, '0')}`)),
    ];
    const container = await mountResources();

    // Grouping runs on the page, exactly as it ran on the whole board: page 1
    // straddles the two hosts, so it draws two sections in host order.
    expect(drawnHosts(container)).toEqual(['lubko://alpha', 'lubko://zulu']);
    expect(drawnPaths(container)).toHaveLength(RESOURCE_PAGE_SIZE);
    expect(drawnPaths(container)).toEqual([
      ...Array.from({ length: 30 }, (_, index) => `/alpha/${String(index + 1).padStart(2, '0')}`),
      ...Array.from({ length: 20 }, (_, index) => `/zulu/${String(index + 1).padStart(2, '0')}`),
    ]);

    // Page 2 continues INSIDE the second host, so zulu's resources appear on both
    // pages rather than being pulled onto one of them, and the heading repeats.
    await goNext();
    expect(drawnHosts(container)).toEqual(['lubko://zulu']);
    expect(drawnPaths(container)).toEqual(Array.from({ length: 40 }, (_, index) => `/zulu/${String(index + 21).padStart(2, '0')}`));
    // Two pages of this collection and no third, so the straddle is the whole
    // story rather than a corner of a longer list.
    expect(nextButton().disabled).toBe(true);
  });

  it('keeps the dependency chips, their states and their remove control working on a page', async () => {
    registered = resourcesOn('lubko://one', 126);
    const container = await mountResources();

    const card = container.querySelector('.resource-card') as HTMLElement;
    const path = card.querySelector('code')?.textContent ?? '';
    // Every dependency control is the one it was before paging: the chip links to
    // its issue, carries the issue's state, and can be removed.
    expect(within(card).getByRole('button', { name: /#1 Issue 1/ })).toBeDefined();
    expect(card.querySelector('.state-label.open')).not.toBeNull();
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Remove issue 1' })); });

    expect(removedDependencies).toEqual([{ host: 'lubko://one', path, number: 1 }]);
    // The write went through the same commit path as any other, so the board is
    // re-read and the page it lands on is a page of the board as it now is. The
    // card's issue 1 was the resource's only dependency, so production deletes
    // the resource and the collection is one shorter — page 1 is still page 1.
    await waitFor(() => expect(session.readOverview.mock.calls.length).toBeGreaterThan(1));
    expect(rangeText(container)).toBe('1–50 of 125');
    expect(drawnPaths(container)).toHaveLength(RESOURCE_PAGE_SIZE);
    expect(drawnPaths(container)).not.toContain(path);
  });

  it('clamps down when a removal shortens the collection past the page being read', async () => {
    // 101 resources on the URL's page 3, which holds exactly one card: the last
    // one. Removing its only dependency deletes it (production shape, above), so
    // the collection becomes 100 and the page the reader is on no longer exists.
    registered = resourcesOn('lubko://one', 101);
    window.history.replaceState(null, '', '/?view=resources&resources=3');
    const container = await mountResources();
    expect(rangeText(container)).toBe('101–101 of 101');

    const card = container.querySelector('.resource-card') as HTMLElement;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Remove issue 1' })); });
    await waitFor(() => expect(session.readOverview.mock.calls.length).toBeGreaterThan(1));

    // Out of range moves DOWN onto the last page that exists, and the view stays
    // coherent about it: page 2 of a 100-resource collection, fully drawn, with
    // the boundaries disabled at their own ends.
    expect(rangeText(container)).toBe('51–100 of 100');
    expect(drawnPaths(container)).toHaveLength(RESOURCE_PAGE_SIZE);
    expect(drawnPaths(container)).toEqual(resourcesOn('lubko://one', 100).slice(50, 100).map((each) => each.path));
    expect(nextButton().disabled).toBe(true);
    expect(previousButton().disabled).toBe(false);
  });

  it('keeps the add-dependency form and the register form working on a page', async () => {
    registered = resourcesOn('lubko://one', 126);
    const container = await mountResources();

    // The add-dependency form is offered on every drawn card, over the whole
    // issue set and not the page's — paging changed what is drawn, not what a
    // dependency means.
    const card = container.querySelector('.resource-card') as HTMLElement;
    const addForm = card.querySelector('.dependency-add') as HTMLElement;
    const options = within(addForm).getAllByRole('option').map((option) => option.textContent ?? '');
    expect(options).toEqual(['Add open issue dependency…', '#2 Issue 2', '#3 Issue 3']);

    await act(async () => {
      fireEvent.change(within(addForm).getByRole('combobox'), { target: { value: '2' } });
      fireEvent.click(within(addForm).getByRole('button', { name: 'Add' }));
    });
    const path = card.querySelector('code')?.textContent ?? '';
    expect(addedDependencies).toEqual([{ host: 'lubko://one', path, number: 2 }]);

    // The register form at the top of the tab is untouched by paging.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Lubko host'), { target: { value: 'lubko://one' } });
      fireEvent.change(screen.getByLabelText('Absolute path'), { target: { value: '/registered/fresh' } });
      fireEvent.change(screen.getByLabelText('Open issue'), { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add dependency' }));
    });
    expect(addedDependencies[1]).toEqual({ host: 'lubko://one', path: '/registered/fresh', number: 3 });
  });

  it('follows a dependency chip to its issue and keeps the Resources page', async () => {
    registered = resourcesOn('lubko://one', 126);
    const container = await mountResources();
    await goNext();

    const card = container.querySelector('.resource-card') as HTMLElement;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: /#1 Issue 1/ })); });

    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();
    // Opening an issue is not a tab change, so the Resources page survives it:
    // the Issues list keeps its own page behind a thread for the same reason.
    expect(window.location.search).toContain('resources=2');
    // A real tab change returns both lists to their first page, which is what
    // the tab's own href advertises.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'resources' })); });
    expect(rangeText(container)).toBe('1–50 of 126');
  });
});
