import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createBrowserBoardApi } from './api';
import { resourceState, type Board, type BoardIssue, type BoardResource } from './model';
import { formatUpdatedAt, groupResources, issueCounts, visibleIssues, type IssueFilter } from './ui-state';

const DISPLAY_NAME_KEY = 'antonina:display-name';
const REFRESH_INTERVAL = 30_000;
type View = 'issues' | 'resources';

export default function App() {
  const api = useMemo(() => createBrowserBoardApi(), []);
  const [board, setBoard] = useState<Board | null>();
  const [view, setView] = useState<View>('issues');
  const [selectedNumber, setSelectedNumber] = useState<number>();
  const [filter, setFilter] = useState<IssueFilter>('open');
  const [displayName, setDisplayName] = useState(() => window.localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
  const [hasWriteAccess, setHasWriteAccess] = useState(api.hasWriteAccess());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capabilityInput, setCapabilityInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const createInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try { setBoard(await api.loadBoard()); setHasWriteAccess(api.hasWriteAccess()); setError(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load Antonina'); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL); return () => window.clearInterval(timer); }, [refresh]);

  async function initializeBoard() {
    setInitializing(true); setError(undefined); setNotice(undefined);
    try {
      const result = await api.initializeBoard();
      setBoard(result.board);
      setHasWriteAccess(api.hasWriteAccess());
      setView('issues'); setSelectedNumber(undefined);
      setNotice(result.initializedElsewhere
        ? 'The board was initialized elsewhere. This browser remains read-only.'
        : 'Board initialized. This browser is now the first editor.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The board could not be initialized');
    } finally {
      setInitializing(false);
    }
  }

  const visible = board ? visibleIssues(board.issues, filter) : [];
  const counts = issueCounts(board?.issues ?? []);
  const selected = board?.issues.find((issue) => issue.number === selectedNumber);
  useEffect(() => { if (selected && !visible.some((issue) => issue.number === selected.number)) setSelectedNumber(undefined); }, [selected, visible]);

  async function run<T extends Board | BoardIssue | BoardResource | undefined>(action: () => Promise<T>, success: string): Promise<T | null> {
    setError(undefined); setNotice(undefined);
    try { const result = await action(); await refresh(); setNotice(success); return result; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be saved'); return null; }
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
  function saveCapability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); try { api.setCapability(capabilityInput); setHasWriteAccess(true); setCapabilityInput(''); setNotice('Write access saved in this browser'); void refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The capability could not be saved'); }
  }
  function clearCapability() { api.clearCapability(); setHasWriteAccess(false); setNotice('Write access cleared from this browser'); }
  async function copyCapability() { const capability = api.getCapability(); if (!capability) return; try { await navigator.clipboard.writeText(capability); setNotice('Write capability copied'); } catch { setError('The browser did not allow access to the clipboard'); } }
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  if (loading) return <main className="centered"><div><span className="loading-dot" /> Loading your shared board…</div></main>;
  if (error && board === undefined) return <main className="centered"><section className="load-error"><p className="eyebrow">Antonina</p><h1>The board could not be loaded</h1><p>{error}</p><button className="primary" onClick={() => void refresh()}>Try again</button></section></main>;

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => { setView('issues'); setSelectedNumber(undefined); }} aria-label="Back to all Antonina issues"><span className="brand-mark" aria-hidden="true">A</span><span><strong>Antonina</strong><small>Shared issue board</small></span></button>
      <nav className="main-nav" aria-label="Main navigation">{(['issues', 'resources'] as const).map((item) => <button key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => { setView(item); setSelectedNumber(undefined); }}>{item}</button>)}</nav>
      <div className="top-actions"><span className={`access-pill ${hasWriteAccess ? 'writable' : ''}`}><span aria-hidden="true" />{hasWriteAccess ? 'Can edit' : 'Read only'}</span><button className="quiet" onClick={() => void refresh()}>Refresh</button><button className="quiet" onClick={() => setSettingsOpen(true)}>Settings</button></div>
    </header>
    {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error">Dismiss</button></div>}
    {notice && <div className="notice success" role="status"><span>{notice}</span><button onClick={() => setNotice(undefined)} aria-label="Dismiss message">Dismiss</button></div>}
    {board === null ? <main className="workspace first-run-view">
      <aside className="issue-pane first-run-pane"><div className="pane-heading"><p className="eyebrow">Welcome to Antonina</p><h1>Issues</h1><p>Once the board is initialized, issues and their shared conversation will appear here.</p></div></aside>
      <section className="first-run-onboarding"><p className="eyebrow">First-run setup</p><h2>Initialize your shared board</h2><p>Clicking <strong>Initialize board</strong> makes this browser the first editor. Later, you can copy the editing key from Settings for another browser or agents.</p><button className="primary" onClick={() => void initializeBoard()} disabled={initializing}>{initializing ? 'Initializing board…' : 'Initialize board'}</button></section>
    </main> : <main className={`workspace ${view}-view ${selected ? 'has-selection' : ''}`}>
      <aside className="issue-pane" aria-label={view === 'issues' ? 'Shared issue list' : 'Registered resources'}>
        <div className="pane-heading"><div><p className="eyebrow">One board, everyone’s work</p><h1>{view === 'issues' ? 'Issues' : 'Resources'}</h1><p>{view === 'issues' ? 'Track what needs attention and discuss the details together.' : 'Registered paths are protected while at least one dependent Antonina issue remains open.'}</p></div></div>
        {view === 'issues' ? <>
          {hasWriteAccess ? <form className="create-form" onSubmit={createIssue}><label htmlFor="new-issue">Create an issue</label><input ref={createInputRef} id="new-issue" name="title" placeholder="What needs doing?" maxLength={200} required /><label htmlFor="new-issue-body">Description</label><textarea id="new-issue-body" name="body" placeholder="Describe the goal, context, or acceptance criteria…" maxLength={10_000} /><small>Use the description for task context; use the conversation for updates and questions.</small><button type="submit">Create issue</button></form>
            : <div className="access-callout"><div><strong>Read-only board</strong><p>You can read every issue and resource. Enable editing to make changes.</p></div><button onClick={() => setSettingsOpen(true)}>Enable editing</button></div>}
          <nav className="filters" aria-label="Filter issues">{(['open', 'closed', 'all'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'open' ? 'Open' : value === 'closed' ? 'Closed' : 'All'}<span>{counts[value]}</span></button>)}</nav>
          <div className="issue-list" aria-label="Issues">{visible.map((issue) => <button key={issue.number} className={`issue-row ${issue.number === selectedNumber ? 'selected' : ''}`} onClick={() => setSelectedNumber(issue.number)} aria-current={issue.number === selectedNumber ? 'true' : undefined}><span className="issue-summary"><span className="issue-line"><strong>#{issue.number}</strong><span className={`state-label ${issue.state}`}>{issue.state}</span><time dateTime={issue.updatedAt}>Updated {formatUpdatedAt(issue.updatedAt)}</time></span><span className="issue-title">{issue.title}</span><span className="issue-meta">{issue.messages.length} messages{issue.body ? ' · has description' : ''}</span></span><span className="row-arrow" aria-hidden="true">›</span></button>)}{!visible.length && <div className="empty-state"><h2>No {filter === 'all' ? '' : filter} issues</h2><p>{hasWriteAccess ? 'Create an issue to begin.' : 'Enable editing to create one.'}</p></div>}</div>
        </> : <ResourcesView board={board!} issues={board!.issues} hasWriteAccess={hasWriteAccess} onOpenIssue={openIssue} onAdd={(host, path, number) => run(() => api.addResourceDependency(host, path, number), 'Resource dependency added')} onRemove={(resource, number) => run(() => api.removeResourceDependency(resource.host, resource.path, number), resource.issueNumbers.length === 1 ? 'Dependency removed; resource unregistered' : 'Resource dependency removed')} onEnableEditing={() => setSettingsOpen(true)} />}
      </aside>
      {view === 'issues' ? selected ? <Thread issue={selected} hasWriteAccess={hasWriteAccess} displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} openSettings={() => setSettingsOpen(true)} comment={postComment} editBody={(body) => run(() => api.editIssueBody(selected.number, body), 'Description updated')} close={() => void run(() => api.close(selected.number), 'Issue closed')} reopen={() => void run(() => api.reopen(selected.number), 'Issue reopened')} back={() => setSelectedNumber(undefined)} />
        : <section className="thread welcome"><div className="welcome-mark" aria-hidden="true">A</div><p className="eyebrow">Shared issue board</p><h2>{board!.issues.length ? 'Choose an issue to join the conversation.' : 'Start a shared record of the work.'}</h2>{!board!.issues.length && <p>Create the first issue from the list, then add updates or ask questions in its conversation.</p>}</section> : null}
    </main>}
    {settingsOpen && <SettingsPanel displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} hasWriteAccess={hasWriteAccess} capabilityInput={capabilityInput} setCapabilityInput={setCapabilityInput} saveCapability={saveCapability} clearCapability={clearCapability} copyCapability={copyCapability} close={closeSettings} />}
  </div>;
}

function ResourcesView({ board, issues, hasWriteAccess, onOpenIssue, onAdd, onRemove, onEnableEditing }: { board: Board; issues: BoardIssue[]; hasWriteAccess: boolean; onOpenIssue: (number: number) => void; onAdd: (host: string, path: string, number: number) => Promise<unknown>; onRemove: (resource: BoardResource, number: number) => Promise<unknown>; onEnableEditing: () => void }) {
  const grouped = groupResources(board.resources);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await onAdd(String(data.get('host')), String(data.get('path')), Number(data.get('issue'))); if (result) form.reset(); }
  return <div className="resources-view">
    {hasWriteAccess && <form className="resource-form" onSubmit={add}><h2>Register a resource</h2><p>Add a host and path, protected by at least one open issue.</p><label htmlFor="resource-host">Lubko host</label><input id="resource-host" name="host" placeholder="lubko://server-name" required /><label htmlFor="resource-path">Absolute path</label><input id="resource-path" name="path" placeholder="/registered/path" required /><label htmlFor="resource-issue">Open issue</label><select id="resource-issue" name="issue" required><option value="">Choose an issue</option>{issues.filter((issue) => issue.state === 'open').map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add dependency</button></form>}
    {!hasWriteAccess && <div className="access-callout"><div><strong>Read-only board</strong><p>You can read every issue and resource. Enable editing to make changes.</p></div><button onClick={onEnableEditing}>Enable editing</button></div>}
    {grouped.map(([host, resources]) => <section className="resource-host" key={host}><h2>{host}</h2>{resources.map((resource) => <article className="resource-card" key={resource.path}><header><code>{resource.path}</code><span className={`resource-state ${resourceState(resource, issues)}`}>{resourceState(resource, issues)}</span></header><div className="dependency-chips">{resource.issueNumbers.map((number) => { const issue = issues.find((entry) => entry.number === number)!; return <span className="dependency-chip" key={number}><button onClick={() => onOpenIssue(number)}>#{number} {issue.title}</button><span className={`state-label ${issue.state}`}>{issue.state}</span>{hasWriteAccess && <button aria-label={`Remove issue ${number}`} onClick={() => void onRemove(resource, number)}>×</button>}</span>; })}</div>{hasWriteAccess && <AddDependency resource={resource} issues={issues} add={onAdd} />}</article>)}</section>)}
    {!board.resources.length && <div className="empty-state"><h2>No resources registered</h2><p>Registered paths appear here grouped by Lubko host.</p></div>}
  </div>;
}
function AddDependency({ resource, issues, add }: { resource: BoardResource; issues: BoardIssue[]; add: (host: string, path: string, number: number) => Promise<unknown> }) { const options = issues.filter((issue) => issue.state === 'open' && !resource.issueNumbers.includes(issue.number)); if (!options.length) return null; return <form className="dependency-add" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await add(resource.host, resource.path, Number(data.get('issue'))); if (result) form.reset(); }}><select name="issue" required defaultValue=""><option value="" disabled>Add open issue dependency…</option>{options.map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add</button></form>; }

function Thread({ issue, hasWriteAccess, displayName, setDisplayName, saveDisplayName, openSettings, comment, editBody, close, reopen, back }: { issue: BoardIssue; hasWriteAccess: boolean; displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event?: FormEvent<HTMLFormElement>) => void; openSettings: () => void; comment: (event: FormEvent<HTMLFormElement>) => Promise<void>; editBody: (body: string) => Promise<unknown>; close: () => void; reopen: () => void; back: () => void }) {
  const [editing, setEditing] = useState(false); const [body, setBody] = useState(issue.body);
  useEffect(() => { setBody(issue.body); setEditing(false); }, [issue.body, issue.number]);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return <article className="thread"><button className="back-button" onClick={back}><span aria-hidden="true">←</span> All issues</button><header className="thread-header"><div className="thread-title"><p className="eyebrow">Issue #{issue.number} <span className={`state-label ${issue.state}`}>{issue.state}</span></p><h1>{issue.title}</h1><p>Updated {formatUpdatedAt(issue.updatedAt)} · {issue.messages.length} messages</p></div>{hasWriteAccess ? <button className={`state-action ${issue.state}`} onClick={issue.state === 'open' ? close : reopen}>{issue.state === 'open' ? 'Close issue' : 'Reopen issue'}</button> : <span className="read-only-label">Read-only view</span>}</header>
    <section className="issue-description"><div className="description-heading"><h2>Description</h2>{hasWriteAccess && issue.state === 'open' && !editing && <button onClick={() => setEditing(true)}>Edit description</button>}</div><p className="section-guidance">Task context lives in the description; updates and questions live in the conversation.</p>{editing ? <form onSubmit={async (event) => { event.preventDefault(); const result = await editBody(body); if (result) setEditing(false); }}><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={10_000} aria-label="Issue description" /><div><button type="submit">Save description</button><button type="button" onClick={() => { setBody(issue.body); setEditing(false); }}>Cancel</button></div></form> : issue.body ? <p>{issue.body}</p> : <p className="empty-description">No description was provided.</p>}</section>
    <section className="messages" aria-label="Issue conversation"><h2>Conversation</h2>{issue.messages.length ? issue.messages.map((message) => <article className="message" key={message.id}><div className="message-meta"><span className="avatar" aria-hidden="true">{message.author.slice(0, 1).toUpperCase()}</span><div><strong>{message.author}</strong><time dateTime={message.createdAt}>{date.format(new Date(message.createdAt))}</time></div></div><p>{message.body}</p></article>) : <div className="conversation-empty"><h2>No conversation yet</h2><p>Add the first message to share context or ask a question.</p></div>}</section>
    <div className="composer-area">{!hasWriteAccess ? <div className="composer-access"><div><strong>Want to join the conversation?</strong><p>Enable editing in this browser to make changes.</p></div><button onClick={openSettings}>Enable editing</button></div> : !displayName.trim() ? <form className="name-prompt" onSubmit={saveDisplayName}><label htmlFor="composer-name">Before you post, tell everyone who you are</label><div><input id="composer-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /><button type="submit">Save name</button></div></form> : <form className="composer" onSubmit={comment}><div className="composer-heading"><label htmlFor="comment-body">Add a message</label><span>Posting as <strong>{displayName}</strong></span></div><textarea id="comment-body" name="body" maxLength={10_000} required /><div><span>Keep it useful and concise.</span><button type="submit">Post message</button></div></form>}</div>
  </article>;
}

function SettingsPanel({ displayName, setDisplayName, saveDisplayName, hasWriteAccess, capabilityInput, setCapabilityInput, saveCapability, clearCapability, copyCapability, close }: { displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event: FormEvent<HTMLFormElement>) => void; hasWriteAccess: boolean; capabilityInput: string; setCapabilityInput: (value: string) => void; saveCapability: (event: FormEvent<HTMLFormElement>) => void; clearCapability: () => void; copyCapability: () => Promise<void>; close: () => void }) {
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
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><h2 id="settings-title">Settings & access</h2><button ref={closeRef} className="dialog-close" onClick={close} aria-label="Close settings">×</button></header><div className="settings-content"><section><h3>Display name</h3><form className="stacked-form" onSubmit={saveDisplayName}><label htmlFor="settings-name">Display name</label><input id="settings-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><button type="submit" disabled={!displayName.trim()}>Save name</button></form></section><section><h3>Editing access</h3><p>Write access allows issue, description, dependency, and status changes.</p>{hasWriteAccess ? <><div className="access-state">Editing is enabled</div><div className="technical-actions"><button onClick={() => void copyCapability()}>Copy editing key</button><button className="danger" onClick={clearCapability}>Use read-only mode</button></div></> : <form className="stacked-form" onSubmit={saveCapability}><label htmlFor="capability">Editing key</label><input id="capability" type="password" placeholder="Paste the 64-character editing key" value={capabilityInput} onChange={(event) => setCapabilityInput(event.target.value)} /><small>The key comes from another browser or user with editing access.</small><button type="submit" disabled={!capabilityInput.trim()}>Enable editing</button></form>}</section></div></section></div>;
}
