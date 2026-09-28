import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
// The source is located with `import.meta.dirname` and not through the global
// `URL`: the suite runs in a DOM environment (board issue 72), where the global
// `URL` is jsdom's own and resolves a relative path against the page's
// location rather than against this file. What is read and what is asserted are
// unchanged; only the path resolution moved.
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// Every feed page in this file is a plain object handed to the view, and the XDG
// roots are pointed at paths that cannot exist, so no code under test can reach
// the real `$XDG_STATE_HOME` or the real `trust.json` / `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-feed-tab-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-feed-tab-config';

import { FeedThread, type FeedThreadProps } from './App';
import { DEFAULT_FEED_LIMIT, type BoardFeedEntry, type BoardFeedEntryKind, type BoardFeedPage, type BoardFeedRequest } from './api';
import type { BoardIssue } from './model';
import { appendFeedPage, feedFirstPageRequest, FEED_COUNT_LABEL, FEED_MORE_LABEL } from './ui-state';

// The web suite runs in a node environment with no document and no layout
// engine, so nothing here can be scrolled, hovered or clicked by a browser.
// What is provable is what the tab renders and what it asks the backend for:
// the entry order it was given, the label each kind is distinguished by, the
// request the first page sends, the token the next page carries, and the caveat
// it shows for issues the log never recorded.
const STAMP = '2026-09-25T12:00:00.000Z';

let sequence = 0;
function entry(kind: BoardFeedEntryKind, issueNumber: number, overrides: Partial<BoardFeedEntry> = {}): BoardFeedEntry {
  sequence += 1;
  return {
    id: `op-${sequence}`,
    kind,
    at: STAMP,
    position: 100 - sequence,
    issueNumber,
    title: `Issue ${issueNumber}`,
    state: 'open',
    messageId: null,
    author: null,
    body: null,
    ...overrides,
  };
}

function issue(number: number): BoardIssue {
  return { number, title: `Issue ${number}`, body: '', state: 'open', createdAt: STAMP, updatedAt: STAMP, messages: [] };
}

function page(entries: BoardFeedEntry[], nextCursor: string | null, total = entries.length): BoardFeedPage {
  return { entries, nextCursor, total, limit: DEFAULT_FEED_LIMIT };
}

function props(overrides: Partial<FeedThreadProps> = {}): FeedThreadProps {
  return {
    entries: [],
    nextCursor: null,
    total: 0,
    issues: [],
    loading: false,
    error: undefined,
    onShowMore: () => {},
    onOpenIssue: () => {},
    ...overrides,
  };
}

type Element = ReactElement<Record<string, unknown>>;
type Button = ReactElement<{ className?: string; onClick?: () => void; children?: ReactNode }>;

/** Every host element a render produced, with its component elements expanded. */
function elements(node: ReactNode, found: Element[] = []): Element[] {
  if (Array.isArray(node)) { for (const child of node) elements(child, found); return found; }
  if (!isValidElement<Record<string, unknown>>(node)) return found;
  if (typeof node.type === 'symbol' || node.type === undefined) return elements(node.props.children as ReactNode, found);
  if (typeof node.type !== 'string') return elements((node.type as (props: unknown) => ReactNode)(node.props), found);
  found.push(node as Element);
  return elements(node.props.children as ReactNode, found);
}

function rendered(overrides: Partial<FeedThreadProps> = {}): Element[] {
  return elements(FeedThread(props(overrides)));
}

function byClass(overrides: Partial<FeedThreadProps>, className: string): Element[] {
  return rendered(overrides).filter((element) => typeof element.props.className === 'string' && (element.props.className as string).split(' ').includes(className));
}

function feedEntries(overrides: Partial<FeedThreadProps> = {}): Element[] {
  return rendered(overrides).filter((element) => typeof element.props['data-feed-id'] === 'string');
}

describe('the feed tab', () => {
  it('renders the entries in the order the projection returned them, newest first', () => {
    // Deliberately handed a page whose newest entry is last in this list, the
    // way the core projection reports it: the view must not re-sort, because a
    // second order here would be a second opinion about the log.
    const entries = [entry('issue-created', 1), entry('comment-added', 1, { author: 'Lubko', body: 'on it' })];
    const markup = renderToStaticMarkup(<FeedThread {...props({ entries, total: 2 })} />);

    const ids = [...markup.matchAll(/data-feed-id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(entries.map((each) => each.id));
    expect(markup.indexOf(entries[1].id)).toBeGreaterThan(markup.indexOf(entries[0].id));
  });

  it('puts the most recent entry at the top and says how much of the feed is shown', () => {
    const entries = [entry('issue-edited', 2), entry('issue-closed', 2, { state: 'closed' }), entry('comment-added', 1, { author: 'Lubko', body: 'first' })];
    const rows = feedEntries({ entries, total: 300 });

    expect(rows[0].props['data-feed-kind']).toBe('issue-edited');
    expect(rendered({ entries, total: 300 }).some((element) => element.props.children === FEED_COUNT_LABEL(3, 300))).toBe(true);
  });

  it('tells every kind apart by its own badge, label and class', () => {
    const kinds: BoardFeedEntryKind[] = ['issue-created', 'issue-edited', 'comment-added', 'issue-closed', 'issue-reopened', 'issue-deleted'];
    const entries = kinds.map((kind) => entry(kind, 1));
    const rows = feedEntries({ entries, total: entries.length });

    expect(rows.map((row) => row.props['data-feed-kind'])).toEqual(kinds);
    expect(new Set(rows.map((row) => row.props.className)).size).toBe(kinds.length);
    const markup = renderToStaticMarkup(<FeedThread {...props({ entries, total: entries.length })} />);
    // One distinct visible word per kind, so a row is identifiable without a
    // colour and without reading the whole line.
    for (const word of ['Created', 'Edited', 'Comment', 'Closed', 'Reopened', 'Deleted']) {
      expect(markup).toContain(`>${word}</span>`);
    }
    // And each row carries its own kind class, so the stylesheet can tell them
    // apart as well.
    for (const kind of kinds) expect(markup).toContain(`feed-kind-${kind}`);
  });

  it('names the author and body of a comment, and the verb and title of every other kind', () => {
    const markup = renderToStaticMarkup(<FeedThread {...props({
      entries: [
        entry('comment-added', 1, { author: 'Lubko', body: 'on it' }),
        entry('issue-reopened', 1),
      ],
      total: 2,
    })} />);

    expect(markup).toContain('commented by Lubko: on it');
    expect(markup).toContain('reopened');
    // No invented author or body for a kind that has none.
    expect(markup).not.toContain('by null');
  });

  it('opens the issue an entry belongs to, and offers no target for a deleted one', () => {
    const opened: number[] = [];
    const onOpenIssue = (number: number) => { opened.push(number); };
    const entries = [entry('comment-added', 7, { author: 'Lubko', body: 'hi' }), entry('issue-deleted', 8)];
    const markup = renderToStaticMarkup(<FeedThread {...props({ entries, total: 2, onOpenIssue })} />);
    const rows = byClass({ entries, total: 2, onOpenIssue }, 'feed-issue');

    expect(rows).toHaveLength(2);
    rows.forEach((row) => (row as Button).props.onClick?.());
    expect(opened).toEqual([7]);
    // The deleted issue is gone from the board, so its row is text and not a
    // link into an issue that no longer exists.
    expect(rows[1].type).toBe('span');
    expect(markup).toContain('#8 Issue 8');
  });

  it('offers the older-entries control only while the backend holds a continuation', () => {
    const entries = [entry('issue-created', 1)];
    const markup = renderToStaticMarkup(<FeedThread {...props({ entries, nextCursor: 'v1.token', total: 400 })} />);

    expect(markup).toContain(FEED_MORE_LABEL);
    expect(renderToStaticMarkup(<FeedThread {...props({ entries, nextCursor: null, total: 1 })} />)).not.toContain(FEED_MORE_LABEL);
  });

  it('asks for older entries through the control it rendered', () => {
    const onShowMore = vi.fn();
    const more = byClass({ entries: [entry('issue-created', 1)], nextCursor: 'v1.token', total: 400, onShowMore }, 'feed-more');

    expect(more).toHaveLength(1);
    (more[0] as Button).props.onClick?.();
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it('shows nothing but the empty state before the board has recorded an operation', () => {
    const markup = renderToStaticMarkup(<FeedThread {...props({ entries: [], total: 0 })} />);

    expect(markup).toContain('No activity recorded yet');
    expect(markup).not.toContain('feed-entry');
    expect(markup).not.toContain(FEED_MORE_LABEL);
  });

  it('says that message edits and per-field issue-edit history are not tracked, without inventing them', () => {
    const markup = renderToStaticMarkup(<FeedThread {...props({ entries: [entry('issue-edited', 1)], total: 1 })} />);

    expect(markup).toContain('does not record edits to messages');
    expect(markup).toContain('which field an issue edit changed');
    // And nothing in the markup pretends such an entry exists.
    expect(markup).not.toMatch(/message-edited|field-changed/);
  });

  describe('the issue that predates the log', () => {
    it('warns that the feed is truncated, and names the issue it cannot place', () => {
      // The board view holds issue 1, but no operation ever named its creation:
      // it was already in the `board.initialize` snapshot, so the projection
      // cannot report it and the CLI would print an empty feed. The browser can
      // tell, because it holds both halves.
      const markup = renderToStaticMarkup(<FeedThread {...props({ entries: [entry('comment-added', 2)], total: 1, issues: [issue(1), issue(2)] })} />);

      expect(markup).toContain('already on the board when the signed log began');
      expect(markup).toContain('#1');
      expect(markup).not.toContain('#2,');
    });

    it('says so instead of showing a confidently empty feed', () => {
      const markup = renderToStaticMarkup(<FeedThread {...props({ entries: [], total: 0, issues: [issue(1), issue(2)] })} />);

      expect(markup).toContain('No activity recorded yet');
      expect(markup).toContain('already on the board when the signed log began');
      expect(markup).toContain('#1, #2');
    });

    it('warns nothing when every issue on the board is in the feed', () => {
      const markup = renderToStaticMarkup(<FeedThread {...props({ entries: [entry('issue-created', 1)], total: 1, issues: [issue(1)] })} />);

      expect(markup).not.toContain('already on the board');
    });

    it('does not count a deleted issue as untracked, because the log did record it', () => {
      const markup = renderToStaticMarkup(<FeedThread {...props({ entries: [entry('issue-deleted', 1)], total: 1, issues: [issue(1)] })} />);

      expect(markup).not.toContain('already on the board');
    });

    it('says nothing at all about the issues a first page has not reached yet', () => {
      // The case the caveat used to get wrong: 60 issues, a 50-entry first
      // page, and a continuation token. The log demonstrably created issues 51
      // to 60 — they are on the board — but their operations are in the pages
      // still unread, so calling them pre-log issues would be a statement about
      // a log nobody has read. The board is healthy here and the caveat must be
      // silent.
      const entries = Array.from({ length: 50 }, (_, index) => entry('issue-created', 50 - index));
      const issues = Array.from({ length: 60 }, (_, index) => issue(index + 1));
      const markup = renderToStaticMarkup(<FeedThread {...props({ entries, nextCursor: 'v1.more', total: 55, issues })} />);

      expect(entries).toHaveLength(50);
      expect(issues).toHaveLength(60);
      expect(markup).toContain(FEED_MORE_LABEL);
      expect(markup).not.toContain('already on the board');
      expect(markup).not.toContain('#51');
      expect(markup).not.toContain('.feed-caveat');
    });

    it('names the same ten once the walk has read the log to its end', () => {
      // The claim is not dropped, it is deferred: with no token left and every
      // entry the projection counted in hand, the difference is real and the
      // caveat says so — and says that the whole feed was read, because that is
      // what it now depends on.
      const entries = Array.from({ length: 50 }, (_, index) => entry('issue-created', 50 - index));
      const issues = Array.from({ length: 60 }, (_, index) => issue(index + 1));
      const markup = renderToStaticMarkup(<FeedThread {...props({ entries, nextCursor: null, total: 50, issues })} />);

      expect(markup).toContain('read the whole feed');
      expect(markup).toContain('#51, #52, #53, #54, #55, #56, #57, #58, #59, #60');
      expect(markup).not.toContain('#50, #51');
    });

    it('stays silent when the entries in hand fall short of what the log holds', () => {
      // The token is gone but the walk came up short, so the reader still
      // cannot tell a pre-log issue from an unread one. No continuation token is
      // offered either — the backend issued none — and the caveat stays off.
      const entries = [entry('issue-created', 1)];
      const markup = renderToStaticMarkup(<FeedThread {...props({ entries, nextCursor: null, total: 9, issues: [issue(1), issue(2)] })} />);

      expect(markup).not.toContain('already on the board');
      expect(markup).not.toContain('read the whole feed');
    });
  });
});

describe('the feed tab in the app shell', () => {
  // `App` needs a browser: it reads `window.localStorage` for the display name
  // on its first render, and the web suite runs in a node environment with no
  // document, so the shell itself cannot be mounted here. What can be pinned
  // from the source is the wiring — that the feed is one of the top-level tabs
  // the same nav renders, that it is the third item beside the two settled
  // ones, and that selecting it renders the container that reads the core feed
  // through the session's own method.
  const app = readFileSync(resolve(import.meta.dirname, 'App.tsx'), 'utf8');

  it('is a top-level tab beside Issues and Resources', () => {
    // The tab list grew a fourth entry for the target overview, so the pinned list
    // names all four rather than the three that existed when the feed landed.
    expect(app).toMatch(/const TABS: readonly View\[\] = \['issues', 'resources', 'feed', 'targets'\]/);
    expect(app).toMatch(/TABS\.map\(\(item\) => <button key=\{item\}/);
  });

  it('renders the feed container for that tab and nowhere else', () => {
    expect(app).toMatch(/<FeedView readFeed=\{session\.readFeed\}/);
    expect(app.match(/<FeedView /g)).toHaveLength(1);
    expect(app).toMatch(/type View = 'issues' \| 'resources' \| 'feed' \| 'targets'/);
  });

  it('opens the feed through the shared reader, so the prop is the only read path', () => {
    // The container's opening read is a named function rather than something
    // inlined in the effect, which is what lets a detached read be exercised
    // directly: the test in api.test.ts calls this same reader with a session
    // method that has lost its receiver, the way this prop has.
    expect(app).toMatch(/await readFeedFirstPage\(read\)/);
    expect(app).toMatch(/readFeed: FeedRead;/);
  });
});

describe('the requests the feed tab sends', () => {
  it('opens with the projection’s own default page', () => {
    // The browser does not name a page size of its own: it asks for the same
    // default `antonina board feed` uses, so there is one default, not two.
    expect(feedFirstPageRequest()).toEqual({ limit: DEFAULT_FEED_LIMIT });
    expect(DEFAULT_FEED_LIMIT).toBe(50);
  });

  it('carries the backend cursor back unchanged to load older entries', async () => {
    const seen: Array<BoardFeedRequest> = [];
    const older = [entry('issue-created', 1)];
    const readFeed = async (request: BoardFeedRequest = {}) => {
      seen.push(request);
      return page(older, 'v1.next-token', 3);
    };
    const current = page([entry('comment-added', 3), entry('issue-created', 2)], 'v1.first-token', 3);

    const merged = await appendFeedPage(readFeed, current, current.nextCursor!);

    expect(seen).toEqual([{ limit: DEFAULT_FEED_LIMIT, cursor: 'v1.first-token' }]);
    // Newest first throughout: the older page is appended below what is already
    // shown, and nothing the browser holds is re-sorted.
    expect(merged.entries.map((each) => each.id)).toEqual([...current.entries, ...older].map((each) => each.id));
    // The token the backend returned with the new page is kept, so the next
    // walk continues from there rather than restarting.
    expect(merged.nextCursor).toBe('v1.next-token');
    expect(merged.total).toBe(3);
  });

  it('stops walking when the backend stops issuing a token, without asking again', async () => {
    const seen: Array<BoardFeedRequest> = [];
    const readFeed = async (request: BoardFeedRequest = {}) => {
      seen.push(request);
      return page([entry('issue-created', 1)], null, 2);
    };
    const current = page([entry('issue-created', 2)], 'v1.token', 2);

    const merged = await appendFeedPage(readFeed, current, 'v1.token');

    expect(seen).toHaveLength(1);
    expect(merged.nextCursor).toBeNull();
    expect(merged.entries).toHaveLength(2);
  });
});
