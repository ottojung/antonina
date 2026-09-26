import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createBrowserBoardApi } from './api';
import { resourceState, type Board, type BoardIssue, type BoardResource } from './model';
import { COMPOSER_READ_ONLY_CALLOUT, accessCallout, boardAccess, boardDeleted, boardLoadFailed, boardLoaded, canMoveInQueue, DELETED_COPY, emptyIssueList, filterLabel, ISSUE_FORM_HINT, ISSUE_FORM_SUBMIT_HINT, firstRunResolved, firstRunUnresolved, formatUpdatedAt, groupResources, issueCounts, moveQueueEarlier, moveQueueIssue, moveQueueLater, openQueueOrder, priorityLabel, queuePosition, trustRequired, visibleIssues, QUEUE_DRAG_TYPE, QUEUE_HINT, QUEUE_MOVE_LABELS, QUEUE_REORDERED_NOTICE, QUEUE_REORDER_FAILED, WRITE_ACCESS_SUMMARY, REJECTED_CREDENTIAL_COPY, FIRST_RUN_COPY, TRUST_COPY, type AccessCallout, type BoardAccess, type BoardLoad, type IssueFilter, type QueueDirection, type ReadOnlyAccess } from './ui-state';

const DISPLAY_NAME_KEY = 'antonina:display-name';
const REFRESH_INTERVAL = 30_000;
type View = 'issues' | 'resources';

export default function App() {
  const session = useMemo(() => createBrowserBoardApi(), []);
  const api = session.api;
  const [load, setLoad] = useState<BoardLoad>({ status: 'loading' });
  const [view, setView] = useState<View>('issues');
  const [selectedNumber, setSelectedNumber] = useState<number>();
  const [filter, setFilter] = useState<IssueFilter>('open');
  const [displayName, setDisplayName] = useState(() => window.localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
  const [access, setAccess] = useState<BoardAccess>('read-only');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [credentialInput, setCredentialInput] = useState('');
  const [anchorInput, setAnchorInput] = useState('');
  const [trusting, setTrusting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [initializing, setInitializing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const verified = await session.readState();
      setLoad(boardLoaded(verified));
      if (verified === null) {
        setAccess('read-only');
        setError(undefined);
        return;
      }
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
  const hasBoard = board !== undefined;
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!hasBoard) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [hasBoard, refresh]);

  const visible = ready ? visibleIssues(ready.board.issues, ready.queue, filter) : [];
  const counts = issueCounts(board?.issues ?? []);
  const hasWriteAccess = access === 'editable';
  const empty = emptyIssueList(filter, hasWriteAccess);
  const selected = board?.issues.find((issue) => issue.number === selectedNumber);
  useEffect(() => { if (selected && !visible.some((issue) => issue.number === selected.number)) setSelectedNumber(undefined); }, [selected, visible]);

  async function run<T>(action: () => Promise<T>, success: string): Promise<T | null> {
    setError(undefined); setNotice(undefined);
    try { const result = await action(); await refresh(); setNotice(success); return result; }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The change could not be saved';
      // A refused mutation drops this client to read-only, so read access
      // again instead of leaving a stale edit indicator until the next poll.
      await refresh();
      setError(message);
      return null;
    }
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
  function openIssue(number: number) { setView('issues'); setFilter('all'); setSelectedNumber(number); }
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
  function clearCredential() { session.clearCredential(); setAccess('read-only'); setNotice('Write access cleared from this browser'); }
  async function copyKey(text: string | null, label: string) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setNotice(`${label} copied`); }
    catch { setError('The browser did not allow access to the clipboard'); }
  }
  async function trustBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setTrusting(true); setError(undefined);
    try {
      await session.trust(anchorInput);
      setAnchorInput('');
      setLoad(boardLoaded(await session.readState()));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The trust anchor could not be accepted'); }
    finally { setTrusting(false); }
  }
  async function initializeBoard() {
    setInitializing(true); setError(undefined); setNotice(undefined);
    try {
      await session.initialize();
      setAccess('editable');
      setLoad(boardLoaded(await session.readState()));
      setNotice('Board initialized; this browser holds the root signing credential');
    } catch (cause) {
      const { load: resolved, error } = firstRunResolved(await resolveFirstRun(), cause);
      setLoad(resolved);
      if (error) setError(error);
      else setNotice(FIRST_RUN_COPY.raced);
    } finally { setInitializing(false); }
  }
  async function resolveFirstRun(): Promise<BoardLoad> {
    try { return boardLoaded(await session.readState()); }
    catch (cause) { return firstRunUnresolved(cause); }
  }
  /** The one write path for priority: it commits a whole queue or changes nothing. */
  const queueCommit: QueueCommit = {
    reorder: (numbers) => api.reorderQueue(numbers),
    reload: refresh,
    notice: setNotice,
    failure: setError,
  };
  const reorderQueue = useCallback((numbers: number[] | null) => commitQueueOrder(numbers, queueCommit), [api]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  if (load.status === 'loading') return <main className="centered"><div><span className="loading-dot" /> Loading your shared board…</div></main>;
  if (load.status === 'failed') return <main className="centered"><section className="load-error"><p className="eyebrow">Antonina</p><h1>The board could not be loaded</h1><p>{load.message}</p><button className="primary" onClick={() => void refresh()}>Try again</button></section></main>;
  if (load.status === 'uninitialized') return <main className="centered"><FirstRun error={error} initializing={initializing} initialize={() => void initializeBoard()} recheck={() => void refresh()} /></main>;
  if (load.status === 'untrusted') return <main className="centered"><TrustAnchor error={error} anchorInput={anchorInput} setAnchorInput={setAnchorInput} trusting={trusting} trust={trustBoard} retry={() => void refresh()} /></main>;
  if (load.status === 'deleted') return <main className="centered"><section className="first-run"><p className="eyebrow">Antonina</p><h1>{DELETED_COPY.title}</h1><p>{DELETED_COPY.body}</p></section></main>;

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => { setView('issues'); setSelectedNumber(undefined); }} aria-label="Back to all Antonina issues"><span className="brand-mark" aria-hidden="true">A</span><span><strong>Antonina</strong><small>Shared issue board</small></span></button>
      <nav className="main-nav" aria-label="Main navigation">{(['issues', 'resources'] as const).map((item) => <button key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => { setView(item); setSelectedNumber(undefined); }}>{item}</button>)}</nav>
      <div className="top-actions"><span className={`access-pill ${hasWriteAccess ? 'writable' : ''}`}><span aria-hidden="true" />{hasWriteAccess ? 'Can edit' : 'Read only'}</span><button className="quiet" onClick={() => void refresh()}>Refresh</button><button className="quiet" onClick={() => setSettingsOpen(true)}>Settings</button></div>
    </header>
    {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error">Dismiss</button></div>}
    {notice && <div className="notice success" role="status"><span>{notice}</span><button onClick={() => setNotice(undefined)} aria-label="Dismiss message">Dismiss</button></div>}
    <main className={`workspace ${view}-view ${selected ? 'has-selection' : ''}`}>
      <aside className="issue-pane" aria-label={view === 'issues' ? 'Shared issue list' : 'Registered resources'}>
        <div className="pane-heading"><div><p className="eyebrow">One board, everyone’s work</p><h1>{view === 'issues' ? 'Issues' : 'Resources'}</h1><p>{view === 'issues' ? <>{QUEUE_HINT} Track what needs attention and discuss the details together.</> : 'Registered paths are protected while at least one dependent Antonina issue remains open.'}</p></div></div>
        {view === 'issues' ? <>
          {hasWriteAccess ? <CreateIssueForm onSubmit={createIssue} />
            : <AccessNotice access={access} className="access-callout" onAction={() => setSettingsOpen(true)} />}
          <nav className="filters" aria-label="Filter issues">{(['open', 'closed', 'all'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{filterLabel(value)}<span>{counts[value]}</span></button>)}</nav>
          <div className="issue-list" aria-label="Issues"><IssueQueue issues={visible} queue={load.queue} hasWriteAccess={hasWriteAccess} selectedNumber={selectedNumber} onSelect={setSelectedNumber} onReorder={reorderQueue} empty={empty} /></div>
        </> : <ResourcesView board={board!} issues={board!.issues} access={access} onOpenIssue={openIssue} onAdd={(host, path, number) => run(() => api.addResourceDependency(host, path, number), 'Resource dependency added')} onRemove={(resource, number) => run(() => api.removeResourceDependency(resource.host, resource.path, number), resource.issueNumbers.length === 1 ? 'Dependency removed; resource unregistered' : 'Resource dependency removed')} onEnableEditing={() => setSettingsOpen(true)} />}
      </aside>
      {view === 'issues' ? selected ? <Thread issue={selected} access={access} displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} openSettings={() => setSettingsOpen(true)} comment={postComment} editBody={(body) => run(() => api.editIssueBody(selected.number, body), 'Description updated')} close={() => void run(() => api.close(selected.number), 'Issue closed')} reopen={() => void run(() => api.reopen(selected.number), 'Issue reopened')} back={() => setSelectedNumber(undefined)} />
        : <section className="thread welcome"><div className="welcome-mark" aria-hidden="true">A</div><p className="eyebrow">Shared issue board</p><h2>Choose an issue to join the conversation.</h2></section> : null}
    </main>
    {settingsOpen && <SettingsPanel displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} access={access} credentialInput={credentialInput} setCredentialInput={setCredentialInput} saveCredential={saveCredential} clearCredential={clearCredential} credentialText={session.credentialText()} trustAnchorText={session.trustAnchorText()} copyKey={copyKey} close={closeSettings} />}
  </div>;
}

export type IssueFormKey = Pick<ReactKeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat'>;

/** What a drag or a move control reports: the whole reordered open queue. */
export type QueueTarget = number[] | null;

export interface QueueCommit {
  reorder(numbers: number[]): Promise<number[]>;
  reload(): Promise<void>;
  notice(message: string): void;
  failure(message: string): void;
}

/**
 * The single write path for priority, shared by the drag target and the
 * move-earlier/move-later controls.
 *
 * A refused reorder — no `queue.reorder` capability, a concurrent writer that
 * moved the board on, a storage conflict — must not read as success and must not
 * leave the list showing an order the board never accepted, so the failure path
 * re-reads the board (and with it the queue) and surfaces the board's own
 * reason. A `null` target is the deliberate no-op of a boundary move: nothing is
 * sent, and no error is invented for a queue that would not have changed.
 */
export async function commitQueueOrder(target: QueueTarget, commit: QueueCommit): Promise<number[] | null> {
  if (target === null) return null;
  try {
    const committed = await commit.reorder(target);
    await commit.reload();
    commit.notice(QUEUE_REORDERED_NOTICE);
    return committed;
  } catch (cause) {
    await commit.reload();
    commit.failure(cause instanceof Error ? cause.message : QUEUE_REORDER_FAILED);
    return null;
  }
}

/** The issue row a pointer-less test event stands in for, and its shared queue. */
export type QueueRowTarget = { dataset: { issue?: string; queue?: string; direction?: string } };

export function queueOfTarget(target: QueueRowTarget): number[] {
  const raw = target.dataset.queue;
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

export type IssueDragStart = { currentTarget: QueueRowTarget; dataTransfer: { setData(type: string, value: string): void } | null };

/** A drag carries the issue number, so a drop does not have to trust the row. */
export function issueDragStarted(event: IssueDragStart): void {
  const number = event.currentTarget.dataset.issue;
  if (number === undefined) return;
  event.dataTransfer?.setData(QUEUE_DRAG_TYPE, number);
}

export type IssueDrop = {
  currentTarget: QueueRowTarget;
  dataTransfer: { getData(type: string): string } | null;
  preventDefault(): void;
};

export function allowIssueDrop(event: { preventDefault(): void }): void {
  event.preventDefault();
}

/**
 * A drop reorders the queue the row was rendered with, so a drag commits the
 * same complete permutation the move controls commit — never the dragged pair.
 */
export function issueDropped(event: IssueDrop): QueueTarget {
  event.preventDefault();
  const dragged = Number(event.dataTransfer?.getData(QUEUE_DRAG_TYPE));
  const order = queueOfTarget(event.currentTarget);
  const over = Number(event.currentTarget.dataset.issue);
  return moveQueueIssue(order, dragged, order.indexOf(over));
}

export type IssueMoveClick = { currentTarget: QueueRowTarget; preventDefault(): void };

/**
 * The keyboard-reachable alternative to dragging: the same whole-queue
 * permutation, computed from the direction the control names.
 */
export function issueMoveRequested(event: IssueMoveClick): QueueTarget {
  event.preventDefault();
  const order = queueOfTarget(event.currentTarget);
  const number = Number(event.currentTarget.dataset.issue);
  return event.currentTarget.dataset.direction === 'later' ? moveQueueLater(order, number) : moveQueueEarlier(order, number);
}

export function IssueQueue({ issues, queue, hasWriteAccess, selectedNumber, onSelect, onReorder, empty }: {
  issues: BoardIssue[];
  queue: number[];
  hasWriteAccess: boolean;
  selectedNumber: number | undefined;
  onSelect: (number: number) => void;
  onReorder: (target: QueueTarget) => Promise<number[] | null>;
  empty: { title: string; body: string };
}) {
  // One order for the whole list: the shared queue, then any open issue it has
  // not caught up with. It is written onto every row so a drag or a move control
  // recomputes the full permutation from the same snapshot that was rendered.
  const order = openQueueOrder(issues, queue);
  const attribute = JSON.stringify(order);
  return <>
    {issues.map((issue) => <IssueQueueRow key={issue.number} issue={issue} order={order} queueAttribute={attribute} position={queuePosition(order, issue.number)} hasWriteAccess={hasWriteAccess} selected={issue.number === selectedNumber} onSelect={onSelect} onReorder={onReorder} />)}
    {!issues.length && <div className="empty-state"><h2>{empty.title}</h2><p>{empty.body}</p></div>}
  </>;
}

function IssueQueueRow({ issue, order, queueAttribute, position, hasWriteAccess, selected, onSelect, onReorder }: {
  issue: BoardIssue;
  order: number[];
  queueAttribute: string;
  position: number;
  hasWriteAccess: boolean;
  selected: boolean;
  onSelect: (number: number) => void;
  onReorder: (target: QueueTarget) => Promise<number[] | null>;
}) {
  return <div className={`issue-row ${selected ? 'selected' : ''}`} data-issue={issue.number} data-queue={queueAttribute} draggable={hasWriteAccess} onDragStart={hasWriteAccess ? issueDragStarted : undefined} onDragOver={hasWriteAccess ? allowIssueDrop : undefined} onDrop={hasWriteAccess ? (event) => { void onReorder(issueDropped(event)); } : undefined}>
    <button className="issue-select" onClick={() => onSelect(issue.number)} aria-current={selected ? 'true' : undefined}><span className="issue-summary"><span className="issue-line"><strong>#{issue.number}</strong><span className={`state-label ${issue.state}`}>{issue.state}</span><time dateTime={issue.updatedAt}>Updated {formatUpdatedAt(issue.updatedAt)}</time></span><span className="issue-title">{issue.title}</span><span className="issue-meta">{issue.messages.length} messages{issue.body ? ' · has description' : ''}</span></span><span className="row-arrow" aria-hidden="true">›</span></button>
    {position > 0 && <span className="queue-position" aria-label={priorityLabel(position)}>{position}</span>}
    {hasWriteAccess && position > 0 && <span className="queue-controls">{(['earlier', 'later'] as QueueDirection[]).map((direction) => <button key={direction} data-issue={issue.number} data-direction={direction} aria-label={`${QUEUE_MOVE_LABELS[direction]} (#${issue.number})`} disabled={!canMoveInQueue(order, issue.number, direction)} onClick={(event) => { void onReorder(issueMoveRequested(event)); }}>{direction === 'earlier' ? '▲' : '▼'}</button>)}</span>}
  </div>;
}


/** The keydown the description hands the rule: the keystroke plus its two browser effects. */
export type IssueFormKeydown = IssueFormKey & {
  preventDefault(): void;
  currentTarget: { form: { requestSubmit(): void } | null };
};

/**
 * Ctrl+Enter in the description is routed to the form's own `requestSubmit()`,
 * so it submits exactly the way the Create issue button does and runs the same
 * native `required` validation before `onSubmit`. Plain Enter is left alone so
 * it keeps inserting a newline, no other modifier combination is claimed, and
 * an auto-repeat is ignored: a held key would otherwise re-enter `createIssue`
 * while the first call is still in flight and create a second issue from one
 * deliberate press.
 */
export function submitsIssueForm(event: IssueFormKey): boolean {
  return event.key === 'Enter' && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !event.repeat;
}

/** The description's keydown handler, named so the shortcut is exercised directly. */
export function submitCreateFormOnShortcut(event: IssueFormKeydown) {
  if (!submitsIssueForm(event)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

export function CreateIssueForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="create-form" onSubmit={onSubmit}><label htmlFor="new-issue">Create an issue</label><input id="new-issue" name="title" placeholder="What needs doing?" maxLength={200} required /><label htmlFor="new-issue-body">Description</label><textarea id="new-issue-body" name="body" placeholder="Describe the goal, context, or acceptance criteria…" maxLength={10_000} onKeyDown={submitCreateFormOnShortcut} /><small>{ISSUE_FORM_HINT}</small><div><button type="submit">Create issue</button><small>{ISSUE_FORM_SUBMIT_HINT}</small></div></form>;
}

function FirstRun({ error, initializing, initialize, recheck }: { error: string | undefined; initializing: boolean; initialize: () => void; recheck: () => void }) {
  return <section className="first-run"><p className="eyebrow">Antonina</p><h1>{FIRST_RUN_COPY.title}</h1><p>{FIRST_RUN_COPY.body}</p>{error && <p role="alert">{error}</p>}<div className="first-run-actions"><button className="primary" disabled={initializing} onClick={initialize}>{FIRST_RUN_COPY.action}</button><button className="quiet" disabled={initializing} onClick={recheck}>{FIRST_RUN_COPY.recheck}</button></div></section>;
}

function TrustAnchor({ error, anchorInput, setAnchorInput, trusting, trust, retry }: { error: string | undefined; anchorInput: string; setAnchorInput: (value: string) => void; trusting: boolean; trust: (event: FormEvent<HTMLFormElement>) => Promise<void>; retry: () => void }) {
  return <section className="first-run"><p className="eyebrow">Antonina</p><h1>{TRUST_COPY.title}</h1><p>{TRUST_COPY.body}</p><form className="stacked-form" onSubmit={trust}><label htmlFor="trust-anchor">Board trust anchor</label><textarea id="trust-anchor" value={anchorInput} onChange={(event) => setAnchorInput(event.target.value)} required /><small>{TRUST_COPY.hint}</small>{error && <p role="alert">{error}</p>}<div className="first-run-actions"><button className="primary" disabled={trusting || !anchorInput.trim()} type="submit">{TRUST_COPY.action}</button><button className="quiet" disabled={trusting} onClick={retry}>{FIRST_RUN_COPY.recheck}</button></div></form></section>;
}

function AccessNotice({ access, readOnly, className, onAction }: { access: ReadOnlyAccess; readOnly?: AccessCallout; className?: string; onAction: () => void }) {
  const callout = accessCallout(access, readOnly);
  return <div className={className}><div><strong>{callout.title}</strong><p>{callout.body}</p></div><button onClick={onAction}>{callout.action}</button></div>;
}

function ResourcesView({ board, issues, access, onOpenIssue, onAdd, onRemove, onEnableEditing }: { board: Board; issues: BoardIssue[]; access: BoardAccess; onOpenIssue: (number: number) => void; onAdd: (host: string, path: string, number: number) => Promise<unknown>; onRemove: (resource: BoardResource, number: number) => Promise<unknown>; onEnableEditing: () => void }) {
  const grouped = groupResources(board.resources);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await onAdd(String(data.get('host')), String(data.get('path')), Number(data.get('issue'))); if (result) form.reset(); }
  return <div className="resources-view">
    {access === 'editable' && <form className="resource-form" onSubmit={add}><h2>Register a resource</h2><p>Add a host and path, protected by at least one open issue.</p><label htmlFor="resource-host">Lubko host</label><input id="resource-host" name="host" placeholder="lubko://server-name" required /><label htmlFor="resource-path">Absolute path</label><input id="resource-path" name="path" placeholder="/registered/path" required /><label htmlFor="resource-issue">Open issue</label><select id="resource-issue" name="issue" required><option value="">Choose an issue</option>{issues.filter((issue) => issue.state === 'open').map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add dependency</button></form>}
    {access !== 'editable' && <AccessNotice access={access} className="access-callout" onAction={onEnableEditing} />}

    {grouped.map(([host, resources]) => <section className="resource-host" key={host}><h2>{host}</h2>{resources.map((resource) => <article className="resource-card" key={resource.path}><header><code>{resource.path}</code><span className={`resource-state ${resourceState(resource, issues)}`}>{resourceState(resource, issues)}</span></header><div className="dependency-chips">{resource.issueNumbers.map((number) => { const issue = issues.find((entry) => entry.number === number)!; return <span className="dependency-chip" key={number}><button onClick={() => onOpenIssue(number)}>#{number} {issue.title}</button><span className={`state-label ${issue.state}`}>{issue.state}</span>{access === 'editable' && <button aria-label={`Remove issue ${number}`} onClick={() => void onRemove(resource, number)}>×</button>}</span>; })}</div>{access === 'editable' && <AddDependency resource={resource} issues={issues} add={onAdd} />}</article>)}</section>)}
    {!board.resources.length && <div className="empty-state"><h2>No resources registered</h2><p>Registered paths appear here grouped by Lubko host.</p></div>}
  </div>;
}
function AddDependency({ resource, issues, add }: { resource: BoardResource; issues: BoardIssue[]; add: (host: string, path: string, number: number) => Promise<unknown> }) { const options = issues.filter((issue) => issue.state === 'open' && !resource.issueNumbers.includes(issue.number)); if (!options.length) return null; return <form className="dependency-add" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await add(resource.host, resource.path, Number(data.get('issue'))); if (result) form.reset(); }}><select name="issue" required defaultValue=""><option value="" disabled>Add open issue dependency…</option>{options.map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add</button></form>; }

function Thread({ issue, access, displayName, setDisplayName, saveDisplayName, openSettings, comment, editBody, close, reopen, back }: { issue: BoardIssue; access: BoardAccess; displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event?: FormEvent<HTMLFormElement>) => void; openSettings: () => void; comment: (event: FormEvent<HTMLFormElement>) => Promise<void>; editBody: (body: string) => Promise<unknown>; close: () => void; reopen: () => void; back: () => void }) {
  const [editing, setEditing] = useState(false); const [body, setBody] = useState(issue.body);
  useEffect(() => { setBody(issue.body); setEditing(false); }, [issue.body, issue.number]);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return <article className="thread"><button className="back-button" onClick={back}><span aria-hidden="true">←</span> All issues</button><header className="thread-header"><div className="thread-title"><p className="eyebrow">Issue #{issue.number} <span className={`state-label ${issue.state}`}>{issue.state}</span></p><h1>{issue.title}</h1><p>Updated {formatUpdatedAt(issue.updatedAt)} · {issue.messages.length} messages</p></div>{access === 'editable' ? <button className={`state-action ${issue.state}`} onClick={issue.state === 'open' ? close : reopen}>{issue.state === 'open' ? 'Close issue' : 'Reopen issue'}</button> : <span className="read-only-label">Read-only view</span>}</header>
    <section className="issue-description"><div className="description-heading"><h2>Description</h2>{access === 'editable' && issue.state === 'open' && !editing && <button onClick={() => setEditing(true)}>Edit description</button>}</div>{editing ? <form onSubmit={async (event) => { event.preventDefault(); const result = await editBody(body); if (result) setEditing(false); }}><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={10_000} aria-label="Issue description" /><div><button type="submit">Save description</button><button type="button" onClick={() => { setBody(issue.body); setEditing(false); }}>Cancel</button></div></form> : issue.body ? <p>{issue.body}</p> : <p className="empty-description">No description was provided.</p>}</section>
    <section className="messages" aria-label="Issue conversation"><h2>Conversation</h2>{issue.messages.length ? issue.messages.map((message) => <article className="message" key={message.id}><div className="message-meta"><span className="avatar" aria-hidden="true">{message.author.slice(0, 1).toUpperCase()}</span><div><strong>{message.author}</strong><time dateTime={message.createdAt}>{date.format(new Date(message.createdAt))}</time></div></div><p>{message.body}</p></article>) : <div className="conversation-empty"><h2>No conversation yet</h2><p>Add the first message to share context or ask a question.</p></div>}</section>
    <div className="composer-area">{access !== 'editable' ? <AccessNotice access={access} readOnly={COMPOSER_READ_ONLY_CALLOUT} className="composer-access" onAction={openSettings} /> : !displayName.trim() ? <form className="name-prompt" onSubmit={saveDisplayName}><label htmlFor="composer-name">Before you post, tell everyone who you are</label><div><input id="composer-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /><button type="submit">Save name</button></div></form> : <form className="composer" onSubmit={comment}><div className="composer-heading"><label htmlFor="comment-body">Add a message</label><span>Posting as <strong>{displayName}</strong></span></div><textarea id="comment-body" name="body" maxLength={10_000} required /><div><span>Keep it useful and concise.</span><button type="submit">Post message</button></div></form>}</div>
  </article>;
}

function SettingsPanel({ displayName, setDisplayName, saveDisplayName, access, credentialInput, setCredentialInput, saveCredential, clearCredential, credentialText, trustAnchorText, copyKey, close }: { displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event: FormEvent<HTMLFormElement>) => void; access: BoardAccess; credentialInput: string; setCredentialInput: (value: string) => void; saveCredential: (event: FormEvent<HTMLFormElement>) => Promise<void>; clearCredential: () => void; credentialText: string | null; trustAnchorText: string | null; copyKey: (text: string | null, label: string) => Promise<void>; close: () => void }) {
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
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><h2 id="settings-title">Settings & access</h2><button ref={closeRef} className="dialog-close" onClick={close} aria-label="Close settings">×</button></header><div className="settings-content"><section><h3>Display name</h3><form className="stacked-form" onSubmit={saveDisplayName}><label htmlFor="settings-name">Display name</label><input id="settings-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><button type="submit" disabled={!displayName.trim()}>Save name</button></form></section><section><h3>Editing access</h3><p>{WRITE_ACCESS_SUMMARY}</p>{access === 'rejected' && <div className="access-state"><strong>{REJECTED_CREDENTIAL_COPY.title}</strong><p>{REJECTED_CREDENTIAL_COPY.body}</p></div>}{access === 'editable' ? <><div className="access-state">Editing is enabled</div><div className="technical-actions"><button onClick={() => void copyKey(credentialText, 'Board credential')}>Copy board credential</button><button onClick={() => void copyKey(trustAnchorText, 'Board trust anchor')}>Copy trust anchor</button><button className="danger" onClick={clearCredential}>Use read-only mode</button></div></> : <form className="stacked-form" onSubmit={saveCredential}><label htmlFor="credential">Board credential</label><textarea id="credential" placeholder="Paste the signed board credential JSON" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} required /><small>The credential comes from another browser, user, or agent that can edit the board.</small><button type="submit" disabled={!credentialInput.trim()}>Enable editing</button></form>}</section></div></section></div>;
}
