import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// Every page handed to the view is a plain object and the XDG roots are pointed
// at paths that cannot exist, so no code under test can reach the real
// `$XDG_STATE_HOME`, `trust.json` or `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-feed-mount-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-feed-mount-config';

import { FeedView } from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedEntry, type BoardFeedEntryKind, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue } from './model';
import { FEED_EMPTY } from './ui-state';

afterEach(cleanup);

/**
 * `FeedView` mounted for real, in a real document, with real effects.
 *
 * `feed-tab.test.tsx` renders `FeedThread` — the presentational half — through
 * `renderToStaticMarkup`, which cannot run an effect, cannot await a read and
 * cannot be clicked. The container around it owns the read cadence: it reads on
 * open, again on every verified board read, and again when the reader asks for
 * the next page. None of that is observable without a mounted component, so it
 * is mounted here.
 */
const STAMP = '2026-09-27T12:00:00.000Z';

let sequence = 0;
function entry(kind: BoardFeedEntryKind, issueNumber: number, overrides: Partial<BoardFeedEntry> = {}): BoardFeedEntry {
  sequence += 1;
  return { id: `op-${sequence}`, kind, at: STAMP, position: 100 - sequence, issueNumber, title: `Issue ${issueNumber}`, state: 'open', messageId: null, author: null, body: null, ...overrides };
}

function issue(number: number): BoardIssue {
  return { number, title: `Issue ${number}`, body: '', state: 'open', createdAt: STAMP, updatedAt: STAMP, messages: [] };
}

function page(entries: BoardFeedEntry[], nextCursor: string | null, total = entries.length): BoardFeedPage {
  return { entries, nextCursor, total, limit: DEFAULT_FEED_LIMIT };
}

/** A read that answers each request from a queue of pages, in order. */
function reader(pages: BoardFeedPage[]): { read: (request?: BoardFeedRequest) => Promise<BoardFeedPage>; seen: BoardFeedRequest[] } {
  const seen: BoardFeedRequest[] = [];
  const read = async (request: BoardFeedRequest = {}) => {
    seen.push(request);
    const next = pages[seen.length - 1];
    if (!next) throw new Error('the test asked for a page it did not stage');
    return next;
  };
  return { read, seen };
}

/**
 * A fake log served the way the real projection serves one: `total` counts the
 * log and the entries handed back are those after the cursor, newest first, up to
 * the requested limit, with a token while entries remain behind them.
 *
 * `reader` above replays a staged list, which is right for a test that wants to
 * hand the view exact pages. This one is right for a test about paging, because
 * the numbered reader asks for the newest page first to learn the log's total and
 * then steps the cursor — a staged list would have to be written twice over for
 * every page it lands on.
 */
function logFeed(total: number, kind: BoardFeedEntryKind = 'issue-created', from = 1) {
  const seen: BoardFeedRequest[] = [];
  // The entries are built with their POSITION as both id and order, so the fake
  // log is stable across reads: a cursor then means what the real projection's
  // means, and two reads of the same page return the same rows.
  const ordered = Array.from({ length: total }, (_, index) => ({
    id: `log-${index + 1}`,
    kind,
    at: STAMP,
    position: index + 1,
    issueNumber: from + index,
    title: `Issue ${from + index}`,
    state: 'open' as const,
    messageId: null,
    author: null,
    body: null,
  }));
  const read = async (request: BoardFeedRequest = {}) => {
    seen.push(request);
    const limit = request.limit ?? DEFAULT_FEED_LIMIT;
    const position = request.cursor === undefined || request.cursor === null ? null : Number(String(request.cursor).replace('v1.', ''));
    // Newest first, and everything committed before the cursor when one is given.
    const remaining = position === null ? [...ordered].reverse() : ordered.filter((each) => each.position < position).reverse();
    const entries = remaining.slice(0, limit);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: remaining.length > entries.length && last !== undefined ? `v1.${last.position}` : null, total: ordered.length, limit };
  };
  return { read, seen };
}

function mount(read: (request?: BoardFeedRequest) => Promise<BoardFeedPage>, overrides: { generation?: number; issues?: BoardIssue[]; page?: number; onPage?: (page: number) => void } = {}) {
  return render(<FeedView
    readFeed={read}
    issues={overrides.issues ?? [issue(1)]}
    generation={overrides.generation ?? 0}
    page={overrides.page ?? 1}
    onPage={overrides.onPage ?? (() => {})}
    onOpenIssue={() => {}}
  />);
}

describe('the feed container, mounted', () => {
  it('reads the first page on open and renders the entries into the document', async () => {
    // The whole read path, mounted: the effect ran, the awaited read resolved,
    // and the result is in the live document rather than in a returned element
    // tree. Under the old `node` environment this assertion could not be made
    // at all, because the effect never ran anywhere in the suite.
    const entries = [entry('issue-created', 1), entry('comment-added', 2, { author: 'Lubko', body: 'on it' })];
    const { read, seen } = reader([page(entries, 'v1.next')]);

    const { container } = mount(read);
    // Nothing has been read yet, so no entry is on screen: the list is drawn
    // empty and the read is in flight. (The list element itself is always
    // rendered — only its entries arrive with the page.)
    expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(0);

    expect(await screen.findByText('commented by Lubko: on it')).toBeDefined();
    expect(container.isConnected).toBe(true);
    expect(document.body.contains(container)).toBe(true);
    // The browser asked for the projection's own default page, not one of its
    // own, and the entries are in the order the projection returned them.
    expect(seen).toEqual([{ limit: DEFAULT_FEED_LIMIT }]);
    const rows = Array.from(container.querySelectorAll('[data-feed-id]')).map((row) => row.getAttribute('data-feed-id'));
    expect(rows).toEqual(entries.map((each) => each.id));
  });

  it('surfaces a failed read as the application own error, carrying the backend reason', async () => {
    // The defect the issue names: a container that swallowed a read failure
    // would show nothing at all, and a reader could not tell a failed read from
    // a board that has never recorded anything. The error the backend gave is
    // the only thing that separates them, so it must reach the document.
    const read = vi.fn(async () => { throw new Error('the board log is not readable from this browser'); });

    mount(read);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('the board log is not readable from this browser');
    expect(screen.queryByRole('navigation', { name: 'Board feed pages' })).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not claim the board is empty when a read fails', async () => {
    // Board issue 100. A failed read leaves the entries empty and the load
    // finished, so deciding the empty state from `entries` and `loading` alone
    // showed the reader "No activity recorded yet" beside the failure. The
    // backend's own reason is the only thing that distinguishes a read that
    // failed from a board that has never recorded anything, so the error stands
    // alone: the empty state is absent, not beside it.
    const read = vi.fn(async () => { throw new Error('the board log is not readable from this browser'); });

    const { container } = mount(read);
    await screen.findByRole('alert');

    expect(container.querySelector('.empty-state')).toBeNull();
    expect(screen.queryByText(FEED_EMPTY.title)).toBeNull();
  });

  it('shows one page and never a merge of the pages behind it', async () => {
    // The defect board 173 names. A reader who moves from page 1 to page 2 must
    // be left with 50 rows on screen, not 110: the container hands the view the
    // page it read and nothing accumulates across it.
    const { read, seen } = logFeed(60);

    const { container, rerender } = mount(read, { page: 1 });
    await screen.findByRole('list', { name: 'Board activity, newest first' });
    await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(50));
    const firstPage = Array.from(container.querySelectorAll('[data-feed-id]')).map((row) => row.getAttribute('data-feed-id'));
    seen.length = 0;

    await act(async () => { rerender(<FeedView readFeed={read} issues={[issue(1)]} generation={0} page={2} onPage={() => {}} onOpenIssue={() => {}} />); });

    await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(10));
    // Page 2 was reached by asking for the cursor the newest page returned, and
    // the page on screen is page 2 alone.
    // Only the two reads page 2 needed: the newest page for the log's total, then
    // one cursor step. The open of page 1 is not counted here.
    expect(seen).toEqual([{ limit: DEFAULT_FEED_LIMIT }, { limit: DEFAULT_FEED_LIMIT, cursor: 'v1.11' }]);
    // The rows of page 1 are gone from the document, not merely pushed down it:
    // this is the assertion the accumulator model could not have passed.
    const drawn = Array.from(container.querySelectorAll('[data-feed-id]')).map((row) => row.getAttribute('data-feed-id'));
    for (const gone of firstPage) expect(drawn).not.toContain(gone);
  });

  it('offers numbered boundaries with the right disabled edges, and reports the range', async () => {
    const { read, seen } = logFeed(120);

    const { container } = mount(read, { page: 1 });
    await screen.findByRole('list', { name: 'Board activity, newest first' });

    const nav = screen.getByRole('navigation', { name: 'Board feed pages' });
    const [previous, next] = within(nav).getAllByRole('button');
    expect(previous.hasAttribute('disabled')).toBe(true);
    expect(next.hasAttribute('disabled')).toBe(false);
    // Range and count text, both about the log rather than about what has been read.
    expect(within(nav).getByRole('status').textContent).toBe('1–50 of 120');
    expect(container.querySelector('.feed-count')?.textContent).toBe('50 of 120 recorded entries');

    // Next is live, Previous is not: the middle of the log.
    expect(seen).toHaveLength(1);
  });

  it('clamps a page the log cannot fill down onto the last one that it can', async () => {
    // A hand-edited or stale link must land on something real rather than on a
    // blank tab, and must not walk ninety-nine pages to discover that.
    const { read, seen } = logFeed(120);

    const { container } = mount(read, { page: 99 });

    await waitFor(() => expect(container.querySelectorAll('.feed-entry')).toHaveLength(20));
    expect(within(screen.getByRole('navigation', { name: 'Board feed pages' })).getByRole('status').textContent).toBe('101–120 of 120');
    // Clamped before the walk: the newest page for the total, then two steps.
    expect(seen).toEqual([
      { limit: DEFAULT_FEED_LIMIT },
      { limit: DEFAULT_FEED_LIMIT, cursor: 'v1.71' },
      { limit: DEFAULT_FEED_LIMIT, cursor: 'v1.21' },
    ]);
  });

  it('hands the page control the neighbour page number, and nothing else', async () => {
    const { read } = logFeed(400);
    const onPage = vi.fn();

    const { container } = mount(read, { page: 2, onPage });
    await screen.findByRole('list', { name: 'Board activity, newest first' });

    const nav = screen.getByRole('navigation', { name: 'Board feed pages' });
    const [previous, next] = within(nav).getAllByRole('button');
    await act(async () => { fireEvent.click(previous); });
    await act(async () => { fireEvent.click(next); });

    expect(onPage.mock.calls).toEqual([[1], [3]]);
    // The control moves the number; it does not read anything itself.
    expect(container.querySelectorAll('.feed-entry')).toHaveLength(50);
    expect(container.querySelectorAll('.feed-entry')).toHaveLength(50);
  });

  it('re-reads when a verified board read bumps the generation', async () => {
    // The cadence the container owns: one read on open and one more per
    // generation, with the newest page replacing the one it holds rather than
    // accumulating. This is what a mounted container can show and a static
    // markup render cannot.
    const first = entry('issue-created', 1);
    const second = entry('comment-added', 2, { author: 'Lubko', body: 'fresh read' });
    const { read, seen } = reader([page([first], null, 1), page([second], null, 1)]);

    const { container, rerender } = mount(read);
    await screen.findByRole('list', { name: 'Board activity, newest first' });
    expect(seen).toHaveLength(1);

    await act(async () => { rerender(<FeedView readFeed={read} issues={[issue(1)]} generation={1} page={1} onPage={() => {}} onOpenIssue={() => {}} />); });

    expect(seen).toHaveLength(2);
    expect(container.textContent).toContain('fresh read');
    expect(container.textContent).not.toContain('Issue 1');
  });

  it('opens the issue an entry belongs to from the mounted list', async () => {
    // A click has to travel the real event path: the button the container
    // rendered, through React own handler, to the caller's callback.
    const entries = [entry('comment-added', 7, { author: 'Lubko', body: 'hi' })];
    const opened: number[] = [];
    const { read } = reader([page(entries, null, 1)]);

    render(<FeedView readFeed={read} issues={[issue(7)]} generation={0} page={1} onPage={() => {}} onOpenIssue={(number) => { opened.push(number); }} />);
    const list = await screen.findByRole('list', { name: 'Board activity, newest first' });
    const button = await within(list).findByRole('button', { name: '#7 Issue 7' });
    await act(async () => { fireEvent.click(button); });

    expect(opened).toEqual([7]);
  });

  it('reads nothing at all when the component is unmounted before the read lands', async () => {
    // The container guards its own `setState` after teardown with a `live`
    // flag. Mounted, that guard is observable: an unmounted tree keeps no
    // state update and warns about none.
    const entries = [entry('issue-created', 1)];
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { read, seen } = reader([page(entries, null, 1)]);

    const { unmount } = mount(read);
    unmount();
    await act(async () => { await Promise.resolve(); });

    expect(seen).toHaveLength(1);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/unmounted component|state update/i);
    warn.mockRestore();
  });
});
