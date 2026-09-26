import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  BOARD_CAPABILITIES,
  createBrowserBoardApi,
  type BoardCapability,
  type VerifiedAuthority,
} from './api';
import { resourceState, type Board, type BoardIssue, type BoardResource } from './model';
import {
  formatUpdatedAt,
  groupResources,
  issueCounts,
  submitCreateIssueShortcut,
  visibleIssues,
  type IssueFilter,
} from './ui-state';

const DISPLAY_NAME_KEY = 'antonina:display-name';
const REFRESH_INTERVAL = 30_000;
type View = 'issues' | 'resources';

export default function App() {
  const api = useMemo(() => createBrowserBoardApi(), []);
  const [board, setBoard] = useState<Board>();
  const [setup, setSetup] = useState<{ kind: 'missing'; legacyAvailable: boolean } | { kind: 'untrusted' }>();
  const [view, setView] = useState<View>('issues');
  const [selectedNumber, setSelectedNumber] = useState<number>();
  const [filter, setFilter] = useState<IssueFilter>('open');
  const [displayName, setDisplayName] = useState(() => window.localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
  const [hasWriteAccess, setHasWriteAccess] = useState(false);
  const [effectiveCapabilities, setEffectiveCapabilities] = useState<BoardCapability[]>([]);
  const [authorities, setAuthorities] = useState<VerifiedAuthority[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [credentialInput, setCredentialInput] = useState('');
  const [trustInput, setTrustInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const createInputRef = useRef<HTMLInputElement>(null);
  const readyRef = useRef(false);

  const syncAccess = useCallback(() => {
    setHasWriteAccess(api.hasWriteAccess());
    setEffectiveCapabilities(api.getEffectiveCapabilities());
  }, [api]);

  const acceptReadyBoard = useCallback((nextBoard: Board, warning?: string) => {
    setBoard(nextBoard);
    setSetup(undefined);
    readyRef.current = true;
    syncAccess();
    if (warning) setNotice(warning);
  }, [syncAccess]);

  const refresh = useCallback(async () => {
    try {
      setError(undefined);
      if (!readyRef.current) {
        const bootstrapped = await api.bootstrap();
        if (bootstrapped.kind === 'ready') {
          acceptReadyBoard(bootstrapped.board, bootstrapped.credentialWarning);
        } else {
          readyRef.current = false;
          setBoard(undefined);
          setHasWriteAccess(false);
          setEffectiveCapabilities([]);
          setSetup(
            bootstrapped.kind === 'missing'
              ? { kind: 'missing', legacyAvailable: bootstrapped.legacyAvailable }
              : { kind: 'untrusted' },
          );
          if (bootstrapped.credentialWarning) setNotice(bootstrapped.credentialWarning);
        }
      } else {
        setBoard(await api.loadBoard());
        syncAccess();
      }
    } catch (cause) {
      setHasWriteAccess(false);
      setEffectiveCapabilities([]);
      setError(cause instanceof Error ? cause.message : 'Could not load Antonina');
    } finally {
      setLoading(false);
    }
  }, [acceptReadyBoard, api, syncAccess]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const visible = board ? visibleIssues(board.issues, filter) : [];
  const counts = issueCounts(board?.issues ?? []);
  const selected = board?.issues.find((issue) => issue.number === selectedNumber);
  const can = useCallback(
    (capability: BoardCapability) => hasWriteAccess && effectiveCapabilities.includes(capability),
    [effectiveCapabilities, hasWriteAccess],
  );
  useEffect(() => {
    if (selected && !visible.some((issue) => issue.number === selected.number)) setSelectedNumber(undefined);
  }, [selected, visible]);

  const refreshAuthorities = useCallback(async () => {
    if (api.getTrustAnchor() === null) {
      setAuthorities([]);
      return;
    }
    try {
      setAuthorities(await api.listAuthorities());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load credential lineage');
    }
  }, [api]);
  useEffect(() => {
    if (settingsOpen) void refreshAuthorities();
  }, [refreshAuthorities, settingsOpen]);

  async function run<T>(action: () => Promise<T>, success: string): Promise<T | null> {
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await action();
      await refresh();
      setNotice(success);
      return result;
    } catch (cause) {
      setHasWriteAccess(false);
      setError(cause instanceof Error ? cause.message : 'The change could not be saved');
      return null;
    }
  }

  async function createIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = (form.elements.namedItem('title') as HTMLInputElement).value;
    const body = (form.elements.namedItem('body') as HTMLTextAreaElement).value;
    const created = await run(() => api.createIssue(title, body), 'Issue created');
    if (created && 'number' in created) {
      setView('issues');
      setSelectedNumber(created.number);
      setFilter('open');
      form.reset();
    }
  }

  async function postComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !displayName.trim()) return;
    const form = event.currentTarget;
    const body = (form.elements.namedItem('body') as HTMLTextAreaElement).value;
    const result = await run(
      () => api.comment(selected.number, displayName, body),
      'Message posted',
    );
    if (result) form.reset();
  }

  function openIssue(number: number) {
    setView('issues');
    setFilter('all');
    setSelectedNumber(number);
  }

  function saveDisplayName(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const clean = displayName.trim();
    if (!clean) return;
    window.localStorage.setItem(DISPLAY_NAME_KEY, clean);
    setDisplayName(clean);
    setNotice('Display name saved in this browser');
  }

  async function initializeBoard(migrate: boolean) {
    setLoading(true);
    setError(undefined);
    try {
      const initialized = migrate ? await api.migrateLegacy() : await api.initialize();
      acceptReadyBoard(initialized.board);
      setNotice(
        migrate
          ? 'Legacy board migrated. This browser now holds the root credential; copy it from Settings and store it securely.'
          : 'Board initialized. This browser now holds the root credential; copy it from Settings and store it securely.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not initialize Antonina');
    } finally {
      setLoading(false);
    }
  }

  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      await api.importCredentialText(credentialInput);
      const nextBoard = await api.loadBoard();
      acceptReadyBoard(nextBoard);
      setCredentialInput('');
      setNotice('Credential verified against the current signed board');
      await refreshAuthorities();
    } catch (cause) {
      setHasWriteAccess(false);
      setEffectiveCapabilities([]);
      setError(cause instanceof Error ? cause.message : 'The credential could not be verified');
    }
  }

  async function saveTrust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      const nextBoard = await api.importTrustText(trustInput);
      acceptReadyBoard(nextBoard);
      setTrustInput('');
      setNotice('Public board trust anchor saved in this browser');
      await refreshAuthorities();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The trust anchor could not be verified');
    }
  }

  function clearCredential() {
    api.clearCredential();
    syncAccess();
    setNotice('Secret credential cleared; the public trust anchor remains for read-only verification');
  }

  async function copyText(text: string | null, success: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(success);
    } catch {
      setError('The browser did not allow access to the clipboard');
    }
  }

  async function delegateCredential(capabilities: BoardCapability[]): Promise<string | null> {
    setError(undefined);
    try {
      const credential = await api.delegateCredential(capabilities);
      await refresh();
      await refreshAuthorities();
      setNotice('Delegated credential created. Copy it now and deliver it securely.');
      return JSON.stringify(credential);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create delegated credential');
      return null;
    }
  }

  async function revokeCredential(keyId: string): Promise<boolean> {
    setError(undefined);
    try {
      await api.revokeCredential(keyId);
      await refresh();
      await refreshAuthorities();
      setNotice('Credential branch revoked');
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke credential');
      return false;
    }
  }

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  if (loading) return <main className="centered"><div><span className="loading-dot" /> Loading your shared board…</div></main>;
  if (setup?.kind === 'missing') return <main className="centered"><section className="load-error setup-card"><p className="eyebrow">Antonina</p><h1>No signed board has been initialized</h1><p>Ordinary page loads are read-only and never claim the board. Initialize deliberately to make this browser the root editor, then copy the root credential from Settings and store it securely.</p>{error && <p className="setup-error" role="alert">{error}</p>}<div className="setup-actions"><button className="primary" onClick={() => void initializeBoard(false)}>Initialize board</button>{setup.legacyAvailable && <button className="secondary" onClick={() => void initializeBoard(true)}>Migrate legacy board-v1</button>}<button className="secondary" onClick={() => void refresh()}>Check again</button></div></section></main>;
  if (setup?.kind === 'untrusted') return <main className="centered"><section className="load-error setup-card"><p className="eyebrow">Antonina</p><h1>This signed board needs a trust anchor</h1><p>Paste a verified credential to edit, or paste the public trust anchor for read-only access. Board state is not accepted before its root is trusted.</p>{error && <p className="setup-error" role="alert">{error}</p>}<form className="stacked-form setup-form" onSubmit={saveCredential}><label htmlFor="setup-credential">Credential JSON</label><textarea id="setup-credential" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} placeholder="Paste a signed-board credential" required /><button type="submit">Verify credential</button></form><form className="stacked-form setup-form" onSubmit={saveTrust}><label htmlFor="setup-trust">Public trust anchor JSON</label><textarea id="setup-trust" value={trustInput} onChange={(event) => setTrustInput(event.target.value)} placeholder="Paste the public trust anchor" required /><button type="submit">Trust read-only board</button></form></section></main>;
  if (error && !board) return <main className="centered"><section className="load-error"><p className="eyebrow">Antonina</p><h1>The board could not be loaded</h1><p>{error}</p><button className="primary" onClick={() => void refresh()}>Try again</button></section></main>;

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
        <div className="pane-heading"><div><p className="eyebrow">One board, everyone’s work</p><h1>{view === 'issues' ? 'Issues' : 'Resources'}</h1><p>{view === 'issues' ? 'Track what needs attention and discuss the details together.' : 'Registered paths are protected while at least one dependent Antonina issue remains open.'}</p></div></div>
        {view === 'issues' ? <>
          {can('issue.create') ? <form className="create-form" onSubmit={createIssue}><label htmlFor="new-issue">Create an issue</label><input ref={createInputRef} id="new-issue" name="title" placeholder="What needs doing?" maxLength={200} required /><label htmlFor="new-issue-body">Description</label><textarea id="new-issue-body" name="body" placeholder="Describe the goal, context, or acceptance criteria…" maxLength={10_000} onKeyDown={submitCreateIssueShortcut} /><small>Description is task context; use the conversation for updates and questions. Ctrl+Enter creates the issue.</small><button type="submit">Create issue</button></form>
            : <div className="access-callout"><div><strong>Read-only issue creation</strong><p>The board remains visible, but the verified credential does not grant issue creation.</p></div><button onClick={() => setSettingsOpen(true)}>Access settings</button></div>}
          <nav className="filters" aria-label="Filter issues">{(['open', 'closed', 'all'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'open' ? 'Open' : value === 'closed' ? 'Closed' : 'All'}<span>{counts[value]}</span></button>)}</nav>
          <div className="issue-list" aria-label="Issues">{visible.map((issue) => <button key={issue.number} className={`issue-row ${issue.number === selectedNumber ? 'selected' : ''}`} onClick={() => setSelectedNumber(issue.number)} aria-current={issue.number === selectedNumber ? 'true' : undefined}><span className="issue-summary"><span className="issue-line"><strong>#{issue.number}</strong><span className={`state-label ${issue.state}`}>{issue.state}</span><time dateTime={issue.updatedAt}>Updated {formatUpdatedAt(issue.updatedAt)}</time></span><span className="issue-title">{issue.title}</span><span className="issue-meta">{issue.messages.length} messages{issue.body ? ' · has description' : ''}</span></span><span className="row-arrow" aria-hidden="true">›</span></button>)}{!visible.length && <div className="empty-state"><h2>No {filter === 'all' ? '' : filter} issues</h2><p>{can('issue.create') ? 'Create an issue above to begin.' : 'No matching issues are currently visible.'}</p></div>}</div>
        </> : <ResourcesView board={board!} issues={board!.issues} canModify={can('resource.modify')} onOpenIssue={openIssue} onAdd={(host, path, number) => run(() => api.addResourceDependency(host, path, number), 'Resource dependency added')} onRemove={(resource, number) => run(() => api.removeResourceDependency(resource.host, resource.path, number), resource.issueNumbers.length === 1 ? 'Dependency removed; resource unregistered' : 'Resource dependency removed')} onEnableEditing={() => setSettingsOpen(true)} />}
      </aside>
      {view === 'issues' ? selected ? <Thread issue={selected} canComment={can('issue.comment')} canEditBody={can('issue.edit')} canChangeState={can('issue.state')} displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} openSettings={() => setSettingsOpen(true)} comment={postComment} editBody={(body) => run(() => api.editIssueBody(selected.number, body), 'Description updated')} close={() => void run(() => api.close(selected.number), 'Issue closed')} reopen={() => void run(() => api.reopen(selected.number), 'Issue reopened')} back={() => setSelectedNumber(undefined)} />
        : <section className="thread welcome"><div className="welcome-mark" aria-hidden="true">A</div><p className="eyebrow">Shared issue board</p><h2>{board!.issues.length ? 'Choose an issue to join the conversation.' : 'No issues yet.'}</h2><p>{board!.issues.length ? 'Open an issue to see its task context and conversation.' : can('issue.create') ? 'Create the first issue from the form on the left.' : 'The verified credential does not grant issue creation.'}</p></section> : null}
    </main>
    {settingsOpen && <SettingsPanel displayName={displayName} setDisplayName={setDisplayName} saveDisplayName={saveDisplayName} hasWriteAccess={hasWriteAccess} capabilities={effectiveCapabilities} currentKeyId={api.getCredential()?.keyId ?? null} rootKeyId={api.getTrustAnchor()?.rootKeyId ?? null} authorities={authorities} credentialInput={credentialInput} setCredentialInput={setCredentialInput} trustInput={trustInput} setTrustInput={setTrustInput} saveCredential={saveCredential} saveTrust={saveTrust} clearCredential={clearCredential} copyCredential={() => copyText(api.exportCredentialText(), 'Credential copied')} copyTrust={() => copyText(api.exportTrustText(), 'Public trust anchor copied')} delegateCredential={delegateCredential} revokeCredential={revokeCredential} close={closeSettings} />}
  </div>;
}

function ResourcesView({ board, issues, canModify, onOpenIssue, onAdd, onRemove, onEnableEditing }: { board: Board; issues: BoardIssue[]; canModify: boolean; onOpenIssue: (number: number) => void; onAdd: (host: string, path: string, number: number) => Promise<unknown>; onRemove: (resource: BoardResource, number: number) => Promise<unknown>; onEnableEditing: () => void }) {
  const grouped = groupResources(board.resources);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await onAdd(String(data.get('host')), String(data.get('path')), Number(data.get('issue'))); if (result) form.reset(); }
  return <div className="resources-view">
    {canModify && <form className="resource-form" onSubmit={add}><h2>Register a resource</h2><p>Add a host and path, protected by at least one open issue.</p><label htmlFor="resource-host">Lubko host</label><input id="resource-host" name="host" placeholder="lubko://server-name" required /><label htmlFor="resource-path">Absolute path</label><input id="resource-path" name="path" placeholder="/registered/path" required /><label htmlFor="resource-issue">Open issue</label><select id="resource-issue" name="issue" required><option value="">Choose an issue</option>{issues.filter((issue) => issue.state === 'open').map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add dependency</button></form>}
    {!canModify && <div className="access-callout"><div><strong>Read-only resources</strong><p>All dependencies and protection states remain visible, but the verified credential does not grant resource modification.</p></div><button onClick={onEnableEditing}>Access settings</button></div>}
    {grouped.map(([host, resources]) => <section className="resource-host" key={host}><h2>{host}</h2>{resources.map((resource) => <article className="resource-card" key={resource.path}><header><code>{resource.path}</code><span className={`resource-state ${resourceState(resource, issues)}`}>{resourceState(resource, issues)}</span></header><div className="dependency-chips">{resource.issueNumbers.map((number) => { const issue = issues.find((entry) => entry.number === number)!; return <span className="dependency-chip" key={number}><button onClick={() => onOpenIssue(number)}>#{number} {issue.title}</button><span className={`state-label ${issue.state}`}>{issue.state}</span>{canModify && <button aria-label={`Remove issue ${number}`} onClick={() => void onRemove(resource, number)}>×</button>}</span>; })}</div>{canModify && <AddDependency resource={resource} issues={issues} add={onAdd} />}</article>)}</section>)}
    {!board.resources.length && <div className="empty-state"><h2>No resources registered</h2><p>Registered paths appear here grouped by Lubko host.</p></div>}
  </div>;
}
function AddDependency({ resource, issues, add }: { resource: BoardResource; issues: BoardIssue[]; add: (host: string, path: string, number: number) => Promise<unknown> }) { const options = issues.filter((issue) => issue.state === 'open' && !resource.issueNumbers.includes(issue.number)); if (!options.length) return null; return <form className="dependency-add" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const result = await add(resource.host, resource.path, Number(data.get('issue'))); if (result) form.reset(); }}><select name="issue" required defaultValue=""><option value="" disabled>Add open issue dependency…</option>{options.map((issue) => <option key={issue.number} value={issue.number}>#{issue.number} {issue.title}</option>)}</select><button type="submit">Add</button></form>; }

function Thread({ issue, canComment, canEditBody, canChangeState, displayName, setDisplayName, saveDisplayName, openSettings, comment, editBody, close, reopen, back }: { issue: BoardIssue; canComment: boolean; canEditBody: boolean; canChangeState: boolean; displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event?: FormEvent<HTMLFormElement>) => void; openSettings: () => void; comment: (event: FormEvent<HTMLFormElement>) => Promise<void>; editBody: (body: string) => Promise<unknown>; close: () => void; reopen: () => void; back: () => void }) {
  const [editing, setEditing] = useState(false); const [body, setBody] = useState(issue.body);
  useEffect(() => { setBody(issue.body); setEditing(false); }, [issue.body, issue.number]);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return <article className="thread"><button className="back-button" onClick={back}><span aria-hidden="true">←</span> All issues</button><header className="thread-header"><div className="thread-title"><p className="eyebrow">Issue #{issue.number} <span className={`state-label ${issue.state}`}>{issue.state}</span></p><h1>{issue.title}</h1><p>Updated {formatUpdatedAt(issue.updatedAt)} · {issue.messages.length} messages</p></div>{canChangeState ? <button className={`state-action ${issue.state}`} onClick={issue.state === 'open' ? close : reopen}>{issue.state === 'open' ? 'Close issue' : 'Reopen issue'}</button> : <span className="read-only-label">No status-change access</span>}</header>
    <section className="issue-description"><div className="description-heading"><h2>Description</h2>{canEditBody && issue.state === 'open' && !editing && <button onClick={() => setEditing(true)}>Edit description</button>}</div>{editing ? <form onSubmit={async (event) => { event.preventDefault(); const result = await editBody(body); if (result) setEditing(false); }}><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={10_000} aria-label="Issue description" /><div><button type="submit">Save description</button><button type="button" onClick={() => { setBody(issue.body); setEditing(false); }}>Cancel</button></div></form> : issue.body ? <p>{issue.body}</p> : <p className="empty-description">No description was provided.</p>}</section>
    <section className="messages" aria-label="Issue conversation"><h2>Conversation</h2>{issue.messages.length ? issue.messages.map((message) => <article className="message" key={message.id}><div className="message-meta"><span className="avatar" aria-hidden="true">{message.author.slice(0, 1).toUpperCase()}</span><div><strong>{message.author}</strong><time dateTime={message.createdAt}>{date.format(new Date(message.createdAt))}</time></div></div><p>{message.body}</p></article>) : <div className="conversation-empty"><h2>No conversation yet</h2><p>Add the first message to share context or ask a question.</p></div>}</section>
    <div className="composer-area">{!canComment ? <div className="composer-access"><div><strong>Read-only conversation</strong><p>The verified credential does not grant comment access.</p></div><button onClick={openSettings}>Access settings</button></div> : !displayName.trim() ? <form className="name-prompt" onSubmit={saveDisplayName}><label htmlFor="composer-name">Before you post, tell everyone who you are</label><div><input id="composer-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /><button type="submit">Save name</button></div></form> : <form className="composer" onSubmit={comment}><div className="composer-heading"><label htmlFor="comment-body">Add a message</label><span>Posting as <strong>{displayName}</strong></span></div><textarea id="comment-body" name="body" maxLength={10_000} required /><div><span>Keep it useful and concise.</span><button type="submit">Post message</button></div></form>}</div>
  </article>;
}

function SettingsPanel({ displayName, setDisplayName, saveDisplayName, hasWriteAccess, capabilities, currentKeyId, rootKeyId, authorities, credentialInput, setCredentialInput, trustInput, setTrustInput, saveCredential, saveTrust, clearCredential, copyCredential, copyTrust, delegateCredential, revokeCredential, close }: { displayName: string; setDisplayName: (value: string) => void; saveDisplayName: (event: FormEvent<HTMLFormElement>) => void; hasWriteAccess: boolean; capabilities: BoardCapability[]; currentKeyId: string | null; rootKeyId: string | null; authorities: VerifiedAuthority[]; credentialInput: string; setCredentialInput: (value: string) => void; trustInput: string; setTrustInput: (value: string) => void; saveCredential: (event: FormEvent<HTMLFormElement>) => Promise<void>; saveTrust: (event: FormEvent<HTMLFormElement>) => Promise<void>; clearCredential: () => void; copyCredential: () => Promise<void>; copyTrust: () => Promise<void>; delegateCredential: (capabilities: BoardCapability[]) => Promise<string | null>; revokeCredential: (keyId: string) => Promise<boolean>; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [selectedCapabilities, setSelectedCapabilities] = useState<BoardCapability[]>(capabilities);
  const [delegatedCredential, setDelegatedCredential] = useState('');
  useEffect(() => { setSelectedCapabilities(capabilities); }, [capabilities]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'Tab') return;
      const dialog = closeRef.current?.closest<HTMLElement>('[role="dialog"]');
      const controls = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')) : [];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = overflow; previous?.focus(); };
  }, [close]);

  const canDelegate = capabilities.includes('authority.delegate');
  const canRevoke = capabilities.includes('authority.revoke');
  function toggleCapability(capability: BoardCapability) {
    setSelectedCapabilities((current) => current.includes(capability)
      ? current.filter((entry) => entry !== capability)
      : [...current, capability].sort());
  }
  async function createDelegation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await delegateCredential(selectedCapabilities);
    if (created) setDelegatedCredential(created);
  }
  async function copyDelegated() {
    if (!delegatedCredential) return;
    await navigator.clipboard.writeText(delegatedCredential);
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><h2 id="settings-title">Settings & access</h2><button ref={closeRef} className="dialog-close" onClick={close} aria-label="Close settings">×</button></header><div className="settings-content">
    <section><h3>Display name</h3><form className="stacked-form" onSubmit={saveDisplayName}><label htmlFor="settings-name">Display name</label><input id="settings-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><button type="submit" disabled={!displayName.trim()}>Save name</button></form></section>
    <section><h3>Board trust</h3><p>The public trust anchor pins the board root. It can be shared without exposing editing secrets.</p><div className="technical-actions"><button onClick={() => void copyTrust()} disabled={!rootKeyId}>Copy public trust anchor</button></div></section>
    <section><h3>Credential</h3><p>Editing is enabled only after the credential’s signing key, delegation chain, current revocation state, and Skrynia storage capability have all been verified.</p>
      {currentKeyId ? <><div className={`access-state ${hasWriteAccess ? '' : 'readonly'}`}><div><strong>{hasWriteAccess ? 'Credential verified' : 'Credential verified with no mutating capability'}</strong><p><code>{currentKeyId}</code></p></div></div><div className="capability-list">{capabilities.map((capability) => <code key={capability}>{capability}</code>)}</div><div className="technical-actions"><button onClick={() => void copyCredential()}>Copy secret credential</button><button className="danger" onClick={clearCredential}>Use read-only mode</button></div></>
      : <><form className="stacked-form" onSubmit={saveCredential}><label htmlFor="credential">Credential JSON</label><textarea id="credential" placeholder="Paste a signed-board credential" value={credentialInput} onChange={(event) => setCredentialInput(event.target.value)} required /><small>The secret credential includes a private signing key. It is not trusted until verified against the current board.</small><button type="submit">Verify credential</button></form><form className="stacked-form secondary-access-form" onSubmit={saveTrust}><label htmlFor="trust-anchor">Public trust anchor JSON</label><textarea id="trust-anchor" placeholder="Paste the public trust anchor" value={trustInput} onChange={(event) => setTrustInput(event.target.value)} required /><button type="submit">Use read-only trust</button></form></>}
    </section>
    {currentKeyId && canDelegate && <section><h3>Create delegated credential</h3><p>Select an equal or smaller subset of your current capabilities. The new credential cannot exceed this credential’s authority.</p><form className="delegation-form" onSubmit={createDelegation}><div className="capability-picker">{BOARD_CAPABILITIES.filter((capability) => capabilities.includes(capability)).map((capability) => <label key={capability}><input type="checkbox" checked={selectedCapabilities.includes(capability)} onChange={() => toggleCapability(capability)} /> <code>{capability}</code></label>)}</div><button type="submit">Create child credential</button></form>{delegatedCredential && <div className="delegated-secret"><label htmlFor="delegated-credential">New secret credential</label><textarea id="delegated-credential" readOnly value={delegatedCredential} /><p>Copy this credential now and deliver it securely. Creating it does not switch this browser to the child key.</p><button onClick={() => void copyDelegated()}>Copy child credential</button></div>}</section>}
    {rootKeyId && <section><h3>Delegation lineage</h3><p>Revoking a key invalidates that key and every descendant derived through it.</p><div className="authority-list">{authorities.map((authority) => <article key={authority.keyId}><div><code>{authority.keyId}</code><small>{authority.parentKeyId === null ? 'Root authority' : 'Parent ' + authority.parentKeyId}</small><span>{authority.revoked ? 'Revoked' : 'Active'}</span></div><div className="capability-list">{authority.capabilities.map((capability) => <code key={capability}>{capability}</code>)}</div>{canRevoke && !authority.revoked && authority.keyId !== rootKeyId && authority.keyId !== currentKeyId && <button className="danger" onClick={() => void revokeCredential(authority.keyId)}>Revoke branch</button>}</article>)}</div></section>}
  </div></section></div>;
}

