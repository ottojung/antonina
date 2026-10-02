import type { IssueFilter } from './ui-state';

/**
 * The Antonina board's addressable UI state, and the one translation between
 * that state and the browser's address bar.
 *
 * Everything here is a pure function of a search string or of a state object:
 * no DOM, no React, no router. The app is served from a static bundle under an
 * arbitrary path, so the state lives in a query string on the current path
 * rather than in path segments — a path route would 404 on reload, and a hash
 * route would hide the state from anything that reads the URL as text.
 *
 * Credential safety is structural, not a promise: the state is five
 * allowlisted fields, the serializer can only ever emit keys in
 * `BOARD_URL_KEYS`, and the parser reads only those keys, so a board
 * credential, token or key cannot be carried into the URL by construction even
 * if one were pasted into the address bar by hand. See `board-url.test.ts`.
 */

export type BoardView = 'issues' | 'resources' | 'feed' | 'targets';

export const BOARD_VIEWS: readonly BoardView[] = ['issues', 'resources', 'feed', 'targets'];

export const ISSUE_FILTERS: readonly IssueFilter[] = ['open', 'closed', 'all'];

export const DEFAULT_BOARD_VIEW: BoardView = 'issues';

export const DEFAULT_ISSUE_FILTER: IssueFilter = 'open';

/** The first page of the Issues list, which is the page before pagination exists. */
export const DEFAULT_ISSUE_PAGE = 1;

export interface BoardUrlState {
  view: BoardView;
  /** The open issue whose thread is shown, or `undefined` for the list alone. */
  selectedNumber: number | undefined;
  filter: IssueFilter;
  settingsOpen: boolean;
  /** The Issues-list page number, one-based. */
  page: number;
}

/** The board as it opens with no URL parameters at all. */
export const DEFAULT_BOARD_URL_STATE: BoardUrlState = {
  view: DEFAULT_BOARD_VIEW,
  selectedNumber: undefined,
  filter: DEFAULT_ISSUE_FILTER,
  settingsOpen: false,
  page: DEFAULT_ISSUE_PAGE,
};

/**
 * Every key the URL may carry. The serializer emits nothing outside this set and
 * the parser reads nothing outside it, which is what makes "no board secret in
 * the URL" a property of the module rather than of anyone's care.
 */
export const BOARD_URL_KEYS = ['view', 'issue', 'filter', 'page', 'settings'] as const;

function isBoardView(value: string): value is BoardView {
  return (BOARD_VIEWS as readonly string[]).includes(value);
}

function isIssueFilter(value: string): value is IssueFilter {
  return (ISSUE_FILTERS as readonly string[]).includes(value);
}

/**
 * A positive integer from a URL parameter, or `undefined`.
 *
 * Only an all-digits string is a number: a decimal, a sign, an exponent, a
 * whitespace-padded value and a non-numeric value are all stale input rather
 * than an issue number, and none of them becomes one here.
 */
function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * Reads the board's UI state out of a query string.
 *
 * Every field degrades rather than fails. An unknown or missing `view` is the
 * Issues tab; an unknown `filter` is `open`; a `page` that is not a positive
 * integer is page 1; an `issue` that is not a positive integer selects nothing.
 * So a stale link, a truncated paste and a hand-edited URL all land on a usable
 * board view instead of a blank screen, and unknown parameters are ignored
 * rather than echoed back into the address bar.
 */
export function parseBoardUrl(search: string): BoardUrlState {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  const filter = params.get('filter');
  const settings = params.get('settings');
  return {
    view: view !== null && isBoardView(view) ? view : DEFAULT_BOARD_VIEW,
    selectedNumber: positiveInteger(params.get('issue')),
    filter: filter !== null && isIssueFilter(filter) ? filter : DEFAULT_ISSUE_FILTER,
    settingsOpen: settings === '1',
    page: positiveInteger(params.get('page')) ?? DEFAULT_ISSUE_PAGE,
  };
}

/**
 * The query string for a state, in a fixed key order.
 *
 * A field at its default is omitted rather than written out, so the board's
 * opening URL is the bare path and two states that differ only in a default
 * produce the same string. That is what makes the app's own URL comparable to
 * the current one without normalizing first.
 */
export function boardSearch(state: BoardUrlState): string {
  const params = new URLSearchParams();
  if (state.view !== DEFAULT_BOARD_VIEW) params.set('view', state.view);
  if (state.selectedNumber !== undefined) params.set('issue', String(state.selectedNumber));
  if (state.filter !== DEFAULT_ISSUE_FILTER) params.set('filter', state.filter);
  if (state.page !== DEFAULT_ISSUE_PAGE) params.set('page', String(state.page));
  if (state.settingsOpen) params.set('settings', '1');
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * The full address for a state: the path it is served from, plus its query
 * string. The default is no path at all, so an `href` of `?issue=7` resolves
 * against whatever path the board is served from and the app stays correct
 * under a base path or a static host that mounts it anywhere.
 */
export function boardHref(state: BoardUrlState, pathname = ''): string {
  return `${pathname}${boardSearch(state)}`;
}

/**
 * The state a navigation produces: the state it starts from with the named
 * fields replaced. A field set to `undefined` is removed, which is how
 * "leave the Issues tab" clears the selected issue in one step.
 */
export function boardUrlFor(changes: Partial<BoardUrlState>, from: BoardUrlState): BoardUrlState {
  const next: BoardUrlState = { ...from };
  for (const [key, value] of Object.entries(changes) as [keyof BoardUrlState, BoardUrlState[keyof BoardUrlState]][]) {
    if (value === undefined) delete next[key];
    else Object.assign(next, { [key]: value });
  }
  return {
    view: next.view,
    selectedNumber: next.selectedNumber,
    filter: next.filter,
    settingsOpen: next.settingsOpen,
    page: next.page,
  };
}

/**
 * Whether two states are the same screen. The app compares these rather than
 * strings, so a change that the serializer treats as a default — clearing the
 * filter back to `open`, going back to page 1 — is still a navigation the URL
 * has to record, while a re-render that changes nothing is not.
 */
export function sameBoardUrl(left: BoardUrlState, right: BoardUrlState): boolean {
  return left.view === right.view
    && left.selectedNumber === right.selectedNumber
    && left.filter === right.filter
    && left.settingsOpen === right.settingsOpen
    && left.page === right.page;
}

/** The Issues tab: a tab link clears the selected issue, because the list is the screen. */
export function tabUrlState(view: BoardView, from: BoardUrlState): BoardUrlState {
  return boardUrlFor({ view, selectedNumber: undefined, page: DEFAULT_ISSUE_PAGE }, from);
}

/** An issue thread: opening one from any tab lands on the Issues tab with the issue selected. */
export function issueUrlState(number: number, from: BoardUrlState): BoardUrlState {
  return boardUrlFor({ view: 'issues', selectedNumber: number, filter: 'all' }, from);
}

/**
 * The board's home: the Issues tab, nothing selected, nothing open, first page.
 * Every field returns to its default rather than only the selection, because
 * the brand mark promises the board's own opening screen and not a variation
 * of it.
 */
export function boardHomeState(from: BoardUrlState): BoardUrlState {
  return boardUrlFor({
    view: DEFAULT_BOARD_VIEW,
    selectedNumber: undefined,
    filter: DEFAULT_ISSUE_FILTER,
    settingsOpen: false,
    page: DEFAULT_ISSUE_PAGE,
  }, from);
}

/** A tab's own href, so the nav can be real links a reader can copy or open in a new tab. */
export function tabHref(view: BoardView, from: BoardUrlState, pathname?: string): string {
  return boardHref(tabUrlState(view, from), pathname);
}

/** One issue's href. It carries no credential: the number is a selector, nothing more. */
export function issueHref(number: number, from: BoardUrlState, pathname?: string): string {
  return boardHref(issueUrlState(number, from), pathname);
}

export interface BoardLocation {
  pathname: string;
  search: string;
}

export interface BoardHistory {
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

/**
 * Writes a state into the address bar without a document load.
 *
 * `push` adds a history entry, so Back returns to the previous board screen;
 * `replace` overwrites the current entry, which is what the first write of a
 * freshly loaded page wants — the entry the user already has should become the
 * board's URL, not sit behind it as a duplicate of where they arrived.
 *
 * A write that would not change the address is skipped, so a re-render with
 * unchanged state adds no history entry of its own.
 */
export function writeBoardUrl(state: BoardUrlState, location: BoardLocation, history: BoardHistory, mode: 'push' | 'replace'): boolean {
  const next = boardHref(state, location.pathname);
  if (`${location.pathname}${location.search}` === next) return false;
  if (mode === 'push') history.pushState(null, '', next);
  else history.replaceState(null, '', next);
  return true;
}

/**
 * The keys a URL carries, parsed back out. The credential check is stated over
 * this rather than over a substring search, so it is the parse that has to be
 * safe: any key outside `BOARD_URL_KEYS` cannot survive a round trip.
 */
export function boardUrlKeys(search: string): string[] {
  return [...new URLSearchParams(search).keys()].filter((key) => !BOARD_URL_KEYS.includes(key as (typeof BOARD_URL_KEYS)[number]));
}