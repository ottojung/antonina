import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The session `App` is given is a hand-built stub and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, the real `trust.json` or the real `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-app-mount-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-app-mount-config';

import App from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedEntry, type BoardFeedEntryKind, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { Board, BoardIssue } from './model';
import { BOARD_SCHEMA_VERSION } from '../../packages/core/src/model';
import type { VerifiedBoardState } from '../../packages/core/src/operations';
import type { BoardAccessState } from '../../packages/core/src/api';
import type { BrowserBoardSession } from './api';

const STAMP = '2026-09-27T12:00:00.000Z';

/**
 * `App` mounted for real.
 *
 * `App` reads `window.localStorage` on its first render and reads the board
 * from a session in an effect, so before board issue 72 it could not be mounted
 * anywhere in this suite: under the `node` environment `window` did not exist,
 * and the file that "covered" the shell (`feed-tab.test.tsx`) asserted against
 * the *source text* of `App.tsx` instead. A broken import, a renamed prop, a
 * provider-order mistake or a throw in a render all passed that suite.
 *
 * The one thing stubbed is the session factory. `App` builds its own session
 * with `createBrowserBoardApi()`, so the factory is the only seam that lets a
 * test hand the shell a board without a browser, a trust anchor and a signed
 * log. Everything downstream of it — the load effect, the tab state, the queue,
 * the error and first-run paths, the feed tab — is the production component
 * tree, mounted.
 */
const session = {
  api: { accessState: (): BoardAccessState => ({ boardId: 'board-1', keyId: null, rootKeyId: 'root-1', capabilities: [], credentialRejection: null, storageRejected: false, canEdit: false }) },
  readState: vi.fn<() => Promise<VerifiedBoardState | null>>(),
  hasCredential: vi.fn(() => false),
  readFeed: vi.fn<(request?: BoardFeedRequest) => Promise<BoardFeedPage>>(),
  trust: vi.fn(),
  initialize: vi.fn(),
  enableEditing: vi.fn(),
  clearCredential: vi.fn(),
  credentialText: vi.fn(() => null),
  trustAnchorText: vi.fn(() => null),
};

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    // Only the factory is replaced. Everything else the module exports — the
    // projection helpers `App` also imports — is the real implementation, so
    // the mounted tree is the production one and not a reconstruction.
    createBrowserBoardApi: () => session as unknown as BrowserBoardSession,
  };
});

function issue(number: number, overrides: Partial<BoardIssue> = {}): BoardIssue {
  return { number, title: `Issue ${number}`, body: `Body of issue ${number}`, state: 'open', createdAt: STAMP, updatedAt: STAMP, messages: [], ...overrides };
}

function board(issues: BoardIssue[]): Board {
  return { schemaVersion: BOARD_SCHEMA_VERSION, nextIssueNumber: issues.length + 1, issues, resources: [], targets: [], dispatches: [] };
}

function state(issues: BoardIssue[]): VerifiedBoardState {
  // `migration` is required on VerifiedBoardState since board issue 73 made the
  // migration gate mandatory, so a fixture that omits it no longer type-checks.
  // A current-format board persists at the current version and steps through
  // nothing, which is what the real gate reports for it.
  return { board: board(issues), queue: issues.filter((each) => each.state === 'open').map((each) => each.number), authorities: [], deleted: false, head: 'op-1', migration: { persistedVersion: BOARD_SCHEMA_VERSION, throughVersions: [] } };
}

let sequence = 0;
function feedEntry(kind: BoardFeedEntryKind, issueNumber: number, overrides: Partial<BoardFeedEntry> = {}): BoardFeedEntry {
  sequence += 1;
  return { id: `op-${sequence}`, kind, at: STAMP, position: 100 - sequence, issueNumber, title: `Issue ${issueNumber}`, state: 'open', messageId: null, author: null, body: null, ...overrides };
}

function feedPage(entries: BoardFeedEntry[], nextCursor: string | null = null): BoardFeedPage {
  return { entries, nextCursor, total: entries.length, limit: DEFAULT_FEED_LIMIT };
}

async function mountApp(): Promise<HTMLElement> {
  const { container } = render(<App />);
  expect(container.isConnected).toBe(true);
  await waitFor(() => expect(session.readState).toHaveBeenCalled());
  return container;
}

beforeEach(() => {
  window.localStorage.clear();
  session.readState.mockReset();
  session.readFeed.mockReset();
  session.readFeed.mockResolvedValue(feedPage([]));
  session.readState.mockResolvedValue(state([issue(1), issue(2, { state: 'closed' })]));
});

afterEach(cleanup);

describe('the board app, mounted', () => {
  it('shows the loading copy, then the shell with the board it read', async () => {
    // Two renders, both real: the first is the `loading` load the app starts in
    // and no test could ever have asserted it before, because it is a component
    // state and not a helper return value.
    const { container } = render(<App />);
    expect(container.querySelector('.loading-dot')).not.toBeNull();
    expect(container.textContent).toContain('Loading your shared board');

    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeDefined();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(Array.from(nav.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['issues', 'resources', 'feed', 'targets']);
    // The verified read, not a fixture: the issue the board reported is on
    // screen, the closed one is behind the Open filter, and the access pill
    // says what this browser may do.
    expect(screen.getByText('Issue 1')).toBeDefined();
    expect(screen.queryByText('Issue 2')).toBeNull();
    expect(container.querySelector('.access-pill')?.textContent).toContain('Read only');
    expect(document.body.contains(container)).toBe(true);
  });

  it('mounts the feed tab inside the shell and renders the page it read', async () => {
    // The wiring the old source-text test only claimed: the feed is a real
    // child of the real shell, reached by a real click, and the read it makes
    // goes through the session's own bound `readFeed`.
    const entries = [feedEntry('issue-created', 1), feedEntry('comment-added', 1, { author: 'Lubko', body: 'on it' })];
    session.readFeed.mockResolvedValue(feedPage(entries, 'v1.next'));

    const container = await mountApp();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'feed' })); });

    expect(await screen.findByText('commented by Lubko: on it')).toBeDefined();
    expect(container.querySelector('.feed-view-inner')).not.toBeNull();
    expect(session.readFeed).toHaveBeenCalledWith({ limit: DEFAULT_FEED_LIMIT });
    // The issue pane is the feed pane, not the list pane: the tab really moved.
    expect(screen.getByRole('complementary', { name: 'Board activity feed' })).toBeDefined();
    expect(screen.queryByRole('complementary', { name: 'Shared issue list' })).toBeNull();
  });

  it('reports a read that failed as the app own error, with a way to retry', async () => {
    // A realistic failure: the browser cannot read the board at all. The shell
    // must say so in its own words, with the backend's reason attached, and must
    // not present an empty board that looks like a board with nothing on it.
    session.readState.mockRejectedValue(new Error('the board log is not readable from this browser'));

    await mountApp();

    const heading = await screen.findByRole('heading', { name: 'The board could not be loaded' });
    expect(heading).toBeDefined();
    expect(document.body.textContent).toContain('the board log is not readable from this browser');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
  });

  it('offers first run, not an error, when there is no board yet', async () => {
    // The other realistic failure, and the one a broken import or a bad prop
    // would most plausibly turn into a crash or a blank page.
    session.readState.mockResolvedValue(null);

    await mountApp();

    expect(await screen.findByRole('heading', { name: 'No Antonina board yet' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Initialize board' })).toBeDefined();
  });

  it('opens an issue thread through the list, in the order the board committed', async () => {
    // The queue order the board reported is the order rendered, and a click on
    // a row selects that issue's thread — a round trip through the shell's own
    // state that no extracted helper can demonstrate.
    const container = await mountApp();
    const rows = Array.from(container.querySelectorAll('.issue-row'));
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-issue')).toBe('1');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Issue 1/ })); });

    expect(await screen.findByRole('heading', { name: 'Issue 1' })).toBeDefined();
    expect(screen.getByText('Body of issue 1')).toBeDefined();
    expect(container.querySelector('.workspace')?.className).toContain('has-selection');
  });

  it('a render-time throw in the mounted tree reaches the test instead of passing quietly', () => {
    // This is the property the whole move buys, stated as an assertion about the
    // harness rather than about the app: with a DOM environment a component is
    // really rendered, so a throw during that render propagates out of the
    // mount. Under the `node` environment no component rendered anywhere, so
    // there was nothing to throw.
    function Throws(): never { throw new Error('render-time failure'); }

    expect(() => render(<Throws />)).toThrow('render-time failure');
  });
});
