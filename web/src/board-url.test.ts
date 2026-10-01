import { describe, expect, it } from 'vitest';

// The pure half of board issue 139: the translation between a search string and
// the board's UI state. Every case here is a value that can arrive in a URL
// somebody was sent, so the module has to be total — no input throws, and no
// input produces a state the app cannot render.
import {
  BOARD_URL_KEYS,
  BOARD_VIEWS,
  ISSUE_FILTERS,
  DEFAULT_BOARD_URL_STATE,
  DEFAULT_ISSUE_PAGE,
  boardHref,
  boardHomeState,
  boardSearch,
  boardUrlFor,
  boardUrlKeys,
  issueHref,
  issueUrlState,
  parseBoardUrl,
  sameBoardUrl,
  tabHref,
  tabUrlState,
  writeBoardUrl,
  type BoardUrlState,
} from './board-url';

const READY: BoardUrlState = { view: 'issues', selectedNumber: 7, filter: 'all', settingsOpen: false, page: 2 };

function fakeHistory() {
  const calls: { mode: 'push' | 'replace'; url: string }[] = [];
  return {
    calls,
    history: {
      pushState: (_data: unknown, _unused: string, url?: string | null) => { calls.push({ mode: 'push', url: url ?? '' }); },
      replaceState: (_data: unknown, _unused: string, url?: string | null) => { calls.push({ mode: 'replace', url: url ?? '' }); },
    },
  };
}

describe('parsing the board URL', () => {
  it('reads a bare URL as the board as it opens', () => {
    expect(parseBoardUrl('')).toEqual(DEFAULT_BOARD_URL_STATE);
  });

  it('reads every addressable field', () => {
    expect(parseBoardUrl('?view=feed')).toEqual({ ...DEFAULT_BOARD_URL_STATE, view: 'feed' });
    expect(parseBoardUrl('?issue=139')).toEqual({ ...DEFAULT_BOARD_URL_STATE, selectedNumber: 139 });
    expect(parseBoardUrl('?filter=closed')).toEqual({ ...DEFAULT_BOARD_URL_STATE, filter: 'closed' });
    expect(parseBoardUrl('?page=4')).toEqual({ ...DEFAULT_BOARD_URL_STATE, page: 4 });
    expect(parseBoardUrl('?settings=1')).toEqual({ ...DEFAULT_BOARD_URL_STATE, settingsOpen: true });
  });

  it('reads a whole screen at once', () => {
    expect(parseBoardUrl('?view=issues&issue=7&filter=all&page=2&settings=1')).toEqual({ ...READY, settingsOpen: true });
  });

  it('accepts a search string with or without its leading question mark', () => {
    expect(parseBoardUrl('issue=5')).toEqual({ ...DEFAULT_BOARD_URL_STATE, selectedNumber: 5 });
  });

  it('degrades an unknown view to the Issues tab rather than to nothing', () => {
    // A link from a version that had a tab this build does not is stale input,
    // not an error: the reader lands on the board's main screen.
    expect(parseBoardUrl('?view=timeline')).toEqual(DEFAULT_BOARD_URL_STATE);
    expect(parseBoardUrl('?view=')).toEqual(DEFAULT_BOARD_URL_STATE);
  });

  it('degrades an unknown filter to Open', () => {
    expect(parseBoardUrl('?filter=mine').filter).toBe('open');
  });

  it('degrades anything that is not a positive integer to the first page', () => {
    for (const value of ['0', '-1', '2.5', '1e3', ' 2', 'two', '', 'NaN']) {
      expect(parseBoardUrl(`?page=${encodeURIComponent(value)}`).page).toBe(DEFAULT_ISSUE_PAGE);
    }
  });

  it('selects nothing for an issue that is not a positive integer', () => {
    for (const value of ['0', '-4', 'abc', '1.2', '']) {
      expect(parseBoardUrl(`?issue=${encodeURIComponent(value)}`).selectedNumber).toBeUndefined();
    }
  });

  it('treats any settings value other than 1 as closed', () => {
    expect(parseBoardUrl('?settings=true').settingsOpen).toBe(false);
    expect(parseBoardUrl('?settings=0').settingsOpen).toBe(false);
  });

  it('never throws, whatever the search string is', () => {
    for (const value of ['?%%%', '?a=1&a=2', '?view=issues&view=feed', '?issue=' + '9'.repeat(400)]) {
      expect(() => parseBoardUrl(value)).not.toThrow();
    }
  });

  it('drops a parameter that is too large to be an issue number', () => {
    expect(parseBoardUrl(`?issue=${'9'.repeat(30)}`).selectedNumber).toBeUndefined();
  });
});

describe('writing the board URL', () => {
  it('writes nothing at all for the board as it opens', () => {
    expect(boardSearch(DEFAULT_BOARD_URL_STATE)).toBe('');
    expect(boardHref(DEFAULT_BOARD_URL_STATE)).toBe('');
  });

  it('writes one parameter per non-default field, in a stable order', () => {
    expect(boardSearch(READY)).toBe('?issue=7&filter=all&page=2');
    expect(boardSearch({ ...DEFAULT_BOARD_URL_STATE, view: 'targets' })).toBe('?view=targets');
    expect(boardSearch({ ...DEFAULT_BOARD_URL_STATE, settingsOpen: true })).toBe('?settings=1');
  });

  it('round-trips every state it can write', () => {
    const states: BoardUrlState[] = [
      DEFAULT_BOARD_URL_STATE,
      READY,
      { ...DEFAULT_BOARD_URL_STATE, view: 'resources' },
      { ...DEFAULT_BOARD_URL_STATE, view: 'feed', settingsOpen: true },
      { ...DEFAULT_BOARD_URL_STATE, filter: 'closed', page: 7 },
      { ...DEFAULT_BOARD_URL_STATE, selectedNumber: 139 },
    ];
    for (const state of states) expect(parseBoardUrl(boardSearch(state))).toEqual(state);
  });

  it('gives a URL that stays on the path the board is served from', () => {
    // The board is a static bundle that may be mounted under any base path, so
    // an href names the query string alone and the browser resolves it against
    // the current path. A path-based route would 404 on reload instead.
    expect(issueHref(7, DEFAULT_BOARD_URL_STATE)).toBe('?issue=7&filter=all');
    expect(tabHref('feed', DEFAULT_BOARD_URL_STATE)).toBe('?view=feed');
  });

  it('puts the path in front of the query string when one is given', () => {
    expect(issueHref(7, DEFAULT_BOARD_URL_STATE, '/board')).toBe('/board?issue=7&filter=all');
    expect(tabHref('feed', DEFAULT_BOARD_URL_STATE, '/board/')).toBe('/board/?view=feed');
  });
});

describe('navigating between states', () => {
  it('replaces only the named field', () => {
    expect(boardUrlFor({ filter: 'closed' }, DEFAULT_BOARD_URL_STATE)).toEqual({ ...DEFAULT_BOARD_URL_STATE, filter: 'closed' });
    expect(boardUrlFor({ view: 'feed' }, READY)).toEqual({ ...READY, view: 'feed' });
  });

  it('removes a field set to undefined', () => {
    expect(boardUrlFor({ selectedNumber: undefined }, READY).selectedNumber).toBeUndefined();
  });

  it('leaves a tab without an open issue, and back on the first page', () => {
    const moved = tabUrlState('feed', READY);
    expect(moved).toEqual({ ...READY, view: 'feed', selectedNumber: undefined, page: DEFAULT_ISSUE_PAGE });
  });

  it('opens an issue from any tab on the Issues tab with the issue selected', () => {
    expect(issueUrlState(139, tabUrlState('feed', READY))).toEqual({
      view: 'issues',
      selectedNumber: 139,
      filter: 'all',
      settingsOpen: false,
      page: DEFAULT_ISSUE_PAGE,
    });
  });

  it('goes home to the Issues tab with nothing selected', () => {
    expect(boardHomeState(READY)).toEqual({ view: 'issues', selectedNumber: undefined, filter: 'open', settingsOpen: false, page: DEFAULT_ISSUE_PAGE });
  });

  it('tells two states apart only by what they show', () => {
    expect(sameBoardUrl(READY, { ...READY })).toBe(true);
    expect(sameBoardUrl(READY, { ...READY, page: 3 })).toBe(false);
    expect(sameBoardUrl(READY, { ...READY, settingsOpen: true })).toBe(false);
  });
});

describe('writing to the address bar', () => {
  it('pushes a navigation so Back has somewhere to return to', () => {
    const { calls, history } = fakeHistory();
    expect(writeBoardUrl(READY, { pathname: '/board', search: '' }, history, 'push')).toBe(true);
    expect(calls).toEqual([{ mode: 'push', url: '/board?issue=7&filter=all&page=2' }]);
  });

  it('replaces the entry the reader arrived on', () => {
    const { calls, history } = fakeHistory();
    writeBoardUrl(READY, { pathname: '/board', search: '?view=nope' }, history, 'replace');
    expect(calls).toEqual([{ mode: 'replace', url: '/board?issue=7&filter=all&page=2' }]);
  });

  it('writes nothing when the address already says this', () => {
    // A re-render that changed no state must not add a history entry, or Back
    // would walk through duplicates of the same screen.
    const { calls, history } = fakeHistory();
    expect(writeBoardUrl(READY, { pathname: '/board', search: '?issue=7&filter=all&page=2' }, history, 'push')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps the path it is served from', () => {
    const { calls, history } = fakeHistory();
    writeBoardUrl({ ...DEFAULT_BOARD_URL_STATE, view: 'targets' }, { pathname: '/deep/base/board.html', search: '' }, history, 'push');
    expect(calls[0].url).toBe('/deep/base/board.html?view=targets');
  });
});

describe('credential safety', () => {
  it('emits no key outside the allowlist, for any state', () => {
    const states: BoardUrlState[] = [
      DEFAULT_BOARD_URL_STATE,
      READY,
      { ...DEFAULT_BOARD_URL_STATE, view: 'resources', settingsOpen: true, page: 3 },
      { ...DEFAULT_BOARD_URL_STATE, selectedNumber: 4242, filter: 'closed' },
    ];
    for (const state of states) {
      const keys = [...new URLSearchParams(boardSearch(state)).keys()];
      expect(keys.every((key) => BOARD_URL_KEYS.includes(key as (typeof BOARD_URL_KEYS)[number]))).toBe(true);
    }
  });

  it('reads no key outside the allowlist, so a pasted secret is discarded', () => {
    // The board credential is a JSON document that grants full read and write
    // access. A URL is copied, pasted, logged and synced by things that are not
    // this app, so the credential must be unreachable from one: the parser names
    // only allowlisted keys, and a URL carrying anything else restores exactly
    // the same board state as one carrying nothing.
    const leaked = '?view=feed&credential=%7B%22keyId%22%3A%22root-1%22%7D&token=secret&key=secret';
    expect(parseBoardUrl(leaked)).toEqual(parseBoardUrl('?view=feed'));
    expect(boardUrlKeys(leaked)).toEqual(['credential', 'token', 'key']);
    // And the state the app then writes back carries none of them.
    expect(boardSearch(parseBoardUrl(leaked))).toBe('?view=feed');
  });

  it('names an issue by its number alone', () => {
    // What the URL may carry is a selector: the number the board already
    // assigns every issue. Nothing here is a capability, and a browser without
    // the credential opens the same URL as a read-only board rather than a
    // board it was given access to.
    expect(issueHref(139, DEFAULT_BOARD_URL_STATE)).not.toMatch(/credential|token|key|secret/i);
  });
});

describe('the view and filter vocabularies', () => {
  it('names every tab and every filter', () => {
    expect([...BOARD_VIEWS]).toEqual(['issues', 'resources', 'feed', 'targets']);
    expect([...ISSUE_FILTERS]).toEqual(['open', 'closed', 'all']);
    for (const view of BOARD_VIEWS) expect(parseBoardUrl(`?view=${view}`).view).toBe(view);
    for (const filter of ISSUE_FILTERS) expect(parseBoardUrl(`?filter=${filter}`).filter).toBe(filter);
  });
});