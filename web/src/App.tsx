import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createBrowserBoardApi, targetViews, type BoardFeedEntry, type BoardFeedPage, type DaemonHostView, type IssueListSummary, type TargetView } from './api';
import { resourceState, type BoardIssue, type BoardResource } from './model';
import { BOARD_VIEWS, DEFAULT_BOARD_URL_STATE, DEFAULT_ISSUE_PAGE, DEFAULT_RESOURCE_PAGE, ISSUE_FILTERS, boardHomeState, boardHref, boardUrlFor, issueHref, parseBoardUrl, tabHref, writeBoardUrl, type BoardUrlState, type BoardView } from './board-url';
import { TARGETS_EMPTY, TARGETS_HINT, TARGET_ACCESS_LABEL, TARGET_CLEANUP_LABEL, TARGET_KIND_LABEL, TARGET_PERSISTENCE_LABEL, TARGET_STATUS_LABEL, targetCatalogRows } from './targets';
import { clampIssuePage, clampResourcePage, ISSUE_PAGE_NEXT, ISSUE_PAGE_PREVIOUS, ISSUE_PAGE_SIZE, ISSUE_LIST_PAGES_LABEL, RESOURCE_LIST_PAGES_LABEL, RESOURCE_PAGE_SIZE, hasIssuePages, issuePage, issuePageCount, issuePageRange, COMPOSER_READ_ONLY_CALLOUT, COMPOSER_SUBMIT_HINT, accessCallout, appendFeedPage, boardAccess, boardDeleted, boardLoadFailed, boardLoaded, canMoveInQueue, DELETED_COPY, emptyIssueList, FEED_COUNT_LABEL, FEED_EMPTY, FEED_HINT, FEED_KIND_LABEL, FEED_MORE_LABEL, FEED_TRUNCATED_COPY, FEED_UNTRACKED_COPY, feedEntrySummary, filterLabel, formatUpdatedAt, groupResources, ISSUE_FORM_HINT, ISSUE_FORM_SUBMIT_HINT, firstRunOutcome, issueCounts, moveQueueEarlier, moveQueueIssue, moveQueueLater, moveQueueTo, openQueueOrder, overviewLoaded, priorityLabel, queuePosition, queueMoveToLabel, queueSlots, readFeedFirstPage, resourcePage, trustRequired, unplacedIssueNumbers, visibleIssues, QUEUE_DRAG_TYPE, QUEUE_HINT, QUEUE_MOVE_LABELS, QUEUE_REORDERED_NOTICE, QUEUE_REORDER_FAILED, WRITE_ACCESS_SUMMARY, REJECTED_CREDENTIAL_COPY, FIRST_RUN_COPY, BOARD_KEY_COPY, type AccessCallout, type BoardAccess, type BoardLoad, type BoardRead, type BoardSummary, type FeedRead, type FirstRunOutcome, type IssueFilter, type QueueDirection, type ReadOnlyAccess } from './ui-state';

const DISPLAY_NAME_KEY = 'antonina:display-name';
const REFRESH_INTERVAL = 30_000;
type View = BoardView;
const TABS: readonly View[] = BOARD_VIEWS;
const TAB_TITLE: { readonly [V in View]: string } = { issues: 'Issues', resources: 'Resources', feed: 'Feed', targets: 'Targets' };
const TAB_PANE_LABEL: { readonly [V in View]: string } = {
  issues: 'Shared issue list',
  resources: 'Registered resources',
  feed: 'Board activity feed',
  targets: 'Execution target overview',
};
/** The tab's own sentence, so no view has to spell its case out inline. */
const TAB_HINT: { readonly [V in View]: string } = {
  issues: QUEUE_HINT,
  resources: 'Registered paths are protected while at least one dependent Antonina issue remains open.',
  feed: FEED_HINT,
  targets: TARGETS_HINT,
};

type IssueListRow = IssueListSummary | BoardIssue;
type IssueReference = Pick<BoardIssue, 'number' | 'title' | 'state'>;

function rowMessageCount(issue: IssueListRow): number {
  return 'messageCount' in issue ? issue.messageCount : issue.messages.length;
}

function rowHasBody(issue: IssueListRow): boolean {
  return 'hasBody' in issue ? issue.hasBody : issue.body.length > 0;
}

export default function App() {
  const session = useMemo(() => createBrowserBoardApi(), []);
  const api = session.api;
  const [load, setLoad] = useState<BoardLoad>({ status: 'loading' });
  // Board issue 139: the addressable half of the UI state — tab, selected
  // issue, issue filter, issues-page number and the settings panel — is one
  // object read from the query string and written back to it, so a link opens
  // the screen it names. `parseBoardUrl` degrades every unrecognized value to a
  // default, and nothing outside `BOARD_URL_KEYS` is ever read or written, so a
  // stale URL cannot blank the board and no credential can ride along.
  const [location, setLocation] = useState<BoardUrlState>(() => parseBoardUrl(window.location.search));
  const { view, selectedNumber, filter, settingsOpen, page, resourcePage } = location;
  const [selectedIssue, setSelectedIssue] = useState<BoardIssue>();
  // The open issue's conversation is held as the ONE bounded page the core read
  // returned, not as a hydrated issue: `IssueCommentPage` carries the issue's own
  // fields (with an empty `messages` array) plus this page's messages and the
  // thread's total. Board issue 174 removed the whole-thread read from this path,
  // so nothing here can render a message that was never fetched.
  const [conversation, setConversation] = useState<IssueCommentPage>();
  /** Counts conversation reads in the order they were asked; see the read effect. */
  const [displayName, setDisplayName] = useState(() => window.localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
  const [access, setAccess] = useState<BoardAccess>('read-only');
  const [credentialInput, setCredentialInput] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [initializing, setInitializing] = useState(false);
  // Every internal navigation goes through here, so the URL and the state can
  // never disagree: one updater produces the next state, and the effect below
  // is the only thing that writes the address bar.
  const navigate = useCallback((changes: Partial<BoardUrlState>) => {
    setLocation((current) => boardUrlFor(changes, current));
  }, []);
  // Same names as the setters they replace, so every existing call site reads
  // as before: a filter or a selection is still just a state change, and the
  // address follows it.
  // A real tab change returns to the first page, because `tabUrlState` — which is
  // what the tab's own href already advertises — says so, and a copied address
  // and a click have to land on the same screen. A navigation to the view the
  // reader is already on is *not* a tab change: creating an issue calls
  // `setView('issues')` while the reader sits on page 2, and that must not throw
  // away the page they chose.
  const setView = useCallback((next: View) => {
    setLocation((current) => boardUrlFor(
      // A real tab change resets every page number, and a click and the tab's
      // own href have to land on the same screen: arriving at a tab means page 1,
      // not whatever page of it this reader left open earlier. The Resources page
      // is one of those numbers, and it is independent of the Issues page, so
      // paging Resources must not renumber the list behind it.
      current.view === next ? { view: next, selectedNumber: undefined } : { view: next, selectedNumber: undefined, page: DEFAULT_ISSUE_PAGE, resourcePage: DEFAULT_RESOURCE_PAGE },
      current,
    ));
  }, []);
  // A filter change reselects which issues the list holds, so the page number is
  // *preserved* rather than reset: `clampIssuePage` moves an out-of-range page
  // down onto the last page that exists, which keeps the reader's position in
  // the list while guaranteeing a valid page. Resetting to 1 would be the other
  // defensible choice, but issue 140's controls are specified to preserve the
  // page and clamp it, and the merge keeps that behaviour rather than silently
  // replacing it.
  const setFilter = useCallback((next: IssueFilter) => { navigate({ filter: next }); }, [navigate]);
  const setSettingsOpen = useCallback((next: boolean) => { navigate({ settingsOpen: next }); }, [navigate]);
  const setSelectedNumber = useCallback((next: number | undefined) => { navigate({ selectedNumber: next }); }, [navigate]);
  // The Issues-page number is part of the address, so it survives a reload and
  // lands in a shared link. Board issue 140 owns the slicing and the
  // Previous/Next controls that move it; this side holds and restores the
  // number itself, and publishes it as `data-issue-page` for that front.
  // The first write of a loaded page replaces its history entry, so arriving on
  // a stale URL and having it cleaned up does not leave a dead entry behind
  // Back; every navigation after that is a real entry.
  const replacedInitialUrl = useRef(false);
  useEffect(() => {
    writeBoardUrl(location, window.location, window.history, replacedInitialUrl.current ? 'push' : 'replace');
    replacedInitialUrl.current = true;
  }, [location]);
  useEffect(() => {
    const restore = () => setLocation(parseBoardUrl(window.location.search));
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  // Bumped by every successful board read, so the feed tab re-reads the log on
  // the same cadence as the rest of the board instead of holding a page of it
  // indefinitely. The key carries no entries of its own: the feed is always
  // whatever the core projection last returned.
  const [feedGeneration, setFeedGeneration] = useState(0);
  // The one page number for both features. Issue 140's controls move it and
  // issue 139 owns where it lives, so this is not a second `useState` beside the
  // URL's `page`: a single number read from `location` and written back through
  // `navigate`. A second source of truth here would be the one-way street the
  // merge exists to avoid — the controls would set state the URL never learned
  // about, and a reload or a Back would silently undo the reader's paging.
  // The name is the one issue 140's `onPage` wiring already reads as.
  const setIssuePageIndex = useCallback((next: number) => { navigate({ page: next }); }, [navigate]);
  // The Resources page number, out of the same address and written back through
  // the same `navigate`, for the same reason there is no second `useState` for
  // the Issues list's page: a page number the URL does not know about does not
  // survive a reload, a shared link or Back. It is a separate field from `page`
  // because it pages a different screen.
  const setResourcePageIndex = useCallback((next: number) => { navigate({ resourcePage: next }); }, [navigate]);
  // The conversation's page number, out of the same address and written back
  // through the same `navigate`, for the same reason there is no second
  // `useState` for the Issues list's page: a page number the URL does not know
  // about does not survive a reload, a shared link or Back. It is a separate
  // field from `page` because it pages a different screen — a thread does not
  // renumber the list it was opened from, and the list does not renumber it.
  const setCommentPageIndex = useCallback((next: number) => { navigate({ commentPage: next }); }, [navigate]);
  // The feed's page number, out of the same address and written back through the
  // same `navigate`, for the same reason there is no second `useState` for the
  // Issues list's page or the conversation's. Board issue 173: the feed's page
  // survives a reload, a shared link and Back, which is what makes `?view=feed`
  // with a page a link a reader can send someone.
  const setFeedPageIndex = useCallback((next: number) => { navigate({ feedPage: next }); }, [navigate]);
  // The Resources page number, out of the same address and written back through
  // the same `navigate`, for the same reason: a page number the URL does not
  // know about does not survive a reload, a shared link or Back. It is a
  // separate field from `page` because it pages a different screen.

  const refresh = useCallback(async () => {
    try {
      const overview = await session.readOverview();
      setLoad(overviewLoaded(overview));
      if (overview === null) {
        setAccess('read-only');
        setError(undefined);
        return;
      }
      setFeedGeneration((current) => current + 1);
      const access = api.accessState();
      setAccess(session.hasCredential() ? boardAccess(access.canEdit, access.credentialRejection !== null) : 'read-only');
      setError(undefined);
    } catch (cause) {
      if (trustRequired(cause)) {
        setLoad((current) => (current.status === 'ready' ? current : { status: 'untrusted' }));
        return;
      }
      if (boardDeleted(cause)) {
        setLoad({ status: 'deleted' });
        return;
      }
      const message = cause instanceof Error ? cause.message : 'Could not load Antonina';
      setError(message);
      setLoad((current) => boardLoadFailed(current, message));
    }
  }, [session, api]);
  // One snapshot decides the whole list: a ready load always carries the queue
  // the board reported with its issues, and the same snapshot orders every
  // render. There is no other order to fall back to, and no other read.
  const ready = load.status === 'ready' ? load : undefined;
  const board = ready?.board;
  const hasBoard = ready !== undefined;
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!hasBoard) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [hasBoard, refresh]);

  // One href builder for every issue link outside the issue list, so a link
  // copied from Resources, Targets or Feed names the same route the app opens.
  const issueHrefHere = useCallback((number: number) => issueHref(number, location, window.location.pathname), [location]);
  const visible = ready ? visibleIssues(ready.board.issues, ready.queue, filter) : [];
  // The page is a slice of the ordered list, never a second ordering of it: the
  // whole filtered list is what the queue controls compute their moves against,
  // and only the rows on screen are handed to the list.
  //
  // There is exactly one page number in this file: the one out of the URL. 140's
  // `useState(1)` is gone, because two of them is what the auto-merge produced —
  // `location.page` published as `data-issue-page` while `issuePageIndex` did the
  // slicing — and that tree draws page 1 for `?page=3` and writes nothing to the
  // address when the reader presses Next. Here the drawn page is derived from the
  // address, so the address and the rows cannot drift apart in either direction.
  const pageIndex = clampIssuePage(page, visible.length);
  const paged = useMemo(() => issuePage(visible, pageIndex), [visible, pageIndex]);
  // The Resources view's page is the same shape of thing as the Issues list's:
  // one number out of the address, clamped onto a page that exists, and a slice
  // of the board's own resource order. `ResourcesView` is handed the slice and
  // the controls, so it draws one page and never the whole collection.
  const resourceIndex = clampResourcePage(resourcePage, board?.resources.length ?? 0);
  const counts = issueCounts(board?.issues ?? []);
  const hasWriteAccess = access === 'editable';
  const empty = emptyIssueList(filter, hasWriteAccess);
  const selected = selectedIssue?.number === selectedNumber ? selectedIssue : undefined;
  useEffect(() => {
    // Only a board that has been read can say an issue is not there. Before the
    // first read `visible` is empty, and clearing then would drop the issue a
    // direct link named before the board had a chance to answer. A link to an
    // issue the board does not hold is still cleared — once the read is in, and
    // the URL is rewritten to the list, so a stale link lands on the board.
    if (ready === undefined || selectedNumber === undefined) return;
    if (!visible.some((issue) => issue.number === selectedNumber)) setSelectedNumber(undefined);
  }, [ready, selectedNumber, visible]);
  useEffect(() => {
    if (selectedNumber === undefined || ready === undefined
        || !ready.board.issues.some((issue) => issue.number === selectedNumber)) {
      setSelectedIssue(undefined);
      return;
    }
    let live = true;
    setSelectedIssue((current) => current?.number === selectedNumber ? current : undefined);
    void api.getIssue(selectedNumber).then((issue) => {
      if (live) setSelectedIssue(issue);
    }).catch((cause) => {
      if (live) setError(cause instanceof Error ? cause.message : 'The issue could not be loaded');
    });
    return () => { live = false; };
  }, [api, selectedNumber, ready?.head]);

  const clearOutcome = useCallback(() => clearBothOutcomes(() => setError(undefined), () => setNotice(undefined)), []);
  /** Every write goes through the one commit path, so callers only say what to send. */
  async function run<T>(action: () => Promise<T>, success: string): Promise<T | null> {
    return commitWrite<T>(
      { write: action, reload: refresh, clear: clearOutcome, notice: setNotice, failure: setError },
      { success, failure: 'The change could not be saved' },
    );
  }
  async function createIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    const title = (form.elements.namedItem('title') as HTMLInputElement).value;
    const body = (form.elements.namedItem('body') as HTMLTextAreaElement).value;
    const created = await run(() => api.createIssue(title, body), 'Issue created');
    if (created && 'number' in created) { setView('issues'); setSelectedNumber(created.number); setFilter('open'); form.reset(); }
  }
  async function postComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !displayName.trim()) return;
    const form = event.currentTarget; const body = (form.elements.namedItem('body') as HTMLTextAreaElement).value;
    const result = await run(() => api.comment(selected.number, displayName, body), 'Message posted'); if (result) form.reset();
  }
  function openIssue(number: number) { setLocation((current) => boardUrlFor({ view: 'issues', selectedNumber: number, filter: 'all' }, current)); }
  function saveDisplayName(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); const clean = displayName.trim(); if (!clean) return;
    window.localStorage.setItem(DISPLAY_NAME_KEY, clean); setDisplayName(clean); setNotice('Display name saved in this browser');
  }
  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined);
    try {
      const enabled = await session.enableEditing(credentialInput);
      setAccess(enabled.canEdit ? 'editable' : 'read-only');
      setCredentialInput('');
      setNotice('Write access saved in this browser');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The credential could not be saved'); }
  }
  function clearCredential() {
    session.clearCredential();
    setAccess('read-only');
    setSelectedNumber(undefined);
    setSelectedIssue(undefined);
    setSettingsOpen(false);
    setLoad({ status: 'untrusted' });
    setNotice(undefined);
  }
  async function copyKey(text: string | null, label: string) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setNotice(`${label} copied`); }
    catch { setError('The browser did not allow access to the clipboard'); }
  }
  async function unlockBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setUnlocking(true); setError(undefined);
    try {
      const enabled = await session.enableEditing(credentialInput);
      const overview = await session.readOverview();
      if (overview === null) { setError('The board could not be read back'); return; }
      setAccess(enabled.canEdit ? 'editable' : 'rejected');
      setLoad(overviewLoaded(overview));
      setCredentialInput('');
      setFeedGeneration((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The board credential could not be accepted');
    } finally {
      setUnlocking(false);
    }
  }
  async function initializeBoard() {
    setInitializing(true); setError(undefined); setNotice(undefined);
    const show = (outcome: FirstRunOutcome) => {
      setLoad(outcome.load);
      if (outcome.error) setError(outcome.error); else if (outcome.notice) setNotice(outcome.notice);
    };
    try {
      // Whether this browser won the board is settled by this call alone, so a
      // call that delivers no state is the only place a lost race can come
      // from: a board that is there now was created by someone else, and any
      // other failure is reported as itself. The state it did verify is the
      // load, so the board is never claimed readable before it has been read.
      const created: BoardRead = { state: (await session.initialize()).state };
      setAccess('editable');
      show(firstRunOutcome(created));
    } catch (cause) {
      show(firstRunOutcome({ failure: cause }, await resolveFirstRun()));
    } finally { setInitializing(false); }
  }
  async function resolveFirstRun(): Promise<BoardRead> {
    try { return { state: await session.readState() }; }
    catch (cause) { return { failure: cause }; }
  }
  /** The one write path for priority: it commits a whole queue or changes nothing. */
  const queueCommit = useCallback((target: number[]): WriteCommit<number[]> => ({
    write: () => api.reorderQueue(target),
    reload: refresh,
    clear: clearOutcome,
    notice: setNotice,
    failure: setError,
  }), [api, refresh, clearOutcome]);
  const reorderQueue = useCallback((target: QueueTarget) => commitQueueOrder(target, queueCommit), [queueCommit]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  if (load.status === 'loading') return <main className="centered"><div><span className="loading-dot" /> Loading your shared board…</div></main>;
  if (load.status === 'failed') return <main className="centered"><section className="load-error"><p className="eyebrow">Antonina</p><h1>The board could not be loaded</h1><p>{load.message}</p><button className="primary" onClick={() => void refresh()}>Try again</button></section></main>;
  if (load.status === 'uninitialized') return <main className="centered"><FirstRun error={error} initializing={initializing} initialize={() => void initializeBoard()} recheck={() => void refresh()} /></main>;
  if (load.status === 'untrusted') return <main className="centered"><BoardKeyPrompt error={error} credentialInput={credentialInput} setCredentialInput={setCredentialInput} unlocking={unlocking} unlock={unlockBoard} retry={() => void refresh()} /></main>;
  if (load.status === 'deleted') return <main className="centered"><section className="first-run"><p className="eyebrow">Antonina</p><h1>{DELETED_COPY.title}</h1><p>{DELETED_COPY.body}</p></section></main>;

  return <div className="app-shell">
    <header className="topbar">
      {/* The nav and the brand are real anchors, not only click handlers: a tab
          is a screen with an address of its own, so its link can be copied,
          opened in a new tab, and reached by Back. `role="button"` keeps the
          accessible role the styles and the existing tests already speak. */}
      <a className="brand" role="button" href={boardHref(boardHomeState(location), window.location.pathname)} onClick={(event) => { event.preventDefault(); setLocation((current) => boardHomeState(current)); }} aria-label="Back to all Antonina issues"><span className="brand-mark" aria-hidden="true">A</span><span><strong>Antonina</strong><small>Shared issue board</small></span></a>
      <nav className="main-nav" aria-label="Main navigation">{TABS.map((item) => <a key={item} role="button" className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} href={tabHref(item, location, window.location.pathname)} onClick={(event) => { event.preventDefault(); setView(item); setSelectedNumber(undefined); }}>{item}</a>)}</nav>
      <div className="top-actions"><span className={`access-pill ${hasWriteAccess ? 'writable' : ''}`}><span aria-hidden="true" />{hasWriteAccess ? 'Can edit' : 'Read only'}</span><button className="quiet" onClick={() => void refresh()}>Refresh</button><button className="quiet" onClick={() => setSettingsOpen(true)}>Settings</button></div>
    </header>
    {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error">Dismiss</button></div>}
    {notice && <div className="notice success" role="status"><span>{notice}</span><button onClick={() => setNotice(undefined)} aria-label="Dismiss message">Dismiss</button></div>}
    <main className={`workspace ${view}-view ${selectedNumber !== undefined ? 'has-selection' : ''}`} data-issue-page={pageIndex}>
      <aside className="issue-pane" aria-label={TAB_PANE_LABEL[view]}>
        <div className="pane-heading"><div><p className="eyebrow">One board, everyone’s work</p><h1>{TAB_TITLE[view]}</h1><p>{view === 'issues' ? <>{QUEUE_HINT} Track what needs attention and discuss the details together.</> : TAB_HINT[view]}</p></div></div>
        {view === 'issues' ? <>
          {hasWriteAccess ? <CreateIssueForm onSubmit={createIssue} />
            : <AccessNotice access={access} className="access-callout" onAction={() => setSettingsOpen(true)} />}
{/* Issue 139 makes these real links so a filter is addressable; issue
              140 paginates the list the filter selects. The two coexist on one
              render site: the anchors carry `filter` in their href, and the
              list below them draws `paged` with its own controls. */}
          <nav className="filters" aria-label="Filter issues">{(ISSUE_FILTERS as readonly IssueFilter[]).map((value) => <a key={value} role="button" className={filter === value ? 'active' : ''} aria-pressed={filter === value} href={boardHref(boardUrlFor({ filter: value }, location), window.location.pathname)} onClick={(event) => { event.preventDefault(); setFilter(value); }}>{filterLabel(value)}<span>{counts[value]}</span></a>)}</nav>
          <div className="issue-list" aria-label="Issues"><IssueQueue issues={visible} page={paged} queue={load.queue} hasWriteAccess={hasWriteAccess} selectedNumber={selectedNumber} onSelect={setSelectedNumber} onReorder={reorderQueue} empty={empty} /></div>
          <IssuePagination total={visible.length} page={pageIndex} onPage={setIssuePageIndex} />
        </>           : view === 'resources'
          ? <ResourcesView resources={board!.resources} issues={board!.issues} access={access} page={resourceIndex} onPage={setResourcePageIndex} onOpenIssue={openIssue} onAdd={(host, path, number) => run(() => api.addResourceDependency(host, path, number), 'Resource dependency added')} onRemove={(resource, number) => run(() => api.removeResourceDependency(resource.host, resource.path, number), resource.issueNumbers.length === 1 ? 'Dependency removed; resource unregistered' : 'Resource dependency removed')} onEnableEditing={() => setSettingsOpen(true)} hrefForIssue={issueHrefHere} />
          : view === 'targets'
          // The browser cannot read a host's daemon report: those are files on
          // the operator's own machine, and a page that fetched them would be
          // claiming telemetry it did not receive. So the page is handed no host
          // views and states `unknown` for every persistent host's live capacity,
          // which is the truth from here. `antonina board target list
          // --telemetry` is where a host's own numbers come from.
          ? <TargetsView targets={targetViews(board!)} hosts={[]} onOpenIssue={openIssue} hrefForIssue={issueHrefHere} />
          : <FeedView readFeed={session.readFeed} issues={board!.issues} generation={feedGeneration} onOpenIssue={openIssue} hrefForIssue={issueHrefHere} />}
      </aside>
      {view === 'issues' ? selected ? <Thread issue={selected} access={access} displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} openSettings={() => setSettingsOpen(true)} comment={postComment} editBody={(body) => run(() => api.editIssueBody(selected.number, body), 'Description updated')} close={() => void run(() => api.close(selected.number), 'Issue closed')} reopen={() => void run(() => api.reopen(selected.number), 'Issue reopened')} back={() => setSelectedNumber(undefined)} />
        : selectedNumber !== undefined
          ? <section className="thread welcome"><div className="welcome-mark" aria-hidden="true">A</div><p className="eyebrow">Issue #{selectedNumber}</p><h2>Loading issue…</h2></section>
          : <section className="thread welcome"><div className="welcome-mark" aria-hidden="true">A</div><p className="eyebrow">Shared issue board</p><h2>Choose an issue to join the conversation.</h2></section> : null}
    </main>
    {settingsOpen && <SettingsPanel displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} access={access} credentialInput={credentialInput} setCredentialInput={setCredentialInput} saveCredential={saveCredential} clearCredential={clearCredential} credentialText={session.credentialText()} copyKey={copyKey} close={closeSettings} />}
  </div>;
}

/** What a drag or a move control reports: the whole reordered open queue. */
export type QueueTarget = number[] | null;

/** The issue row a pointer-less test event stands in for. */
export type QueueRowTarget = { dataset: { issue?: string } };

/** What a write reports, and what it names itself when the board refuses with no reason. */
export interface WriteOutcome {
  success: string;
  failure: string;
}

/**
 * Every write clears the whole standing outcome, not half of it. The two are
 * rendered one above the other, so clearing only the notice would leave a
 * success message sitting under the error of something that failed earlier, and
 * clearing only the error would leave a stale "saved" above a new refusal.
 */
export function clearBothOutcomes(clearError: () => void, clearNotice: () => void): void {
  clearError();
  clearNotice();
}

export interface WriteCommit<T> {
  write(): Promise<T>;
  reload(): Promise<void>;
  clear(): void;
  notice(message: string): void;
  failure(message: string): void;
}

/**
 * The one write path, shared by every mutation this app makes.
 *
 * It clears the standing outcome first, so a new outcome can never be read next
 * to the one it replaced: a success is not shown beside a stale error, and a
 * refusal is not shown beside a stale "saved".
 *
 * A refused write — no capability, a concurrent writer that moved the board on, a
 * storage conflict — must not read as success and must not leave the list showing
 * state the board never accepted, so the failure path re-reads the board and
 * surfaces the board's own reason, falling back to the caller's own wording only
 * when the refusal carries none.
 */
export async function commitWrite<T>(commit: WriteCommit<T>, outcome: WriteOutcome): Promise<T | null> {
  commit.clear();
  try {
    const written = await commit.write();
    await commit.reload();
    commit.notice(outcome.success);
    return written;
  } catch (cause) {
    await commit.reload();
    commit.failure(cause instanceof Error ? cause.message : outcome.failure);
    return null;
  }
}

/**
 * The single write path for priority, shared by the drag target and the
 * move-earlier/move-later/move-to-position controls.
 *
 * A `null` target is the deliberate no-op of a boundary move: nothing is sent, no
 * board is re-read, and no error is invented for a queue that would not have
 * changed. Every target that is a permutation gets its commit and goes through
 * `commitWrite`, so a reorder is committed exactly the way a comment or a state
 * change is.
 */
export async function commitQueueOrder(target: QueueTarget, commitFor: (target: number[]) => WriteCommit<number[]>): Promise<number[] | null> {
  if (target === null) return null;
  return commitWrite(commitFor(target), { success: QUEUE_REORDERED_NOTICE, failure: QUEUE_REORDER_FAILED });
}

export type IssueDragStart = { currentTarget: QueueRowTarget; dataTransfer: { setData(type: string, value: string): void } | null };

/** A drag carries the issue number, so a drop does not have to trust the row. */
export function issueDragStarted(event: IssueDragStart): void {
  const number = event.currentTarget.dataset.issue;
  if (number === undefined) return;
  event.dataTransfer?.setData(QUEUE_DRAG_TYPE, number);
}

export type IssueDrop = {
  dataTransfer: { getData(type: string): string } | null;
  preventDefault(): void;
};

export function allowIssueDrop(event: { preventDefault(): void }): void {
  event.preventDefault();
}

/**
 * A drop reorders the shared queue the row was rendered with, so a drag commits
 * the same complete permutation the move controls commit — never the dragged
 * pair. The caller owns the order and the row it was dropped on; the event only
 * carries the dragged number.
 */
export function issueDropped(event: IssueDrop, order: number[], over: number): QueueTarget {
  event.preventDefault();
  const dragged = Number(event.dataTransfer?.getData(QUEUE_DRAG_TYPE));
  return moveQueueIssue(order, dragged, order.indexOf(over));
}

export type IssueMoveClick = { preventDefault(): void };

/**
 * The keyboard-reachable alternatives to dragging: the same whole-queue
 * permutation, computed from the direction or the position the control names.
 */
export function issueMoveRequested(event: IssueMoveClick, order: number[], number: number, direction: QueueDirection): QueueTarget {
  event.preventDefault();
  return direction === 'later' ? moveQueueLater(order, number) : moveQueueEarlier(order, number);
}

export function issueMovedToPosition(event: { preventDefault(): void }, order: number[], number: number, to: number): QueueTarget {
  event.preventDefault();
  return moveQueueTo(order, number, to);
}

export function IssueQueue({ issues, page = issues, queue, hasWriteAccess, selectedNumber, onSelect, onReorder, empty }: {
  issues: IssueListRow[];
  /**
   * The rows to draw. The list renders one page of them while `issues` stays the
   * whole filtered list, because every queue control below computes its move
   * from that list: a step, a drop or a chosen position must commit the entire
   * shared queue, and a page of it is not a queue the board would accept.
   */
  page?: IssueListRow[];
  queue: number[];
  hasWriteAccess: boolean;
  selectedNumber: number | undefined;
  onSelect: (number: number) => void;
  onReorder: (target: QueueTarget) => Promise<number[] | null>;
  empty: { title: string; body: string };
}) {
  // One order for the whole list, straight from the board's committed queue. The
  // row hands that same array to every control, so a drop, a step and a
  // move-to all recompute a full permutation from the snapshot that was rendered.
  const order = openQueueOrder(issues, queue);
  return <>
    {page.map((issue) => <IssueQueueRow key={issue.number} issue={issue} order={order} position={queuePosition(order, issue.number)} hasWriteAccess={hasWriteAccess} selected={issue.number === selectedNumber} onSelect={onSelect} onReorder={onReorder} />)}
    {!issues.length && <div className="empty-state"><h2>{empty.title}</h2><p>{empty.body}</p></div>}
  </>;
}

/**
 * The click handler behind an issue link.
 *
 * A link is a real `href` so it can be copied and opened in a new tab, and a
 * click on it is handled in the app rather than followed, so the board changes
 * screens without a document load. The event is optional so the handler can be
 * invoked directly, without a browser event, by a test that renders the view
 * through `renderToStaticMarkup`.
 */
export function issueLinkClick(open: (number: number) => void, number: number): (event?: { preventDefault(): void }) => void {
  return (event) => { event?.preventDefault(); open(number); };
}

function IssueQueueRow({ issue, order, position, hasWriteAccess, selected, onSelect, onReorder }: {
  issue: IssueListRow;
  order: number[];
  position: number;
  hasWriteAccess: boolean;
  selected: boolean;
  onSelect: (number: number) => void;
  onReorder: (target: QueueTarget) => Promise<number[] | null>;
}) {
  // Only a queued row offers a move at all: the board's queue holds open issues
  // only, so a move on a closed row is one the board cannot commit, and a
  // read-only visitor has no write path to reach. The grip that carries the drag
  // and the row that accepts the drop are both gated on that one predicate, so a
  // row the board could never accept a move from accepts no drop and is not
  // draggable at all.
  // A drag must start at a deliberate handle, so `draggable` and `onDragStart`
  // live on the grip and nowhere else. The drop, though, lands anywhere on the
  // row: a target the size of a 16px glyph is a near-miss waiting to happen.
  // Splitting the four handlers this way is the point — the drag originates only
  // at the grip, and the whole row is the drop target.
  // The drop reads the issue it landed on from the props the row already holds,
  // so there is no data attribute string channel to trust.
  const queued = hasWriteAccess && position > 0;
  return <div className={`issue-row ${selected ? 'selected' : ''}`} data-issue={issue.number}
    onDragOver={queued ? allowIssueDrop : undefined}
    onDrop={queued ? (event) => { void onReorder(issueDropped(event, order, issue.number)); } : undefined}>
    <button className="issue-select" onClick={() => onSelect(issue.number)} aria-current={selected ? 'true' : undefined}><span className="issue-summary"><span className="issue-line"><strong>#{issue.number}</strong><span className={`state-label ${issue.state}`}>{issue.state}</span><time dateTime={issue.updatedAt}>Updated {formatUpdatedAt(issue.updatedAt)}</time></span><span className="issue-title">{issue.title}</span><span className="issue-meta">{rowMessageCount(issue)} messages{rowHasBody(issue) ? ' · has description' : ''}</span></span><span className="row-arrow" aria-hidden="true">›</span></button>
    {/* The badge carries its name as text: an aria-label on a span whose only
        role is the implicit generic is prohibited and is never announced, so
        the position was spoken as a bare digit. The wording is real text, the
        glyph is the part hidden from assistive technology. */}
    {position > 0 && <span className="queue-position"><span className="visually-hidden">{priorityLabel(position)}</span><span aria-hidden="true">{position}</span></span>}
    {queued && <span className="queue-controls">
      {/* The drag lives on a grip, not on the row, so a pointer press on the
          select button, the step buttons or the move-to control can no longer
          start a row drag instead of activating the control under it. The grip
          is a visual affordance, so it takes no role and no tab stop: the step
          buttons and the move-to control are the keyboard-reachable ways to move
          an issue, and the grip is hidden from assistive technology rather than
          announced as a control that does not itself move anything. */}
      <span className="queue-grip" data-issue={issue.number} draggable aria-hidden="true" onDragStart={issueDragStarted}>⠿</span>
      {(['earlier', 'later'] as QueueDirection[]).map((direction) => <button key={direction} aria-label={`${QUEUE_MOVE_LABELS[direction]} (#${issue.number})`} disabled={!canMoveInQueue(order, issue.number, direction)} onClick={(event) => { void onReorder(issueMoveRequested(event, order, issue.number, direction)); }}>{direction === 'earlier' ? '▲' : '▼'}</button>)}
      {/* The move-to control belongs to the selected row alone. Offering every
          slot on every row would render one option per slot per row, so a
          200-issue board would mount 40,000 option elements. The row is
          keyboard-reachable and the control sits after it in the tab order, so
          selecting the row is the only extra step; the step buttons above stay
          on every row so nothing has to be selected just to nudge an issue. */}
      {selected && <select aria-label={queueMoveToLabel(issue.number, order.length)} value={position} onChange={(event) => { void onReorder(issueMovedToPosition(event, order, issue.number, Number(event.target.value))); }}>
        {queueSlots(order).map((slot) => <option key={slot} value={slot}>{slot}</option>)}
      </select>}
    </span>}
  </div>;
}


/**
 * The Issues list's own pagination: which slice is on screen, and the two
 * controls that move between slices.
 *
 * It is offered only when the filtered list really has more than one page. A
 * board with three issues is not given two permanently disabled buttons and a
 * "1–3 of 3" line; there is nothing there to page through.
 *
 * Both controls are real buttons, so they are keyboard reachable, and each is
 * disabled exactly when there is nowhere to go — Previous on the first page,
 * Next on the last — rather than hidden, so the position line stays a stable
 * landmark as the reader moves. The position line is a polite live region, so
 * paging announces the new range instead of silently swapping the rows under the
 * reader.
 */
export function IssuePagination({ total, page, pageSize = ISSUE_PAGE_SIZE, onPage, label = ISSUE_LIST_PAGES_LABEL }: {
  total: number;
  page: number;
  pageSize?: number;
  onPage: (page: number) => void;
  /**
   * What this run of pages navigates. It defaults to the Issues list and is
   * overridden for the Resources view, so the same control announces what it is
   * paging rather than always claiming to page the list.
   */
  label?: string;
}) {
  if (!hasIssuePages(total, pageSize)) return null;
  const index = clampIssuePage(page, total, pageSize);
  const pages = issuePageCount(total, pageSize);
  return <nav className="issue-pagination" aria-label={label}>
    <button type="button" className="quiet" aria-label={ISSUE_PAGE_PREVIOUS} disabled={index <= 1} onClick={() => onPage(index - 1)}>Previous</button>
    <p className="issue-page-range" role="status">{issuePageRange(total, index, pageSize)}</p>
    <button type="button" className="quiet" aria-label={ISSUE_PAGE_NEXT} disabled={index >= pages} onClick={() => onPage(index + 1)}>Next</button>
  </nav>;
}

/** The keystroke a submit shortcut is decided from, and nothing else about the event. */
export type ShortcutKey = Pick<ReactKeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat'>;

/** The keydown a textarea hands the rule: the keystroke plus its two browser effects. */
export type ShortcutKeydown = ShortcutKey & {
  preventDefault(): void;
  currentTarget: { form: { requestSubmit(): void } | null };
};

/**
 * Ctrl+Enter or Meta+Enter in a textarea is routed to the owning form's own
 * `requestSubmit()`, so it submits exactly the way the form's submit button
 * does and runs the same native `required` validation before `onSubmit`. Both
 * modifiers are claimed because the same gesture is Cmd+Return on a Mac, and
 * teaching one platform the shortcut while the other must reach for the mouse
 * would be an arbitrary split.
 *
 * Plain Enter is left alone so it keeps inserting a newline. No other modifier
 * is claimed, and holding both Ctrl and Meta is not a shortcut either: that
 * combination is one gesture, so it must not be able to submit twice. An
 * auto-repeat is ignored too, because a held key would otherwise re-enter the
 * submit handler while the first call is still in flight and post a second
 * message from one deliberate press.
 */
export function submitsFormOnShortcut(event: ShortcutKey): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.repeat) return false;
  return event.ctrlKey !== event.metaKey;
}

/** A textarea's keydown handler, named so the shortcut is exercised directly. */
export function submitFormOnShortcut(event: ShortcutKeydown) {
  if (!submitsFormOnShortcut(event)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

export function CreateIssueForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="create-form" onSubmit={onSubmit}><label htmlFor="new-issue">Create an issue</label><input id="new-issue" name="title" placeholder="What needs doing?" maxLength={200} required /><label htmlFor="new-issue-body">Description</label><textarea id="new-issue-body" name="body" placeholder="Describe the goal, context, or acceptance criteria…" maxLength={10_000} onKeyDown={submitFormOnShortcut} /><small>{ISSUE_FORM_HINT}</small><div><button type="submit">Create issue</button><small>{ISSUE_FORM_SUBMIT_HINT}</small></div></form>;
}

/**
 * The comment composer, extracted from `Thread` so its keyboard wiring is
 * reachable without rendering a whole issue thread.
 *
 * Ctrl+Enter and Meta+Enter go through the form's own `requestSubmit()`, which
 * is the *same* path the Post message button takes: the native `required`
 * check runs first, and `onSubmit` receives the same event either way. A
 * shortcut that called `comment` directly would bypass `required` and be a
 * second submit path, which is the thing a double-submit bug would live in.
 */
export function CommentComposer({ displayName, comment }: { displayName: string; comment: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="composer" onSubmit={comment}><div className="composer-heading"><label htmlFor="comment-body">Add a message</label><span>Posting as <strong>{displayName}</strong></span></div><textarea id="comment-body" name="body" maxLength={10_000} required onKeyDown={submitFormOnShortcut} /><div><span>Keep it useful and concise. {COMPOSER_SUBMIT_HINT}</span><button type="submit">Post message</button></div></form>;
}

function FirstRun({ error, initializing, initialize, recheck }: { error: string | undefined; initializing: boolean; initialize: () => void; recheck: () => void }) {
  return <section className="first-run"><p className="eyebrow">Antonina</p><h1>{FIRST_RUN_COPY.title}</h1><p>{FIRST_RUN_COPY.body}</p>{error && <p role="alert">{error}</p>}<div className="first-run-actions"><button className="primary" disabled={initializing} onClick={initialize}>{FIRST_RUN_COPY.action}</button><button className="quiet" disabled={initializing} onClick={recheck}>{FIRST_RUN_COPY.recheck}</button></div></section>;
}

function BoardKeyPrompt({ error, credentialInput, setCredentialInput, unlocking, unlock, retry }: { error: string | undefined; credentialInput: string; setCredentialInput: (value: string) => void; unlocking: boolean; unlock: (event: FormEvent<HTMLFormElement>) => Promise<void>; retry: () => void }) {
  return <section className="first-run"><p className="eyebrow">Antonina</p><h1>{BOARD_KEY_COPY.title}</h1><p>{BOARD_KEY_COPY.body}</p><form className="stacked-form" onSubmit={unlock}><label htmlFor="board-credential">Board credential</label><textarea id="board-credential" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} required /><small>{BOARD_KEY_COPY.hint}</small>{error && <p role="alert">{error}</p>}<div className="first-run-actions"><button className="primary" disabled={unlocking || !credentialInput.trim()} type="submit">{BOARD_KEY_COPY.action}</button><button className="quiet" type="button" disabled={unlocking} onClick={retry}>{FIRST_RUN_COPY.recheck}</button></div></form></section>;
}

function AccessNotice({ access, readOnly, className, onAction }: { access: ReadOnlyAccess; readOnly?: AccessCallout; className?: string; onAction: () => void }) {
  const callout = accessCallout(access, readOnly);
  return <div className={className}><div><strong>{callout.title}</strong><p>{callout.body}</p></div><button onClick={onAction}>{callout.action}</button></div>;
}

/**
 * The Resources tab.
 *
 * Paging changed what is drawn, not what a resource is. The view is handed the
 * board's resources and the page number, takes that page of them, and groups
 * exactly what it was handed: `groupResources` is the same call over the same
 * `BoardResource` values, so hosts are still sorted by name and paths by path,
 * and a dependency chip, its state label, its remove control and its
 * add-dependency form are the same controls over the same issues as before.
 * The register form, the access notice and the empty state are untouched.
 */
function ResourcesView({ resources, issues, access, page, onPage, onOpenIssue, onAdd, onRemove, onEnableEditing, hrefForIssue }: { resources: BoardResource[]; issues: IssueReference[]; access: BoardAccess; page: number; onPage: (page: number) => void; onOpenIssue: (number: number) => void; hrefForIssue?: (number: number) => string; onAdd: (host: string, path: string, number: number) => Promise<unknown>; onRemove: (resource: BoardResource, number: number) => Promise<unknown>; onEnableEditing: () => void }) {
  // The page is a slice of the board's own resource order, and the total the
  // controls clamp against is the whole collection rather than the slice — so
  // the position line and the disabled boundaries describe the board, not the
  // window. Grouping happens after the slice, so a page may hold several hosts.
  const paged = resourcePage(resources, page);
  const grouped = groupResources(paged);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await onAdd(String(data.get('host')), String(data.get('path')), Number(data.get('issue'))); if (result) form.reset(); }
  return <div className="resources-view">
    {access === 'editable' && <form className="resource-form" onSubmit={add}><h2>Register a resource</h2><p>Add a host and path, protected by at least one open issue.</p><label htmlFor="resource-host">Lubko host</label><input id="resource-host" name="host" placeholder="lubko://server-name" required /><label htmlFor="resource-path">Absolute path</label><input id="resource-path" name="path" placeholder="/registered/path" required /><label htmlFor="resource-issue">Open issue</label><select id="resource-issue" name="issue" required><option value="">Choose an issue</option>{issues.filter((issue) => issue.state === 'open').map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add dependency</button></form>}
    {access !== 'editable' && <AccessNotice access={access} className="access-callout" onAction={onEnableEditing} />}

    {grouped.map(([host, entries]) => <section className="resource-host" key={host}><h2>{host}</h2>{entries.map((resource) => <article className="resource-card" key={resource.path}><header><code>{resource.path}</code><span className={`resource-state ${resourceState(resource, issues)}`}>{resourceState(resource, issues)}</span></header><div className="dependency-chips">{resource.issueNumbers.map((number) => { const issue = issues.find((entry) => entry.number === number)!; return <span className="dependency-chip" key={number}><a role="button" href={hrefForIssue?.(number)} onClick={issueLinkClick(onOpenIssue, number)}>#{number} {issue.title}</a><span className={`state-label ${issue.state}`}>{issue.state}</span>{access === 'editable' && <button aria-label={`Remove issue ${number}`} onClick={() => void onRemove(resource, number)}>×</button>}</span>; })}</div>{access === 'editable' && <AddDependency resource={resource} issues={issues} add={onAdd} />}</article>)}</section>)}
    {!resources.length && <div className="empty-state"><h2>No resources registered</h2><p>Registered paths appear here grouped by Lubko host.</p></div>}
    <IssuePagination total={resources.length} page={page} pageSize={RESOURCE_PAGE_SIZE} onPage={onPage} label={RESOURCE_LIST_PAGES_LABEL} />
  </div>;
}
function AddDependency({ resource, issues, add }: { resource: BoardResource; issues: IssueReference[]; add: (host: string, path: string, number: number) => Promise<unknown> }) { const options = issues.filter((issue) => issue.state === 'open' && !resource.issueNumbers.includes(issue.number)); if (!options.length) return null; return <form className="dependency-add" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await add(resource.host, resource.path, Number(data.get('issue'))); if (result) form.reset(); }}><select name="issue" required defaultValue=""><option value="" disabled>Add open issue dependency…</option>{options.map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add</button></form>; }

/**
 * The feed tab's container. It owns nothing but the page it last read: every
 * entry, the order, the total and the continuation token come from the core
 * projection, which is the same one `antonina board feed` reads. The container
 * decides only when to read — on open, on every verified board read, and again
 * when the reader asks for the next page — and the next page is requested with
 * the token the backend returned, never with an offset the browser computed.
 */
export function FeedView({ readFeed, issues, generation, onOpenIssue, hrefForIssue }: {
  readFeed: FeedRead;
  issues: IssueReference[];
  generation: number;
  onOpenIssue: (number: number) => void;
  hrefForIssue?: (number: number) => string;
}) {
  const [page, setPage] = useState<BoardFeedPage | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const read = useCallback(readFeed, [readFeed]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void (async () => {
      try {
        const newest = await readFeedFirstPage(read);
        if (!live) return;
        setPage(newest);
        setError(undefined);
      } catch (cause) {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : 'The board feed could not be read');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [read, generation]);
  async function showMore() {
    if (page === null || page.nextCursor === null) return;
    setLoading(true);
    try {
      // The backend's own token, carried unchanged: it names a stable position
      // in the materialized feed, so this page is the entries committed before
      // it and a walk neither skips nor repeats an entry.
      setPage(await appendFeedPage(read, page, page.nextCursor));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Older entries could not be read');
    } finally {
      setLoading(false);
    }
  }
  return <FeedThread
    entries={page?.entries ?? []}
    nextCursor={page?.nextCursor ?? null}
    total={page?.total ?? 0}
    issues={issues}
    loading={loading}
    error={error}
    onShowMore={() => void showMore()}
    onOpenIssue={onOpenIssue}
    hrefForIssue={hrefForIssue}
  />;
}

/**
 * The feed, rendered exactly as the core projection reported it.
 *
 * Nothing here sorts, filters, groups or re-limits: the page arrives newest
 * first and is drawn in that order, so the top entry is the operation the log
 * committed last. The continuation token is the backend's, so the control that
 * asks for older entries is offered only while that token exists — when it is
 * `null` the backend says the feed is exhausted, and this view says so rather
 * than inviting a request that could only return the same page.
 *
 * The two kinds the board does not record are named in place, in a line of its
 * own, because a reader who has seen an "Edited" entry could otherwise wonder
 * where the field-level history went.
 */
export interface FeedThreadProps {
  /** The page the projection returned, in the order it returned it. */
  entries: BoardFeedEntry[];
  /** The backend's own continuation token, or `null` when the feed is exhausted. */
  nextCursor: string | null;
  /** How many entries the whole feed holds, per the same page. */
  total: number;
  /** The board view, used only to report the issues the log never recorded. */
  issues: IssueReference[];
  loading: boolean;
  error: string | undefined;
  onShowMore: () => void;
  onOpenIssue: (number: number) => void;
  /**
   * The address of one issue's thread, so a feed entry is a real link a reader
   * can copy or open in a new tab. It defaults to the board's own issue route
   * for a caller that has no current location to build it from.
   */
  hrefForIssue?: (number: number) => string;
}

export function FeedThread({ entries, nextCursor, total, issues, loading, error, onShowMore, onOpenIssue, hrefForIssue = (number) => issueHref(number, DEFAULT_BOARD_URL_STATE) }: FeedThreadProps) {
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const untracked = unplacedIssueNumbers(issues, entries, nextCursor, total);
  return <div className="feed-view-inner">
    {error && <p className="feed-error" role="alert">{error}</p>}
    {entries.length > 0 && <p className="feed-count">{FEED_COUNT_LABEL(entries.length, total)}</p>}
    <ol className="feed-list" aria-label="Board activity, newest first">{entries.map((entry) => <li className={`feed-entry feed-${entry.kind}`} key={entry.id} data-feed-id={entry.id} data-feed-kind={entry.kind}>
      <span className={`feed-kind feed-kind-${entry.kind}`}>{FEED_KIND_LABEL[entry.kind]}</span>
      <span className="feed-detail">
        {/* A deleted issue is an event about something the board no longer
            holds, so its row names the issue and offers no way to open it. Every
            other kind names an issue that is still on the board, and clicking it
            goes to that issue's own thread. */}
        {entry.kind === 'issue-deleted'
          ? <span className="feed-issue">#{entry.issueNumber} {entry.title}</span>
          : <a className="feed-issue" role="button" href={hrefForIssue(entry.issueNumber)} onClick={issueLinkClick(onOpenIssue, entry.issueNumber)}>#{entry.issueNumber} {entry.title}</a>}
        <span className="feed-summary">{feedEntrySummary(entry)}</span>
      </span>
      <time className="feed-at" dateTime={entry.at}>{date.format(new Date(entry.at))}</time>
    </li>)}</ol>
    {!entries.length && !loading && !error && <div className="empty-state"><h2>{FEED_EMPTY.title}</h2><p>{FEED_EMPTY.body}</p></div>}
    {untracked.length > 0 && <p className="feed-caveat" role="note">{FEED_TRUNCATED_COPY(untracked)}</p>}
    <p className="feed-untracked">{FEED_UNTRACKED_COPY}</p>
    {nextCursor !== null && <button className="feed-more" disabled={loading} onClick={onShowMore}>{FEED_MORE_LABEL}</button>}
  </div>;
}

/**
 * The execution-target overview.
 *
 * Each target is drawn from what is true of *that* target rather than from one
 * machine-shaped template. A persistent host shows its access method, its
 * durability, who cleans up after it, and — when a daemon report reached the
 * page — its real capacity. An ephemeral environment shows the same four
 * questions answered `not applicable` or `unknown`, each with the reason, and
 * never a RAM or disk figure, because there is no host to measure and a number
 * here would be one an orchestrator schedules against.
 *
 * The target's own record points at the guidance document that says how to
 * reach and use it. The page links to the reference rather than repeating the
 * procedure: the procedure changes when the backend changes, and a second copy
 * in board state is a second copy that goes stale.
 */
export function TargetsView({ targets, hosts, onOpenIssue, hrefForIssue }: {
  targets: TargetView[];
  hosts: DaemonHostView[];
  onOpenIssue: (number: number) => void;
  hrefForIssue?: (number: number) => string;
}) {
  const rows = targetCatalogRows(targets, hosts);
  return <div className="targets-view">
    <p className="targets-scope">A target is an execution environment a job may be dispatched to. It is not a resource: only a persistent host carries durable paths, and those are registered separately under Resources.</p>
    {rows.map(({ target, access, state }) => <article className={`target-card target-${access.kind}`} key={target.id} data-target-id={target.id}>
      <header className="target-header">
        <div>
          <p className="eyebrow">{TARGET_KIND_LABEL[access.kind]}</p>
          <h2>{access.displayName}</h2>
          <code className="target-identity">{access.targetId}{access.address === null ? ' · no host address' : ' · ' + access.address}</code>
        </div>
        <span className={`target-status ${access.status}`}>{TARGET_STATUS_LABEL[access.status]}</span>
      </header>
      {access.description !== '' && <p className="target-description">{access.description}</p>}
      <dl className="target-facts">
        <div><dt>Access method</dt><dd>{TARGET_ACCESS_LABEL[access.accessMethod]}</dd></div>
        <div><dt>Persistence</dt><dd>{TARGET_PERSISTENCE_LABEL[access.persistence]}</dd></div>
        <div><dt>Cleanup</dt><dd>{TARGET_CLEANUP_LABEL[access.garbageCollection]}</dd></div>
        <div><dt>Capabilities</dt><dd>{access.capabilities.length === 0 ? 'none declared' : access.capabilities.join(', ')}</dd></div>
      </dl>
      <section className="target-state" aria-label={`Live state of ${access.displayName}`}>
        <h3>Live state</h3>
        <dl>{state.map((line) => <div key={line.label} data-state={line.absent ? 'absent' : 'reported'}><dt>{line.label}</dt>
          <dd><span className={line.absent ? 'state-unknown' : 'state-value'}>{line.value}</span>
            {line.absent && line.reason !== undefined && <small>{line.reason}</small>}
            {line.note !== undefined && <small>{line.note}</small>}</dd></div>)}</dl>
      </section>
      {access.limitations.length > 0 && <section className="target-caveats"><h3>Caveats</h3><ul>{access.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></section>}
      <section className="target-guidance"><h3>Guidance</h3><ul>{access.guidance.map((path) => <li key={path}><code>{path}</code></li>)}</ul></section>
      <footer className="target-links">
        {target.resources.length > 0 && <p>{target.resources.length} registered resource{target.resources.length === 1 ? '' : 's'} on this host — registered paths live under Resources, not here.</p>}
        {target.dispatchedIssues.length > 0 && <p className="target-dispatched">Dispatched: {target.dispatchedIssues.map((number) => <a role="button" key={number} href={hrefForIssue?.(number)} onClick={issueLinkClick(onOpenIssue, number)}>#{number}</a>)}</p>}
      </footer>
    </article>)}
    {rows.length === 0 && <div className="empty-state"><h2>{TARGETS_EMPTY.title}</h2><p>{TARGETS_EMPTY.body}</p></div>}
  </div>;
}

function Thread({ issue, access, displayName, setDisplayName, saveDisplayName, openSettings, comment, editBody, close, reopen, back }: { issue: BoardIssue; access: BoardAccess; displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event?: FormEvent<HTMLFormElement>) => void; openSettings: () => void; comment: (event: FormEvent<HTMLFormElement>) => Promise<void>; editBody: (body: string) => Promise<unknown>; close: () => void; reopen: () => void; back: () => void }) {
  const [editing, setEditing] = useState(false); const [body, setBody] = useState(issue.body);
  useEffect(() => { setBody(issue.body); setEditing(false); }, [issue.body, issue.number]);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return <article className="thread"><button className="back-button" onClick={back}><span aria-hidden="true">←</span> All issues</button><header className="thread-header"><div className="thread-title"><p className="eyebrow">Issue #{issue.number} <span className={`state-label ${issue.state}`}>{issue.state}</span></p><h1>{issue.title}</h1><p>Updated {formatUpdatedAt(issue.updatedAt)} · {issue.messages.length} messages</p></div>{access === 'editable' ? <button className={`state-action ${issue.state}`} onClick={issue.state === 'open' ? close : reopen}>{issue.state === 'open' ? 'Close issue' : 'Reopen issue'}</button> : <span className="read-only-label">Read-only view</span>}</header>
    <section className="issue-description"><div className="description-heading"><h2>Description</h2>{access === 'editable' && issue.state === 'open' && !editing && <button onClick={() => setEditing(true)}>Edit description</button>}</div>{editing ? <form onSubmit={async (event) => { event.preventDefault(); const result = await editBody(body); if (result) setEditing(false); }}><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={10_000} aria-label="Issue description" /><div><button type="submit">Save description</button><button type="button" onClick={() => { setBody(issue.body); setEditing(false); }}>Cancel</button></div></form> : issue.body ? <p>{issue.body}</p> : <p className="empty-description">No description was provided.</p>}</section>
    <section className="messages" aria-label="Issue conversation"><h2>Conversation</h2>{issue.messages.length ? issue.messages.map((message) => <article className="message" key={message.id}><div className="message-meta"><span className="avatar" aria-hidden="true">{message.author.slice(0, 1).toUpperCase()}</span><div><strong>{message.author}</strong><time dateTime={message.createdAt}>{date.format(new Date(message.createdAt))}</time></div></div><p>{message.body}</p></article>) : <div className="conversation-empty"><h2>No conversation yet</h2><p>Add the first message to share context or ask a question.</p></div>}</section>
    <div className="composer-area">{access !== 'editable' ? <AccessNotice access={access} readOnly={COMPOSER_READ_ONLY_CALLOUT} className="composer-access" onAction={openSettings} /> : !displayName.trim() ? <form className="name-prompt" onSubmit={saveDisplayName}><label htmlFor="composer-name">Before you post, tell everyone who you are</label><div><input id="composer-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /><button type="submit">Save name</button></div></form> : <CommentComposer displayName={displayName} comment={comment} />}</div>
  </article>;
}

function SettingsPanel({ displayName, setDisplayName, saveDisplayName, access, credentialInput, setCredentialInput, saveCredential, clearCredential, credentialText, copyKey, close }: { displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event: FormEvent<HTMLFormElement>) => void; access: BoardAccess; credentialInput: string; setCredentialInput: (value: string) => void; saveCredential: (event: FormEvent<HTMLFormElement>) => Promise<void>; clearCredential: () => void; credentialText: string | null; copyKey: (text: string | null, label: string) => Promise<void>; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'Tab') return;
      const dialog = closeRef.current?.closest<HTMLElement>('[role="dialog"]');
      const controls = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')) : [];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = overflow; previous?.focus(); };
  }, [close]);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><h2 id="settings-title">Settings & access</h2><button ref={closeRef} className="dialog-close" onClick={close} aria-label="Close settings">×</button></header><div className="settings-content"><section><h3>Display name</h3><form className="stacked-form" onSubmit={saveDisplayName}><label htmlFor="settings-name">Display name</label><input id="settings-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><button type="submit" disabled={!displayName.trim()}>Save name</button></form></section><section><h3>Board access</h3><p>{WRITE_ACCESS_SUMMARY}</p>{access === 'rejected' && <div className="access-state"><strong>{REJECTED_CREDENTIAL_COPY.title}</strong><p>{REJECTED_CREDENTIAL_COPY.body}</p></div>}{access === 'editable' ? <><div className="access-state">Board access is enabled</div><div className="technical-actions"><button onClick={() => void copyKey(credentialText, 'Board credential')}>Copy board credential</button><button className="danger" onClick={clearCredential}>Leave board</button></div></> : <form className="stacked-form" onSubmit={saveCredential}><label htmlFor="credential">Board credential</label><textarea id="credential" placeholder="Paste the board credential JSON" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} required /><small>The credential comes from another browser, user, or agent that already has full board access.</small><button type="submit" disabled={!credentialInput.trim()}>Open board</button></form>}</section></div></section></div>;
}
