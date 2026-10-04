import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
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
import { FEED_EMPTY, FEED_LIST_PAGES_LABEL, FEED_MORE_LABEL, FEED_PAGE_NEXT, FEED_PAGE_PREVIOUS } from './ui-state';

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

function mount(read: (request?: BoardFeedRequest) => Promise<BoardFeedPage>, overrides: { generation?: number; issues?: BoardIssue[] } = {}) {
  return render(<FeedView readFeed={read} issues={overrides.issues ?? [issue(1)]} generation={overrides.generation ?? 0} onOpenIssue={() => {}} />);
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
    expect(screen.queryByRole('button', { name: FEED_MORE_LABEL })).toBeNull();
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

  it('asks for older entries with the token the backend issued and shows that page alone', async () => {
    // The read still walks forward by the backend's own token, but the page it
    // reads back becomes *the* page on screen. The inherited version of this
    // test asserted two rows after two one-entry pages; that assertion encoded
    // the accumulation board 173 forbids, and with one-entry pages it could not
    // have observed the page size at all.
    const first = entry('comment-added', 3);
    const older = entry('issue-created', 2);
    const { read, seen } = reader([page([first], 'v1.token', 2), page([older], null, 2)]);

    const { container } = mount(read);
    await screen.findByRole('list', { name: 'Board activity, newest first' });
    expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1);

    const more = await screen.findByRole('button', { name: FEED_MORE_LABEL });
    await act(async () => { fireEvent.click(more); });

    await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1));
    expect(seen).toEqual([{ limit: DEFAULT_FEED_LIMIT }, { limit: DEFAULT_FEED_LIMIT, cursor: 'v1.token' }]);
    const rows = Array.from(container.querySelectorAll('[data-feed-id]')).map((row) => row.getAttribute('data-feed-id'));
    // The page just read replaces the one before it: no re-sort, no append, and
    // the exhausted token takes the forward control away again.
    expect(rows).toEqual([older.id]);
    expect(screen.queryByRole('button', { name: FEED_MORE_LABEL })).toBeNull();
  });

  it('never holds more than one real page in the document, however far the walk goes', async () => {
    // The page size is the board's own: `DEFAULT_FEED_LIMIT` is 50, so pages of
    // 1 (as the rest of this file's small fixtures use) cannot observe this at
    // all. Four real 50-entry pages over a 180-entry feed: after walking three
    // pages forward the document must hold 50 rows, not 150.
    const realPage = (from: number) => page(
      Array.from({ length: DEFAULT_FEED_LIMIT }, (_, offset) => entry('issue-created', from - offset)),
      `v1.page.${from}`,
      180,
    );
    const { read } = reader([realPage(150), realPage(100), realPage(50), realPage(0)]);

    const { container } = render(<AddressedFeed read={read} address={1} report={() => {}} />);
    await screen.findByRole('list', { name: 'Board activity, newest first' });
    expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(DEFAULT_FEED_LIMIT);

    for (let step = 0; step < 2; step += 1) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: FEED_MORE_LABEL })); });
      await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(DEFAULT_FEED_LIMIT));
    }

    expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(DEFAULT_FEED_LIMIT);
    // Page 3's oldest entry is on screen; page 1's newest entry is not, so the
    // document is not holding the pages already visited.
    expect(container.textContent).toContain('Issue 50');
    expect(container.textContent).not.toContain('Issue 150');
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

    await act(async () => { rerender(<FeedView readFeed={read} issues={[issue(1)]} generation={1} onOpenIssue={() => {}} />); });

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

    render(<FeedView readFeed={read} issues={[issue(7)]} generation={0} onOpenIssue={(number) => { opened.push(number); }} />);
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

/**
 * The addressable feed page, read through the container that has to read it.
 *
 * `board-url.test.ts` proves `?feed=2` parses and serialises, which is what the
 * landed run-scope repair made addressable. It cannot prove that any line of the
 * Feed surface *reads* the field — that is the seam this closes: a correct,
 * addressable field with no render site consuming it. So `address` here is the
 * query string's own value, `report` is what the view reports back to it, and
 * the state between them is what `App` does with `navigate`. A field change that
 * arrives as a prop, with no read and no click, is what makes these assertions
 * non-vacuous: a container that ignored the prop would render the whole walk on
 * every page.
 */
function AddressedFeed({ read, address, report }: { read: (request?: BoardFeedRequest) => Promise<BoardFeedPage>; address: number; report: (page: number) => void }) {
  const [page, setPage] = useState(address);
  useEffect(() => { setPage(address); }, [address]);
  return <FeedView
    readFeed={read}
    issues={[issue(1)]}
    generation={0}
    page={page}
    onPage={(next) => { report(next); setPage(next); }}
    onOpenIssue={() => {}}
  />;
}

describe('the feed page the address names', () => {
  it('draws the page the field names, and the field alone moves it back', async () => {
    // The read side of the seam. Two pages are walked with the backend's own
    // token, so both pages are in the container's hands; what the reader then
    // sees is decided by the field and nothing else.
    const newest = entry('comment-added', 3);
    const older = entry('issue-created', 2);
    const { read, seen } = reader([page([newest], 'v1.token', 2), page([older], null, 2)]);
    const reported: number[] = [];
    const report = (next: number) => { reported.push(next); };

    const { container, rerender } = render(<AddressedFeed read={read} address={1} report={report} />);
    // The feed list is rendered before the first read resolves, so finding it is
    // not a signal that the page has arrived. The button is the first element
    // that can only exist once the page has, so it is what is awaited: a
    // `getByRole` here raced the read and failed under host load.
    const more = await screen.findByRole('button', { name: FEED_MORE_LABEL });
    await act(async () => { fireEvent.click(more); });

    // Walking forward reveals the page it just read and reports that page to
    // the address, which is what makes `?feed=2` a link a reader can send. The
    // page drawn is the one just read, alone: one entry, not both.
    await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1));
    expect(reported).toEqual([2]);
    expect(container.textContent).toContain('Issue 2');
    expect(container.textContent).not.toContain('Issue 3');
    // The address now says what the view reported, so the two agree.
    await act(async () => { rerender(<AddressedFeed read={read} address={2} report={report} />); });
    await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1));

    // The field alone: `?feed=1` arrives as a prop change, with no read and no
    // click. The older entry must leave the document and the newest return.
    await act(async () => { rerender(<AddressedFeed read={read} address={1} report={report} />); });
    await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1));
    expect(container.textContent).toContain('Issue 3');
    expect(container.textContent).not.toContain('Issue 2');
    // And forward again, from the field, with no further read: the pages are
    // already in hand, so choosing a page number is never another read.
    await act(async () => { rerender(<AddressedFeed read={read} address={2} report={report} />); });
    await waitFor(() => expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1));
    const rows = Array.from(container.querySelectorAll('[data-feed-id]')).map((row) => row.getAttribute('data-feed-id'));
    expect(rows).toEqual([older.id]);
    expect(seen).toHaveLength(2);
  });

  it('numbers only the pages the projection handed over and names the position', async () => {
    // Numbered pagination the reader can trust: every number is a page that was
    // actually read, `aria-current` says which one is drawn, and the position
    // line says where that is. A page nobody has read is never offered, because
    // the projection — not the browser — issues the tokens that fetch one.
    const { read } = reader([page([entry('issue-created', 4)], 'v1.token', 4), page([entry('issue-created', 3)], 'v2.token', 4), page([entry('issue-created', 2)], null, 4)]);

    const { container } = render(<AddressedFeed read={read} address={1} report={() => {}} />);
    await screen.findByRole('list', { name: 'Board activity, newest first' });
    // One page and no numbered control: there is nothing to number yet.
    expect(screen.queryByRole('navigation', { name: FEED_LIST_PAGES_LABEL })).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: FEED_MORE_LABEL })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: FEED_MORE_LABEL })); });

    const nav = await screen.findByRole('navigation', { name: FEED_LIST_PAGES_LABEL });
    expect(Array.from(nav.querySelectorAll('button')).map((each) => each.getAttribute('aria-label'))).toEqual([
      FEED_PAGE_PREVIOUS,
      'Feed page 1',
      'Feed page 2',
      'Feed page 3',
      FEED_PAGE_NEXT,
    ]);
    expect(within(nav).getByRole('status').textContent).toBe('Page 3 of 3');
    expect(within(nav).getByRole('button', { name: 'Feed page 3' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: 'Feed page 1' }).getAttribute('aria-current')).toBeNull();
    // The walk reached the end of what the projection would hand over, so the
    // control takes the forward step away and only going back is left.
    expect((within(nav).getByRole('button', { name: FEED_PAGE_NEXT }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1);
    expect(container.textContent).toContain('Issue 2');
    expect(container.textContent).not.toContain('Issue 4');
  });

  it('clamps a page the walk has not reached to the newest page rather than rendering nothing', async () => {
    // `?feed=9` on a shared link names no page, and a link must never open an
    // empty feed. The clamp falls back to the newest page the reader holds.
    const { read } = reader([page([entry('comment-added', 5)], null, 1)]);

    const { container } = render(<FeedView readFeed={read} issues={[issue(5)]} generation={0} page={9} onOpenIssue={() => {}} />);
    await screen.findByRole('list', { name: 'Board activity, newest first' });

    expect(container.querySelectorAll('[data-feed-id]')).toHaveLength(1);
  });
});
