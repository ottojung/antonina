import {
  BoardIncompatibilityError,
  corruptDefect,
  describeArray,
  fieldDefect,
  firstDefect,
  keySetDefect,
  notARecordDefect,
  readKeyName,
  unclassifiedElementDefect,
  versionDefect,
  type BoardDefect,
} from './board-diagnostics.js';

export {
  BoardIncompatibilityError,
  isBoardIncompatibilityError,
  type BoardDefect,
  type BoardDefectKind,
} from './board-diagnostics.js';

export const BOARD_SCHEMA_VERSION = 3 as const;
export const LEGACY_BOARD_SCHEMA_VERSION = 2 as const;
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type IssueState = 'open' | 'closed';
export type ResourceState = 'protected' | 'collectible';

/**
 * The execution backends an execution target can name. A backend is what
 * actually runs the work, not a description of it: `lubko` transport to a
 * Lubko host, `github-actions` a workflow run. Antonina orchestrates the
 * choice and never reimplements the transport behind one of these.
 */
export const EXECUTION_TARGET_BACKENDS = ['lubko', 'github-actions'] as const;
export type ExecutionTargetBackend = (typeof EXECUTION_TARGET_BACKENDS)[number];

/**
 * What kind of environment a target is, independently of which backend runs
 * it. A persistent host keeps a filesystem between jobs; an ephemeral
 * environment exists for one job and is gone afterwards, so it is not
 * describable by a `lubko://` address at all.
 */
export const EXECUTION_TARGET_KINDS = ['persistent-host', 'ephemeral-environment'] as const;
export type ExecutionTargetKind = (typeof EXECUTION_TARGET_KINDS)[number];

export const EXECUTION_TARGET_STATUSES = ['available', 'unavailable'] as const;
export type ExecutionTargetStatus = (typeof EXECUTION_TARGET_STATUSES)[number];

/**
 * How a job is actually handed to the environment behind a target.
 *
 * The backend names who does the running; the access method names the mechanism
 * by which work reaches it. They are related but not the same question: the
 * backend is what Antonina selects against, and the access method is what an
 * orchestrator has to arrange before it can submit anything. It is a closed
 * vocabulary for the same reason capabilities are — "how do I reach this" is a
 * question about typed membership, not about reading prose.
 */
export const EXECUTION_TARGET_ACCESS_METHODS = ['lubko-transport', 'github-workflow-dispatch'] as const;
export type ExecutionTargetAccessMethod = (typeof EXECUTION_TARGET_ACCESS_METHODS)[number];

/**
 * What survives between two jobs on the same target.
 *
 * `durable-host-filesystem` is a real filesystem a later job can find the
 * earlier one's work in; `per-job-workspace` is a workspace the provider builds
 * for one job and destroys afterwards. The second is the only honest answer for
 * an ephemeral environment, and stating it is what stops an orchestrator from
 * planning a two-step job that assumes a directory the provider already deleted.
 */
export const EXECUTION_TARGET_PERSISTENCE = ['durable-host-filesystem', 'per-job-workspace'] as const;
export type ExecutionTargetPersistence = (typeof EXECUTION_TARGET_PERSISTENCE)[number];

/**
 * Who removes what a job left behind.
 *
 * `host-local-collector-available` is the Antonina collector, which can only be
 * pointed at a path a human registered and which no open issue depends on. The
 * name states what the host offers and not what any job will cause to happen:
 * a collector with no configured managed roots is refused by name and never
 * proceeds, and the board cannot see a host's managed-roots configuration from
 * here, so a registration that says the collector is available is not promising
 * that anything will be collected.
 * `provider-managed` means the external service expires the environment on its
 * own schedule and Antonina has no part in it. `none` means nothing removes it,
 * which is a real and common state for a host with no configured managed roots.
 *
 * A target may narrow this and never widen it, so the vocabulary is what it is
 * and the default is the widest answer the target's kind can honestly give.
 */
export const EXECUTION_TARGET_GARBAGE_COLLECTION = [
  'host-local-collector-available', 'provider-managed', 'none',
] as const;
export type ExecutionTargetGarbageCollection = (typeof EXECUTION_TARGET_GARBAGE_COLLECTION)[number];

/**
 * The released spelling of the collector value, kept so a board signed before the
 * rename keeps verifying and keeps reading. It is the same claim under the older
 * name, not a narrower or a wider one, and it is read as the current value by
 * every reader rather than being carried through as a second meaning: a record
 * that says `host-local-collector` is a record whose collector was available.
 *
 * It stays readable rather than being refused because a signed log is immutable,
 * so refusing it would make a board written by a released Antonina unreadable
 * and offer the operator nothing to do about it.
 */
export const LEGACY_EXECUTION_TARGET_GARBAGE_COLLECTION = ['host-local-collector'] as const;
export type LegacyExecutionTargetGarbageCollection =
  (typeof LEGACY_EXECUTION_TARGET_GARBAGE_COLLECTION)[number];

/**
 * What a record may carry, as opposed to what the vocabulary holds. This is the
 * type on the record and on nothing an operator can write: a caller names a
 * current value, and only a record read back from a board can hold the released
 * spelling.
 */
export type RecordedExecutionTargetGarbageCollection =
  | ExecutionTargetGarbageCollection
  | LegacyExecutionTargetGarbageCollection;

/** The one spelling a reader reports, whichever of the two a record carries. */
export function canonicalGarbageCollection(
  value: RecordedExecutionTargetGarbageCollection,
): ExecutionTargetGarbageCollection {
  return value === 'host-local-collector' ? 'host-local-collector-available' : value;
}

/** Whether a stored value is one this release reads, the current name or the released one. */
function isRecordedGarbageCollection(value: string): value is RecordedExecutionTargetGarbageCollection {
  return (EXECUTION_TARGET_GARBAGE_COLLECTION as readonly string[]).includes(value)
    || (LEGACY_EXECUTION_TARGET_GARBAGE_COLLECTION as readonly string[]).includes(value);
}

/**
 * The guidance document each backend points at when a target names none of its
 * own. A target carries a reference, never the procedure: the procedure is a
 * document that changes when the backend changes, and copying it into board
 * state would give the board a second spelling to keep current.
 */
export const EXECUTION_TARGET_GUIDANCE: { readonly [B in ExecutionTargetBackend]: string } = {
  lubko: 'docs/skills/target-lubko-persistent-host.md',
  'github-actions': 'docs/skills/target-github-actions-ephemeral.md',
};

/** The access method a backend provides, which is the only one it may declare. */
export function defaultExecutionTargetAccessMethod(backend: ExecutionTargetBackend): ExecutionTargetAccessMethod {
  return backend === 'lubko' ? 'lubko-transport' : 'github-workflow-dispatch';
}

/** The persistence a kind of environment has, which is the only one it may declare. */
export function defaultExecutionTargetPersistence(kind: ExecutionTargetKind): ExecutionTargetPersistence {
  return kind === 'persistent-host' ? 'durable-host-filesystem' : 'per-job-workspace';
}

/**
 * The closed vocabulary of what a target can do. Requirements are matched
 * against these names only, so "can it run a GPU job" is a question about
 * typed membership rather than a substring search over free-form metadata.
 */
export const EXECUTION_TARGET_CAPABILITIES = [
  'persistent-filesystem',
  'ephemeral-lifetime',
  'network-egress',
  'container-isolation',
  'accelerated-compute',
] as const;
export type ExecutionTargetCapability = (typeof EXECUTION_TARGET_CAPABILITIES)[number];

export interface BoardMessage {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface BoardIssue {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  createdAt: string;
  updatedAt: string;
  messages: BoardMessage[];
}

export interface BoardResource {
  host: string;
  path: string;
  issueNumbers: number[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One entry of the canonical catalog of places a job may run.
 *
 * A target is not a resource. A resource is a durable filesystem path an open
 * issue depends on; a target is an execution environment that can be selected
 * for a job. A target of kind `ephemeral-environment` has no durable filesystem
 * at all, and therefore no resource anywhere in the board.
 */
export interface BoardExecutionTarget {
  /** The stable identity a job names to request this target. */
  id: string;
  backend: ExecutionTargetBackend;
  kind: ExecutionTargetKind;
  status: ExecutionTargetStatus;
  /** Sorted, duplicate-free, from `EXECUTION_TARGET_CAPABILITIES`. */
  capabilities: ExecutionTargetCapability[];
  /**
   * The canonical `lubko://` address of a persistent Lubko host, and `null` for
   * a target that has no such address. This is the one value that relates a
   * target to the resources registered against that host, so it is derived
   * from the target record rather than spelled independently beside it.
   */
  address: string | null;
  description: string;
  /**
   * The human name a catalog and a board view print, or absent to print the id.
   * It is display metadata and is never an identity: nothing matches on it.
   */
  displayName?: string;
  /**
   * How work is handed to this target. Absent means the backend's own method,
   * which {@link defaultExecutionTargetAccessMethod} names; a record that
   * declares a different one is refused, because a Lubko target cannot be
   * reached by a workflow dispatch and claiming so would be a lie an
   * orchestrator could act on.
   */
  accessMethod?: ExecutionTargetAccessMethod;
  /**
   * What survives between two jobs here. Absent means the kind's own answer,
   * which is the only one that kind can have.
   */
  persistence?: ExecutionTargetPersistence;
  /**
   * Who removes what a job left behind. Absent means the widest honest answer
   * for the backend; a persistent host may narrow this to `none`, and an
   * ephemeral environment may narrow it to `none` when the provider is not the
   * one expiring it. It may never widen: no target can claim a host-local
   * collector when it has no host, or provider management when it is a host.
   * The released spelling of the collector value also reads here, because a
   * board signed before the rename is a record the board still has to hold.
   */
  garbageCollection?: RecordedExecutionTargetGarbageCollection;
  /** Sorted, duplicate-free operational caveats stated about this target. */
  limitations?: string[];
  /**
   * Sorted, duplicate-free repository-relative paths of the guidance documents
   * that say how to reach and use this target. Absent means the backend's own
   * document, named by {@link EXECUTION_TARGET_GUIDANCE}.
   */
  guidance?: string[];
  createdAt: string;
  updatedAt: string;
}

/** The record of which target a job actually ran on. */
export interface BoardDispatch {
  issueNumber: number;
  targetId: string;
  /** The selection rationale, kept so the board itself explains the choice. */
  rationale: string;
  recordedAt: string;
}

export interface Board {
  schemaVersion: typeof BOARD_SCHEMA_VERSION;
  nextIssueNumber: number;
  issues: BoardIssue[];
  resources: BoardResource[];
  targets: BoardExecutionTarget[];
  dispatches: BoardDispatch[];
}

export interface LegacyBoardV2 {
  schemaVersion: typeof LEGACY_BOARD_SCHEMA_VERSION;
  nextIssueNumber: number;
  issues: BoardIssue[];
  resources: BoardResource[];
}

export type PersistedBoard = Board | LegacyBoardV2;

export interface ResourceDependencyView {
  number: number;
  state: IssueState;
}

export interface ResourceView {
  host: string;
  /**
   * The registered persistent target whose address is this resource's host, or
   * `null` when no catalogued target claims that address. The host string
   * remains the resource's own coordinate; the target id is the relation, and
   * it is derived rather than stored twice.
   */
  targetId: string | null;
  path: string;
  issues: ResourceDependencyView[];
  protected: boolean;
  collectible: boolean;
}

export interface TargetView extends BoardExecutionTarget {
  /** The durable resources this target's host carries, if it has a host. */
  resources: BoardResource[];
  /** The issues currently dispatched to this target. */
  dispatchedIssues: number[];
}

/**
 * One target as an operator or an orchestrator reads it: identity, what kind of
 * thing it is, how work reaches it, what survives, who cleans up, and where the
 * procedure is written down.
 *
 * This is a projection, not a stored record. Every field is either already on
 * the target or derived from a closed vocabulary by one function here, so a
 * board view, a CLI command and a scheduler all answer these questions the same
 * way and none of them re-derives them. Nothing dynamic lives here: capacity,
 * liveness and quota are observations, they are not part of a registration, and
 * a reader with none of them is missing data rather than reading zeros.
 */
export interface ExecutionTargetAccess {
  readonly targetId: string;
  readonly displayName: string;
  readonly backend: ExecutionTargetBackend;
  readonly kind: ExecutionTargetKind;
  readonly status: ExecutionTargetStatus;
  readonly accessMethod: ExecutionTargetAccessMethod;
  readonly persistence: ExecutionTargetPersistence;
  readonly garbageCollection: ExecutionTargetGarbageCollection;
  readonly capabilities: readonly ExecutionTargetCapability[];
  readonly address: string | null;
  readonly description: string;
  readonly limitations: readonly string[];
  readonly guidance: readonly string[];
}

/** One target's access facts, with every absent field resolved from its kind and backend. */
export function executionTargetAccess(target: BoardExecutionTarget): ExecutionTargetAccess {
  // An empty note list is absence, spelled as absence, at every point where a
  // record is read. The parse rule already refuses one, so a record read back
  // from a board never carries it; a caller that hands a hand-built target
  // straight to this function still gets the backend's own guidance rather than
  // a target that presents as having no guidance document at all.
  const limitations = target.limitations ?? [];
  const guidance = target.guidance !== undefined && target.guidance.length > 0
    ? target.guidance
    : [EXECUTION_TARGET_GUIDANCE[target.backend]];
  return {
    targetId: target.id,
    displayName: target.displayName ?? target.id,
    backend: target.backend,
    kind: target.kind,
    status: target.status,
    accessMethod: target.accessMethod ?? defaultExecutionTargetAccessMethod(target.backend),
    persistence: target.persistence ?? defaultExecutionTargetPersistence(target.kind),
    garbageCollection: target.garbageCollection !== undefined
      ? canonicalGarbageCollection(target.garbageCollection)
      : (target.kind === 'persistent-host' ? 'host-local-collector-available' : 'provider-managed'),
    capabilities: [...target.capabilities],
    address: target.address,
    description: target.description,
    limitations: [...limitations],
    guidance: [...guidance],
  };
}

export function emptyBoard(): Board {
  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    nextIssueNumber: 1,
    issues: [],
    resources: [],
    targets: [],
    dispatches: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isText(value) && Number.isFinite(Date.parse(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isMessage(value: unknown): value is BoardMessage {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'author', 'body', 'createdAt'])
    && isText(value.id)
    && isText(value.author)
    && isText(value.body)
    && isTimestamp(value.createdAt);
}

function isIssue(value: unknown): value is BoardIssue {
  return isRecord(value)
    && hasExactKeys(value, ['number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'messages'])
    && isPositiveSafeInteger(value.number)
    && isText(value.title)
    && typeof value.body === 'string'
    && (value.state === 'open' || value.state === 'closed')
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
    && Array.isArray(value.messages)
    && value.messages.every(isMessage);
}

function isValidHost(host: string): boolean {
  return /^lubko:\/\/[^/\s?#\\]+$/.test(host);
}

/**
 * Why a path is not already in the one canonical form Antonina stores, or `null`
 * when it is. The reason is a value rather than a thrown message so that a caller
 * deciding what to do about a path can distinguish a relative path from a
 * `..` traversal without re-deriving it from prose.
 */
export type PathFormDefect =
  | 'empty'
  | 'relative'
  | 'parent-traversal'
  | 'non-canonical';

export function pathFormDefect(path: string): PathFormDefect | null {
  if (path.length === 0) return 'empty';
  if (path === '/') return null;
  if (path.split('/').some((segment) => segment === '..')) return 'parent-traversal';
  if (!path.startsWith('/')) return 'relative';
  if (path.endsWith('/') || path.includes('//')) return 'non-canonical';
  return path.split('/').some((segment) => segment === '.') ? 'non-canonical' : null;
}

function isValidPath(path: string): boolean {
  return pathFormDefect(path) === null;
}

export function canonicalHost(value: string): string {
  const host = value.trim();
  if (!isValidHost(host)) throw new Error('Host must be lubko://<non-empty-server-name>');
  return host;
}

export function canonicalPath(value: string): string {
  const path = value.trim();
  if (!isValidPath(path)) {
    throw new Error('Path must be an absolute normalized POSIX path without a trailing slash');
  }
  return path;
}

/**
 * A target identity is a lowercase slug. It is compared and ordered by code
 * unit, never by locale, so a selection made on one machine is the selection
 * every other machine makes.
 */
const TARGET_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function canonicalTargetId(value: string): string {
  const id = value.trim();
  if (!TARGET_ID.test(id)) {
    throw new Error('Execution target ID must be a lowercase alphanumeric or dash slug');
  }
  return id;
}

export function parseExecutionTargetBackend(value: string): ExecutionTargetBackend {
  if (!(EXECUTION_TARGET_BACKENDS as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina execution target backend: ' + value);
  }
  return value as ExecutionTargetBackend;
}

export function parseExecutionTargetKind(value: string): ExecutionTargetKind {
  if (!(EXECUTION_TARGET_KINDS as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina execution target kind: ' + value);
  }
  return value as ExecutionTargetKind;
}

export function parseExecutionTargetStatus(value: string): ExecutionTargetStatus {
  if (!(EXECUTION_TARGET_STATUSES as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina execution target status: ' + value);
  }
  return value as ExecutionTargetStatus;
}

export function parseExecutionTargetCapability(value: string): ExecutionTargetCapability {
  if (!(EXECUTION_TARGET_CAPABILITIES as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina execution target capability: ' + value);
  }
  return value as ExecutionTargetCapability;
}

export function parseExecutionTargetAccessMethod(value: string): ExecutionTargetAccessMethod {
  if (!(EXECUTION_TARGET_ACCESS_METHODS as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina execution target access method: ' + value);
  }
  return value as ExecutionTargetAccessMethod;
}

export function parseExecutionTargetPersistence(value: string): ExecutionTargetPersistence {
  if (!(EXECUTION_TARGET_PERSISTENCE as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina execution target persistence: ' + value);
  }
  return value as ExecutionTargetPersistence;
}

export function parseExecutionTargetGarbageCollection(value: string): ExecutionTargetGarbageCollection {
  if ((LEGACY_EXECUTION_TARGET_GARBAGE_COLLECTION as readonly string[]).includes(value)) {
    return canonicalGarbageCollection(value as LegacyExecutionTargetGarbageCollection);
  }
  if (!(EXECUTION_TARGET_GARBAGE_COLLECTION as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina execution target garbage collection: ' + value);
  }
  return value as ExecutionTargetGarbageCollection;
}

/**
 * Why a guidance reference is not a repository-relative document path, or `null`
 * when it is. A guidance entry is a pointer a reader can follow, so an absolute
 * path, a URL, or anything that climbs out of the repository is refused rather
 * than rendered as a link to nowhere.
 */
export function guidancePathDefect(path: string): string | null {
  if (path.length === 0) return 'empty';
  if (path.startsWith('/')) return 'absolute';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return 'not-a-repository-path';
  if (path.split('/').some((segment) => segment === '..')) return 'parent-traversal';
  if (!path.endsWith('.md')) return 'not-a-markdown-document';
  if (path.includes('//')) return 'non-canonical';
  return null;
}

/**
 * A sorted, duplicate-free, non-empty list of non-empty strings, or `null` when
 * the value is not one.
 *
 * An empty list is refused here rather than accepted as a trivially well-formed
 * one, because a note list on a stored record is a claim, and `[]` claims that
 * there is nothing to say. For limitations that is a harmless way of spelling
 * absence; for guidance it is not, since an absent list means the backend's own
 * document and an empty one would silently suppress it. One rule for both keeps
 * the board from holding a value that reads as one thing and is another, so
 * "retract this note" means the field is absent rather than that it is empty.
 */
function canonicalNoteList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(isText)) return null;
  const notes = value as string[];
  if (notes.length === 0) return null;
  const sorted = [...notes].sort();
  if (notes.some((note, index) => note !== sorted[index])) return null;
  if (new Set(notes).size !== notes.length) return null;
  return [...notes];
}

function parseTargetCapabilities(value: unknown): ExecutionTargetCapability[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'
      && (EXECUTION_TARGET_CAPABILITIES as readonly string[]).includes(entry))) {
    throw new Error('Execution target capabilities are malformed');
  }
  const capabilities = value as ExecutionTargetCapability[];
  const sorted = [...capabilities].sort();
  if (capabilities.some((capability, index) => capability !== sorted[index])) {
    throw new Error('Execution target capabilities must be sorted');
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error('Execution target capabilities contain duplicates');
  }
  return [...capabilities];
}

/**
 * What a target record claims about itself, once the record is internally
 * consistent. A persistent host and an ephemeral environment are different
 * shapes of thing, so the record says which it is rather than letting the
 * backend name stand in for it: a persistent host has an address and a durable
 * filesystem, an ephemeral environment has neither.
 */
export function executionTargetDefect(target: BoardExecutionTarget): string | null {
  if (target.kind === 'persistent-host') {
    if (target.address === null) return 'a persistent host requires a Lubko address';
    if (!target.capabilities.includes('persistent-filesystem')) {
      return 'a persistent host requires the persistent-filesystem capability';
    }
    if (target.capabilities.includes('ephemeral-lifetime')) {
      return 'a persistent host cannot declare the ephemeral-lifetime capability';
    }
  } else {
    if (target.address !== null) return 'an ephemeral environment has no Lubko address';
    if (!target.capabilities.includes('ephemeral-lifetime')) {
      return 'an ephemeral environment requires the ephemeral-lifetime capability';
    }
    if (target.capabilities.includes('persistent-filesystem')) {
      return 'an ephemeral environment cannot declare the persistent-filesystem capability';
    }
  }
  if (target.backend === 'github-actions' && target.kind !== 'ephemeral-environment') {
    return 'the github-actions backend runs ephemeral environments only';
  }
  // The descriptive fields are optional, so this is where a record that does
  // carry one is held to it. A target may narrow what its backend and kind
  // provide, but it may not contradict them: every one of these is a claim an
  // orchestrator would otherwise act on.
  if (target.accessMethod !== undefined
      && !(EXECUTION_TARGET_ACCESS_METHODS as readonly string[]).includes(target.accessMethod)) {
    return 'an execution target must declare a known access method';
  }
  if (target.persistence !== undefined
      && !(EXECUTION_TARGET_PERSISTENCE as readonly string[]).includes(target.persistence)) {
    return 'an execution target must declare a known persistence';
  }
  if (target.garbageCollection !== undefined
      && !isRecordedGarbageCollection(target.garbageCollection)) {
    return 'an execution target must declare a known garbage collection';
  }
  if (target.accessMethod !== undefined && target.accessMethod !== defaultExecutionTargetAccessMethod(target.backend)) {
    return 'an execution target must declare the access method its backend provides';
  }
  if (target.persistence !== undefined && target.persistence !== defaultExecutionTargetPersistence(target.kind)) {
    return 'an execution target must declare the persistence its kind has';
  }
  if (target.garbageCollection !== undefined) {
    // The released spelling is allowed here for the same claim, so a board
    // signed before the rename is not a board that has to be rewritten to be
    // readable; it is narrowed to the current value before any reader sees it.
    const allowed: readonly RecordedExecutionTargetGarbageCollection[] = target.kind === 'persistent-host'
      ? ['host-local-collector-available', 'host-local-collector', 'none']
      : ['provider-managed', 'none'];
    if (!allowed.includes(target.garbageCollection)) {
      return target.kind === 'persistent-host'
        ? 'a persistent host cannot declare that the provider manages its garbage collection'
        : 'an ephemeral environment cannot declare that a host-local collector manages it';
    }
  }
  if (target.displayName !== undefined && !isText(target.displayName)) {
    return 'an execution target display name must be a non-empty string';
  }
  if (target.limitations !== undefined && canonicalNoteList(target.limitations) === null) {
    return 'execution target limitations must be a sorted, duplicate-free, non-empty list of notes';
  }
  if (target.guidance !== undefined) {
    if (canonicalNoteList(target.guidance) === null) {
      return 'execution target guidance must be a sorted, duplicate-free, non-empty list of document paths';
    }
    for (const path of target.guidance) {
      const defect = guidancePathDefect(path);
      if (defect !== null) return `execution target guidance path is unusable: ${defect}`;
    }
  }
  return null;
}

const TARGET_REQUIRED_KEYS = [
  'id', 'backend', 'kind', 'status', 'capabilities', 'address', 'description', 'createdAt', 'updatedAt',
] as const;
const TARGET_OPTIONAL_KEYS = [
  'displayName', 'accessMethod', 'persistence', 'garbageCollection', 'limitations', 'guidance',
] as const;

/**
 * A target record may carry any of the descriptive fields and must carry all of
 * the original ones. A record written before those fields existed is still a
 * valid record: those fields were added to this shared API rather than
 * substituted into it, so a board signed without them has to keep verifying and
 * keeps reading through the defaults {@link executionTargetAccess} resolves.
 */
function hasTargetKeys(value: Record<string, unknown>): boolean {
  return TARGET_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) =>
      (TARGET_REQUIRED_KEYS as readonly string[]).includes(key)
      || (TARGET_OPTIONAL_KEYS as readonly string[]).includes(key));
}

function isTarget(value: unknown): value is BoardExecutionTarget {
  if (!isRecord(value)
      || !hasTargetKeys(value)
      || !isText(value.id)
      || !TARGET_ID.test(value.id)
      || typeof value.backend !== 'string'
      || !(EXECUTION_TARGET_BACKENDS as readonly string[]).includes(value.backend)
      || typeof value.kind !== 'string'
      || !(EXECUTION_TARGET_KINDS as readonly string[]).includes(value.kind)
      || !isText(value.status)
      || !(EXECUTION_TARGET_STATUSES as readonly string[]).includes(value.status)
      || (value.address !== null && !isText(value.address))
      || typeof value.description !== 'string'
      || !isTimestamp(value.createdAt)
      || !isTimestamp(value.updatedAt)) {
    return false;
  }
  if (value.address !== null && !isValidHost(value.address)) return false;
  if (value.accessMethod !== undefined
      && !(EXECUTION_TARGET_ACCESS_METHODS as readonly string[]).includes(value.accessMethod as string)) return false;
  if (value.persistence !== undefined
      && !(EXECUTION_TARGET_PERSISTENCE as readonly string[]).includes(value.persistence as string)) return false;
  if (value.garbageCollection !== undefined && !isRecordedGarbageCollection(value.garbageCollection as string)) return false;
  let capabilities: ExecutionTargetCapability[];
  try {
    capabilities = parseTargetCapabilities(value.capabilities);
  } catch {
    return false;
  }
  return executionTargetDefect({
    ...(value as unknown as BoardExecutionTarget),
    capabilities,
  }) === null;
}

function isDispatch(value: unknown, issueNumbers: Set<number>): value is BoardDispatch {
  return isRecord(value)
    && hasExactKeys(value, ['issueNumber', 'targetId', 'rationale', 'recordedAt'])
    && isPositiveSafeInteger(value.issueNumber)
    && issueNumbers.has(value.issueNumber)
    && isText(value.targetId)
    && TARGET_ID.test(value.targetId)
    && isText(value.rationale)
    && isTimestamp(value.recordedAt);
}

/** Code-unit comparison, so ordering never depends on a locale. */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isResource(value: unknown, issueNumbers: Set<number>): value is BoardResource {
  return isRecord(value)
    && hasExactKeys(value, ['host', 'path', 'issueNumbers', 'createdAt', 'updatedAt'])
    && isText(value.host)
    && isValidHost(value.host)
    && isText(value.path)
    && isValidPath(value.path)
    && Array.isArray(value.issueNumbers)
    && value.issueNumbers.length > 0
    && value.issueNumbers.every((number) => isPositiveSafeInteger(number) && issueNumbers.has(number))
    && value.issueNumbers.every((number, index, all) => index === 0 || number > all[index - 1])
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt);
}

const CANONICAL_BOARD_KEYS = [
  'schemaVersion', 'nextIssueNumber', 'issues', 'resources', 'targets', 'dispatches',
] as const;

const LEGACY_BOARD_V2_KEYS = [
  'schemaVersion', 'nextIssueNumber', 'issues', 'resources',
] as const;

/**
 * Why one `BoardMessage` is not a message, or `null` when it is one.
 *
 * This mirrors {@link isMessage} field for field. It is consulted only after
 * that predicate has already refused the value, so it decides which reason is
 * reported and never whether the value is accepted; a drift between the two
 * can therefore only ever cost specificity, never admit a bad record.
 */
function messageDefect(value: unknown, where: string): BoardDefect | null {
  if (!isRecord(value)) return notARecordDefect(where, value);
  if (!hasExactKeys(value, ['id', 'author', 'body', 'createdAt'])) {
    return keySetDefect(where, ['id', 'author', 'body', 'createdAt'], value);
  }
  return firstDefect(where, [
    { field: 'id', expected: 'a non-empty string', ok: isText(value.id), value: value.id },
    { field: 'author', expected: 'a non-empty string', ok: isText(value.author), value: value.author },
    { field: 'body', expected: 'a non-empty string', ok: isText(value.body), value: value.body },
    {
      field: 'createdAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.createdAt),
      value: value.createdAt,
    },
  ]);
}

/** {@link messageDefect} for one message, or the issue-level defect if the element is not even a record. */
function messageElementDefect(issue: BoardIssue, index: number, value: unknown): BoardDefect {
  const where = `board issue ${issue.number} message at index ${index}`;
  const detail = messageDefect(value, where);
  if (detail === null) return unclassifiedElementDefect(where, index);
  return { ...detail, kind: 'element', subject: where, field: detail.field };
}

/** {@link isIssue}, explained. Consulted only after {@link isIssue} has refused. */
function issueDefect(value: unknown, index: number): BoardDefect {
  const where = `board issue at index ${index}`;
  if (!isRecord(value)) return { ...notARecordDefect(where, value), kind: 'element', field: '' };
  if (!hasExactKeys(value, ['number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'messages'])) {
    return { ...keySetDefect(where, ['number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'messages'], value), kind: 'element' };
  }
  const field = firstDefect(where, [
    {
      field: 'number',
      expected: 'a positive safe integer',
      ok: isPositiveSafeInteger(value.number),
      value: value.number,
    },
    { field: 'title', expected: 'a non-empty string', ok: isText(value.title), value: value.title },
    { field: 'body', expected: 'a string', ok: typeof value.body === 'string', value: value.body },
    {
      field: 'state',
      expected: 'the string "open" or "closed"',
      ok: value.state === 'open' || value.state === 'closed',
      value: value.state,
    },
    {
      field: 'createdAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.createdAt),
      value: value.createdAt,
    },
    {
      field: 'updatedAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.updatedAt),
      value: value.updatedAt,
    },
    {
      field: 'messages',
      expected: 'an array of messages',
      ok: Array.isArray(value.messages),
      value: value.messages,
    },
  ]);
  if (field !== null) return { ...field, kind: 'element' };
  const messages = value.messages as unknown[];
  for (let position = 0; position < messages.length; position += 1) {
    const message = messages[position];
    if (message === undefined || !isMessage(message)) {
      return messageElementDefect(value as unknown as BoardIssue, position, message);
    }
  }
  return unclassifiedElementDefect(where, index);
}

/** {@link isResource}, explained. Consulted only after {@link isResource} has refused. */
function resourceDefect(value: unknown, issueNumbers: Set<number>, index: number): BoardDefect {
  const where = `board resource at index ${index}`;
  const at = { kind: 'element' } as const;
  if (!isRecord(value)) return { ...notARecordDefect(where, value), ...at };
  if (!hasExactKeys(value, ['host', 'path', 'issueNumbers', 'createdAt', 'updatedAt'])) {
    const defect = keySetDefect(where, ['host', 'path', 'issueNumbers', 'createdAt', 'updatedAt'], value);
    return { ...defect, ...at };
  }
  const issueList = value.issueNumbers;
  const field = firstDefect(where, [
    { field: 'host', expected: 'a "lubko://" host string', ok: isText(value.host) && isValidHost(value.host), value: value.host },
    {
      field: 'path',
      expected: 'an absolute normalized POSIX path',
      ok: isText(value.path) && isValidPath(value.path),
      value: value.path,
    },
    { field: 'issueNumbers', expected: 'an array of issue numbers', ok: Array.isArray(issueList), value: issueList },
    {
      field: 'issueNumbers',
      expected: 'a non-empty list of issue numbers that exist on this board',
      ok: Array.isArray(issueList) && issueList.length > 0,
      // The count is what makes an empty list and a list of one different
      // failures, and a count is not a value.
      found: Array.isArray(issueList) ? describeArray(issueList, 'at least one issue number') : undefined,
    },
    {
      field: 'createdAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.createdAt),
      value: value.createdAt,
    },
    {
      field: 'updatedAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.updatedAt),
      value: value.updatedAt,
    },
  ]);
  if (field !== null) return { ...field, ...at };
  if (!Array.isArray(issueList)) return unclassifiedElementDefect(where, index);
  for (let position = 0; position < issueList.length; position += 1) {
    const entry = issueList[position];
    if (!isPositiveSafeInteger(entry)) {
      return {
        ...fieldDefect(where, `issueNumbers index ${position}`,
          entry, 'a positive safe integer'),
        kind: 'element',
      };
    }
    if (!issueNumbers.has(entry)) {
      return {
        ...fieldDefect(where, `issueNumbers index ${position}`,
          entry, 'an issue number that exists on this board'),
        kind: 'element',
      };
    }
    const previous = position === 0 ? undefined : issueList[position - 1];
    if (previous !== undefined && typeof entry === 'number' && typeof previous === 'number' && entry <= previous) {
      return {
        ...corruptDefect(
          where, `issueNumbers index ${position}`,
          'repeats or reverses the ascending order of the issue numbers before it',
          'Antonina board resource issue numbers are not in strictly ascending order'),
        kind: 'element',
      };
    }
  }
  return unclassifiedElementDefect(where, index);
}

/** {@link isDispatch}, explained. Consulted only after {@link isDispatch} has refused. */
function dispatchDefect(value: unknown, issueNumbers: Set<number>, index: number): BoardDefect {
  const where = `board dispatch record at index ${index}`;
  const at = { kind: 'element' } as const;
  if (!isRecord(value)) return { ...notARecordDefect(where, value), ...at };
  if (!hasExactKeys(value, ['issueNumber', 'targetId', 'rationale', 'recordedAt'])) {
    const defect = keySetDefect(where, ['issueNumber', 'targetId', 'rationale', 'recordedAt'], value);
    return { ...defect, ...at };
  }
  const field = firstDefect(where, [
    {
      field: 'issueNumber',
      expected: 'a positive safe integer naming an issue on this board',
      ok: isPositiveSafeInteger(value.issueNumber) && issueNumbers.has(value.issueNumber),
      value: value.issueNumber,
    },
    {
      field: 'targetId',
      expected: 'a lowercase alphanumeric or dash slug',
      ok: isText(value.targetId) && TARGET_ID.test(value.targetId),
      value: value.targetId,
    },
    { field: 'rationale', expected: 'a non-empty string', ok: isText(value.rationale), value: value.rationale },
    {
      field: 'recordedAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.recordedAt),
      value: value.recordedAt,
    },
  ]);
  if (field !== null) return { ...field, ...at };
  return unclassifiedElementDefect(where, index);
}

/** {@link isTarget}, explained. Consulted only after {@link isTarget} has refused. */
function targetDefect(value: unknown, index: number): BoardDefect {
  const where = `board execution target at index ${index}`;
  const at = { kind: 'element' } as const;
  if (!isRecord(value)) return { ...notARecordDefect(where, value), ...at };
  if (!hasTargetKeys(value)) return { ...targetKeySetDefect(where, value), ...at };
  const field = firstDefect(where, [
    { field: 'id', expected: 'a lowercase alphanumeric or dash slug', ok: isText(value.id) && TARGET_ID.test(value.id), value: value.id },
    {
      field: 'backend',
      expected: `one of ${EXECUTION_TARGET_BACKENDS.join(', ')}`,
      ok: typeof value.backend === 'string' && (EXECUTION_TARGET_BACKENDS as readonly string[]).includes(value.backend),
      value: value.backend,
    },
    {
      field: 'kind',
      expected: `one of ${EXECUTION_TARGET_KINDS.join(', ')}`,
      ok: typeof value.kind === 'string' && (EXECUTION_TARGET_KINDS as readonly string[]).includes(value.kind),
      value: value.kind,
    },
    {
      field: 'status',
      expected: `one of ${EXECUTION_TARGET_STATUSES.join(', ')}`,
      ok: isText(value.status) && (EXECUTION_TARGET_STATUSES as readonly string[]).includes(value.status),
      value: value.status,
    },
    {
      field: 'address',
      expected: 'a "lubko://" host string, or null',
      ok: value.address === null || (isText(value.address) && isValidHost(value.address)),
      value: value.address,
    },
    { field: 'description', expected: 'a string', ok: typeof value.description === 'string', value: value.description },
    {
      field: 'createdAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.createdAt),
      value: value.createdAt,
    },
    {
      field: 'updatedAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.updatedAt),
      value: value.updatedAt,
    },
    {
      field: 'capabilities',
      expected: 'a sorted, duplicate-free array of capability names',
      ok: targetCapabilitiesOk(value.capabilities),
      value: value.capabilities,
    },
  ]);
  if (field !== null) return { ...field, ...at };
  const consistency = executionTargetDefect({
    ...(value as unknown as BoardExecutionTarget),
    capabilities: value.capabilities as ExecutionTargetCapability[],
  });
  if (consistency !== null) {
    return { ...corruptDefect(`${where}.index ${index}`, '', consistency, `Antonina board execution target at index ${index} is inconsistent: ${consistency}`), ...at };
  }
  return unclassifiedElementDefect(where, index);
}

/** `parseTargetCapabilities` as a predicate, so a capability list can be checked without a throw. */
function targetCapabilitiesOk(value: unknown): boolean {
  try {
    parseTargetCapabilities(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * `hasTargetKeys` explained. A target has required keys and permitted optional
 * ones rather than one exact set, so this reports which required key is absent
 * and which present key is not permitted, and never enumerates the record.
 */
function targetKeySetDefect(subject: string, value: Record<string, unknown>): BoardDefect {
  const missing = TARGET_REQUIRED_KEYS.filter((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) =>
    !(TARGET_REQUIRED_KEYS as readonly string[]).includes(key)
    && !(TARGET_OPTIONAL_KEYS as readonly string[]).includes(key));
  return {
    kind: 'key-set',
    subject,
    field: '',
    found: 'a different set of keys',
    expected: `the required keys ${TARGET_REQUIRED_KEYS.join(', ')}, optionally plus ${TARGET_OPTIONAL_KEYS.join(', ')}`,
    missingKeys: missing,
    unexpectedKeys: unexpected.map(readKeyName),
  };
}

/**
 * The defect reported when the element is refused but no named field explains
 * it. This is a deliberately uninformative fallback rather than a guess: it
 * names the collection and the index and nothing else, so a predicate that
 * learns a new condition it does not yet explain narrows the diagnostic to
 * "look here" instead of quoting a record it does not understand.
 */
/**
 * The top-level shape of a canonical board, explained.
 *
 * `schemaVersion` is checked before the key set on purpose. A board written by
 * a build with a different version is the failure an operator has to be told
 * about first, and a v2 board reaching this reader is missing `targets` and
 * `dispatches` only *because* of its version; reporting the missing keys would
 * send the operator looking for two fields that are supposed to be absent.
 *
 * Called only after the guard has refused, so this chooses a message and never
 * an outcome.
 */
function canonicalBoardDefect(value: unknown): BoardDefect {
  if (!isRecord(value)) return notARecordDefect('board', value);
  if (value.schemaVersion !== BOARD_SCHEMA_VERSION) return versionDefect(value.schemaVersion, BOARD_SCHEMA_VERSION);
  if (!hasExactKeys(value, CANONICAL_BOARD_KEYS)) return keySetDefect('board', CANONICAL_BOARD_KEYS, value);
  const field = firstDefect('board', [
    {
      field: 'nextIssueNumber',
      expected: 'a positive safe integer',
      ok: isPositiveSafeInteger(value.nextIssueNumber),
      value: value.nextIssueNumber,
    },
    { field: 'issues', expected: 'an array of issues', ok: Array.isArray(value.issues), value: value.issues },
    { field: 'resources', expected: 'an array of resources', ok: Array.isArray(value.resources), value: value.resources },
    { field: 'targets', expected: 'an array of execution targets', ok: Array.isArray(value.targets), value: value.targets },
    { field: 'dispatches', expected: 'an array of dispatch records', ok: Array.isArray(value.dispatches), value: value.dispatches },
  ]);
  if (field !== null) return field;
  const issues = value.issues as unknown[];
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    if (issue === undefined || !isIssue(issue)) return issueDefect(issue, index);
  }
  // The remaining collections are checked field by field in `parseCanonicalBoard`,
  // where the issue numbers they refer to are known; naming their elements here
  // would need a second derivation of the same state for no gain.
  return { ...unclassifiedElementDefect('board', 0), subject: 'board', field: '' };
}

/** {@link canonicalBoardDefect} for the four-key v2 board shape. */
function legacyBoardV2Defect(value: unknown): BoardDefect {
  if (!isRecord(value)) return notARecordDefect('board', value);
  if (value.schemaVersion !== LEGACY_BOARD_SCHEMA_VERSION) return versionDefect(value.schemaVersion, LEGACY_BOARD_SCHEMA_VERSION);
  if (!hasExactKeys(value, LEGACY_BOARD_V2_KEYS)) return keySetDefect('board', LEGACY_BOARD_V2_KEYS, value);
  const field = firstDefect('board', [
    {
      field: 'nextIssueNumber',
      expected: 'a positive safe integer',
      ok: isPositiveSafeInteger(value.nextIssueNumber),
      value: value.nextIssueNumber,
    },
    { field: 'issues', expected: 'an array of issues', ok: Array.isArray(value.issues), value: value.issues },
    { field: 'resources', expected: 'an array of resources', ok: Array.isArray(value.resources), value: value.resources },
  ]);
  if (field !== null) return field;
  const issues = value.issues as unknown[];
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    if (issue === undefined || !isIssue(issue)) return issueDefect(issue, index);
  }
  return { ...unclassifiedElementDefect('board', 0), subject: 'board', field: '' };
}

export function parseLegacyBoardV2(value: unknown): LegacyBoardV2 {
  if (!isRecord(value)
      || !hasExactKeys(value, LEGACY_BOARD_V2_KEYS)
      || value.schemaVersion !== LEGACY_BOARD_SCHEMA_VERSION
      || !isPositiveSafeInteger(value.nextIssueNumber)
      || !Array.isArray(value.issues)
      || !value.issues.every(isIssue)
      || !Array.isArray(value.resources)) {
    throw new BoardIncompatibilityError(legacyBoardV2Defect(value));
  }
  const board = value as unknown as LegacyBoardV2;
  const numbers = new Set<number>();
  for (const issue of board.issues) {
    if (numbers.has(issue.number)) {
      throw new BoardIncompatibilityError(corruptDefect(
        'board.issues', `number ${issue.number}`,
        'is used by more than one issue',
        'Antonina board issue number counter is inconsistent with its issues'));
    }
    numbers.add(issue.number);
  }
  if (board.nextIssueNumber <= Math.max(0, ...numbers)) {
    throw new BoardIncompatibilityError(corruptDefect(
      'board', 'nextIssueNumber',
      'does not exceed every issue number already on the board',
      'Antonina board issue number counter is inconsistent with its issues'));
  }
  for (let index = 0; index < board.resources.length; index += 1) {
    const resource = board.resources[index];
    if (resource === undefined || !isResource(resource, numbers)) {
      throw new BoardIncompatibilityError(resourceDefect(resource, numbers, index));
    }
  }
  return structuredClone(board);
}

/**
 * Every persisted board version this build can read, oldest first. Adding a
 * version here is the declaration "boards of this version still exist in the
 * world"; a version that is not listed is refused rather than guessed at.
 *
 * This list lives here, and not in `migrations.ts`, because it is also the list
 * of versions this module has a parser for, and the parser table below needs
 * it. `migrations.ts` imports it from here, so the one declaration of "what
 * this build reads" is read by every consumer: the parser table, the migration
 * registry's obligation, and the gate's refusals.
 */
export const PERSISTED_BOARD_VERSIONS = [
  LEGACY_BOARD_SCHEMA_VERSION,
  BOARD_SCHEMA_VERSION,
] as const;

export type PersistedBoardVersion = (typeof PERSISTED_BOARD_VERSIONS)[number];

/**
 * The board of one specific persisted version. Used to key a parser to the
 * version it reads, so a parser cannot be registered as the reader for a
 * version whose shape it does not produce.
 *
 * What a version bump owes here is bigger than a parser. `PersistedBoard` is a
 * closed union — `Board | LegacyBoardV2` today — and `Board.schemaVersion` is
 * `typeof BOARD_SCHEMA_VERSION`, so the *current* version's entry is satisfied
 * by the interface it already has. The version a bump supersedes has no such
 * entry: moving `BOARD_SCHEMA_VERSION` to 4 without first giving the v3 board an
 * interface of its own makes `PersistedBoardOfVersion<3>` resolve to `never`, and
 * the mapped type on {@link PERSISTED_BOARD_PARSERS} then demands a v3 parser
 * returning `never`. It typechecks — with a parser that cannot be written
 * honestly, and which the suite will then accept as "a reader for v3".
 *
 * So a bump owes the superseded version a persisted *type* as well as a parser:
 * a `BoardV3` interface with `schemaVersion: 3`, added to the `PersistedBoard`
 * union, before the v3 parser is registered. The cheapest-looking alternative,
 * `[3]: (value: unknown) => value as never`, silences the compiler and the
 * obligation at once; it is a hole in the table, not a reader.
 */
type PersistedBoardOfVersion<V extends PersistedBoardVersion> = Extract<PersistedBoard, { schemaVersion: V }>;

/**
 * One parser per supported persisted version.
 *
 * The type is a mapped type over {@link PERSISTED_BOARD_VERSIONS}, the same
 * obligation `migrations.ts` makes of the migration registry: declaring a
 * version this build can read, without giving it a parser, is a typecheck
 * failure rather than a runtime surprise. A version bump therefore cannot
 * merge with a board the previous release wrote that this build then refuses
 * to read on the operation-log parse path.
 *
 * The bump owes a *type* for the superseded version as well as a parser for it;
 * see {@link PersistedBoardOfVersion} for why, and for what a parser registered
 * against a `never` costs.
 *
 * Each parser returns the board of the version it is keyed by, so a v2 reader
 * cannot be filed as the v4 reader even when both typecheck.
 */
const PERSISTED_BOARD_PARSERS: {
  [V in PersistedBoardVersion]: (value: unknown) => PersistedBoardOfVersion<V>;
} = {
  [LEGACY_BOARD_SCHEMA_VERSION]: parseLegacyBoardV2,
  [BOARD_SCHEMA_VERSION]: parseCanonicalBoard,
};

/** Whether `version` is one this build both reads and has a parser for. */
export function isPersistedBoardVersion(version: unknown): version is PersistedBoardVersion {
  return typeof version === 'number'
    && (PERSISTED_BOARD_VERSIONS as readonly number[]).includes(version);
}

/**
 * The runtime half of the mapped type above: every version declared readable
 * has a parser registered, and every registered parser is keyed by a declared
 * version. A registry edited to be incomplete cannot pass unnoticed, which is
 * the same contract {@link everySupersededVersionHasAMigration} gives the
 * migration side.
 */
export function everySupportedVersionHasAParser(): boolean {
  const declared = [...PERSISTED_BOARD_VERSIONS].sort((left, right) => left - right);
  const registered = Object.keys(PERSISTED_BOARD_PARSERS).map(Number).sort((left, right) => left - right);
  return declared.length === registered.length
    && declared.every((version, index) => version === registered[index]);
}

/**
 * The board as it may be found on disk or in a signature: the current format, or
 * one this build still knows how to read. Which one it is decides nothing about
 * *lifting* it — turning an older board into a current one is the migration
 * gate's job, in `migrations.ts`, and this module deliberately exposes no way to
 * do that without it. Recognising the version is a different question from
 * migrating it, and it is answered here, for every version this build claims to
 * read, from {@link PERSISTED_BOARD_PARSERS}.
 *
 * A value whose `schemaVersion` is not one this build reads is refused by
 * `parseCanonicalBoard`, whose version defect names the version found and the
 * version this build reads. That is deliberate: the refusal is about a version
 * Antonina cannot read, not about the shape of the board, and an operator is
 * told which of the two it is.
 */
export function parsePersistedBoard(value: unknown): PersistedBoard {
  if (isRecord(value) && isPersistedBoardVersion(value.schemaVersion)) {
    return PERSISTED_BOARD_PARSERS[value.schemaVersion](value);
  }
  return parseCanonicalBoard(value);
}

export function parseCanonicalBoard(value: unknown): Board {
  // The guard is unchanged from the one this parser always ran: it is the sole
  // authority on what a canonical board is, and it runs first and alone. The
  // defect functions below are only reached when it has already refused, so
  // they choose which reason an operator is told and cannot widen what is
  // accepted. Every defect path below therefore throws in exactly the cases
  // this condition throws in, and no others.
  if (!isRecord(value)
      || !hasExactKeys(value, CANONICAL_BOARD_KEYS)
      || value.schemaVersion !== BOARD_SCHEMA_VERSION
      || !isPositiveSafeInteger(value.nextIssueNumber)
      || !Array.isArray(value.issues)
      || !value.issues.every(isIssue)
      || !Array.isArray(value.resources)
      || !Array.isArray(value.targets)
      || !Array.isArray(value.dispatches)) {
    throw new BoardIncompatibilityError(canonicalBoardDefect(value));
  }

  const board = value as unknown as Board;
  const numbers = new Set<number>();
  for (const issue of board.issues) {
    if (numbers.has(issue.number)) {
      throw new BoardIncompatibilityError(corruptDefect(
        'board.issues', `number ${issue.number}`,
        'is used by more than one issue',
        'Antonina board issue number counter is inconsistent with its issues'));
    }
    numbers.add(issue.number);
    for (let index = 1; index < issue.messages.length; index += 1) {
      const previous = issue.messages[index - 1];
      const current = issue.messages[index];
      if (!previous || !current) {
        throw new BoardIncompatibilityError(corruptDefect(
          `board issue ${issue.number} messages`, `index ${index}`,
          'is missing from an issue that has a message at the index before it',
          `Antonina issue ${issue.number} has malformed messages`));
      }
      if (Date.parse(previous.createdAt) > Date.parse(current.createdAt)) {
        throw new BoardIncompatibilityError(corruptDefect(
          `board issue ${issue.number} messages`, `index ${index}`,
          'was created before the message before it',
          `Antonina issue ${issue.number} has messages out of chronological order`));
      }
    }
  }
  if (board.nextIssueNumber <= Math.max(0, ...numbers)) {
    throw new BoardIncompatibilityError(corruptDefect(
      'board', 'nextIssueNumber',
      'does not exceed every issue number already on the board',
      'Antonina board issue number counter is inconsistent with its issues'));
  }

  const resources = new Set<string>();
  for (let index = 0; index < board.resources.length; index += 1) {
    const resource = board.resources[index];
    // A resource that is not even a record is refused before the duplicate key
    // is derived from it. The base reader read `host` and `path` first and so
    // died on a `null` element with a TypeError; the board is refused either
    // way, and refusing it with a diagnosis rather than a crash is the point.
    if (resource === undefined || !isRecord(resource) || !isResource(resource, numbers)) {
      throw new BoardIncompatibilityError(resourceDefect(resource, numbers, index));
    }
    const key = JSON.stringify([resource.host, resource.path]);
    if (resources.has(key)) {
      throw new BoardIncompatibilityError(corruptDefect(
        'board.resources', `index ${index}`,
        'repeats a host and path already on the board',
        'Antonina board contains duplicate resources'));
    }
    resources.add(key);
  }

  const targetIds = new Set<string>();
  const targetAddresses = new Set<string>();
  for (let index = 0; index < board.targets.length; index += 1) {
    const target = board.targets[index];
    if (target === undefined || !isTarget(target)) {
      throw new BoardIncompatibilityError(targetDefect(target, index));
    }
    if (targetIds.has(target.id)) {
      throw new BoardIncompatibilityError(corruptDefect(
        `board.targets`, `index ${index}`,
        'reuses an execution target identity already on the board',
        'Antonina board contains duplicate execution target identities'));
    }
    targetIds.add(target.id);
    if (target.address !== null) {
      // Two targets answering to one host address would make "the host of this
      // resource" ambiguous, so the address is as identifying as the id here.
      if (targetAddresses.has(target.address)) {
        throw new BoardIncompatibilityError(corruptDefect(
          `board.targets`, `index ${index}.address`,
          'is a Lubko address another execution target already answers to',
          'Antonina board contains two execution targets for one Lubko address'));
      }
      targetAddresses.add(target.address);
    }
  }

  const dispatchedIssues = new Set<number>();
  for (let index = 0; index < board.dispatches.length; index += 1) {
    const dispatch = board.dispatches[index];
    if (dispatch === undefined || !isDispatch(dispatch, numbers)) {
      throw new BoardIncompatibilityError(dispatchDefect(dispatch, numbers, index));
    }
    if (!targetIds.has(dispatch.targetId)) {
      throw new BoardIncompatibilityError(corruptDefect(
        `board.dispatches`, `index ${index}.targetId`,
        'names an execution target that is not registered on this board',
        'Antonina board dispatch record names an unregistered execution target'));
    }
    if (dispatchedIssues.has(dispatch.issueNumber)) {
      throw new BoardIncompatibilityError(corruptDefect(
        `board.dispatches`, `index ${index}.issueNumber`,
        'dispatches an issue another dispatch record already dispatches',
        'Antonina board contains duplicate dispatch records for one issue'));
    }
    dispatchedIssues.add(dispatch.issueNumber);
  }

  return {
    ...board,
    resources: [...board.resources].sort((left, right) =>
      left.host.localeCompare(right.host) || left.path.localeCompare(right.path)),
    targets: [...board.targets].sort((left, right) => compareIds(left.id, right.id)),
    dispatches: [...board.dispatches].sort((left, right) => left.issueNumber - right.issueNumber),
  };
}

export const parseBoard = parseCanonicalBoard;

export function resourceState(
  resource: BoardResource,
  issues: readonly Pick<BoardIssue, 'number' | 'state'>[],
): ResourceState {
  return resource.issueNumbers.some((number) => issues.find((issue) => issue.number === number)?.state === 'open')
    ? 'protected'
    : 'collectible';
}

export function resourceViews(board: Board, host?: string, issueNumber?: number): ResourceView[] {
  const issues = new Map(board.issues.map((issue) => [issue.number, issue] as const));
  return board.resources
    .filter((resource) => host === undefined || resource.host === host)
    .filter((resource) => issueNumber === undefined || resource.issueNumbers.includes(issueNumber))
    .map((resource) => {
      const dependencies = resource.issueNumbers.map((number) => {
        const issue = issues.get(number);
        if (!issue) throw new Error(`Antonina resource references missing issue ${number}`);
        return { number, state: issue.state };
      });
      const isProtected = dependencies.some((dependency) => dependency.state === 'open');
      return {
        host: resource.host,
        targetId: targetIdForHost(board, resource.host),
        path: resource.path,
        issues: dependencies,
        protected: isProtected,
        collectible: !isProtected,
      };
    });
}

/**
 * The catalogued target whose address is this host, or `null` when the board
 * has catalogued no such host. It is `null` rather than an invented identity
 * because a resource on a host Antonina has no target for is a real state: the
 * resource registry is not required to be a subset of the execution catalog.
 */
export function targetIdForHost(board: Board, host: string): string | null {
  return board.targets.find((target) => target.address === host)?.id ?? null;
}

/**
 * The catalogued targets joined with the resources and dispatches that name
 * them.
 *
 * The parameter is the narrow projection of a board this actually needs — the
 * target catalog, the resource registry, and the dispatch list — rather than a
 * whole `Board`, because the reading web client holds is a materialized
 * summary carrying exactly those three, and a whole-board read to render the
 * target tab would contradict "a client reads only the objects it needs".
 */
export function targetViews(
  board: Pick<Board, 'resources' | 'targets' | 'dispatches'>,
): TargetView[] {
  return board.targets.map((target) => ({
    ...target,
    capabilities: [...target.capabilities],
    resources: board.resources.filter((resource) => resource.host === target.address),
    dispatchedIssues: board.dispatches
      .filter((dispatch) => dispatch.targetId === target.id)
      .map((dispatch) => dispatch.issueNumber)
      .sort((left, right) => left - right),
  }));
}

export interface TargetRequirements {
  /** The backend a job needs, or `null` when it does not care. */
  backend: ExecutionTargetBackend | null;
  /** The kind of environment a job needs, or `null` when it does not care. */
  kind: ExecutionTargetKind | null;
  /** Every one of these capabilities must be present, not merely one. */
  capabilities: ExecutionTargetCapability[];
}

export interface TargetRequest {
  /** The target a job explicitly asked for, or `null` to have one selected. */
  targetId?: string | null;
  backend?: ExecutionTargetBackend | null;
  kind?: ExecutionTargetKind | null;
  capabilities?: readonly ExecutionTargetCapability[];
}

/**
 * Why one candidate is not selectable. Each miss names the requirement it
 * fails, so a caller can read the reason off the selection instead of
 * re-deriving it by comparing capabilities itself.
 */
export type TargetRequirementMiss =
  | 'unavailable'
  | `backend=${ExecutionTargetBackend}`
  | `kind=${ExecutionTargetKind}`
  | `capability=${ExecutionTargetCapability}`;

export interface TargetConsideration {
  targetId: string;
  backend: ExecutionTargetBackend;
  kind: ExecutionTargetKind;
  status: ExecutionTargetStatus;
  eligible: boolean;
  unmet: TargetRequirementMiss[];
  /** Capabilities the target has that the requirements never asked for. */
  surplus: ExecutionTargetCapability[];
}

export type TargetSelectionOutcome =
  | 'selected'
  | 'unknown-target'
  | 'unavailable-target'
  | 'ineligible-target'
  | 'no-eligible-target';

export interface TargetSelection {
  outcome: TargetSelectionOutcome;
  target: BoardExecutionTarget | null;
  requestedTargetId: string | null;
  requirements: TargetRequirements;
  /**
   * Every registered target, in ascending target-id order, with the reason it
   * was or was not selectable. The order is the tie-break order below.
   */
  considered: TargetConsideration[];
  /** The rule that decided this outcome, named so it can be checked. */
  rule: 'requested-target' | 'least-surplus-capabilities' | 'no-rule-applies';
  rationale: string;
}

export function canonicalTargetRequirements(request: TargetRequest = {}): TargetRequirements {
  // A request is not a persisted record, so an unordered capability list is
  // canonicalized here instead of refused: two callers who named the same
  // capabilities are making the same request however they ordered them. A
  // repeated capability is still a defect in what was asked for.
  const named = request.capabilities ?? [];
  const capabilities = named.map(parseExecutionTargetCapability);
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error('Requested execution target capabilities contain duplicates');
  }
  return {
    backend: request.backend ?? null,
    kind: request.kind ?? null,
    capabilities: [...capabilities].sort(),
  };
}

function requirementMisses(target: BoardExecutionTarget, requirements: TargetRequirements): TargetRequirementMiss[] {
  const misses: TargetRequirementMiss[] = [];
  if (target.status !== 'available') misses.push('unavailable');
  if (requirements.backend !== null && target.backend !== requirements.backend) {
    misses.push(`backend=${requirements.backend}`);
  }
  if (requirements.kind !== null && target.kind !== requirements.kind) {
    misses.push(`kind=${requirements.kind}`);
  }
  for (const capability of requirements.capabilities) {
    if (!target.capabilities.includes(capability)) misses.push(`capability=${capability}`);
  }
  return misses;
}

function describeMisses(misses: readonly TargetRequirementMiss[]): string {
  return misses.join(', ');
}

/**
 * Selects the target a job runs on, or explains why none was selected.
 *
 * The decision is a pure function of the board and the request: candidates are
 * considered in ascending target-id order, an explicitly requested target is
 * taken as given or refused by name, and otherwise the eligible target with the
 * fewest undeclared capabilities wins, ties broken by the lower target id.
 * Nothing here consults the clock, the registry order, or a host's liveness, so
 * identical board state and an identical request always select the same target.
 */
export function selectExecutionTarget(board: Board, request: TargetRequest = {}): TargetSelection {
  const requirements = canonicalTargetRequirements(request);
  const requestedTargetId = request.targetId ?? null;
  const targets = [...board.targets].sort((left, right) => compareIds(left.id, right.id));
  const considered: TargetConsideration[] = targets.map((target) => {
    const unmet = requirementMisses(target, requirements);
    return {
      targetId: target.id,
      backend: target.backend,
      kind: target.kind,
      status: target.status,
      eligible: unmet.length === 0,
      unmet,
      surplus: target.capabilities.filter((capability) => !requirements.capabilities.includes(capability)),
    };
  });

  const finish = (
    outcome: TargetSelectionOutcome,
    target: BoardExecutionTarget | null,
    rule: TargetSelection['rule'],
    rationale: string,
  ): TargetSelection => ({ outcome, target, requestedTargetId, requirements, considered, rule, rationale });

  if (requestedTargetId !== null) {
    const target = targets.find((candidate) => candidate.id === requestedTargetId);
    if (!target) {
      return finish(
        'unknown-target',
        null,
        'requested-target',
        `requested target ${requestedTargetId} is not registered; ${targets.length} target(s) are registered`,
      );
    }
    const consideration = considered.find((entry) => entry.targetId === requestedTargetId)!;
    if (consideration.unmet.includes('unavailable')) {
      return finish(
        'unavailable-target',
        null,
        'requested-target',
        `requested target ${requestedTargetId} is registered but unavailable`,
      );
    }
    if (consideration.unmet.length > 0) {
      return finish(
        'ineligible-target',
        null,
        'requested-target',
        `requested target ${requestedTargetId} does not meet the declared requirements: `
          + describeMisses(consideration.unmet),
      );
    }
    return finish(
      'selected',
      target,
      'requested-target',
      `requested target ${requestedTargetId} is registered, available, and meets the declared requirements`,
    );
  }

  const eligible = targets
    .map((target) => considered.find((entry) => entry.targetId === target.id)!)
    .filter((entry) => entry.eligible);
  if (eligible.length === 0) {
    if (targets.length === 0) {
      return finish(
        'no-eligible-target',
        null,
        'no-rule-applies',
        'no execution targets are registered',
      );
    }
    const closest = considered.reduce((best, entry) =>
      (entry.unmet.length < best.unmet.length ? entry : best));
    return finish(
      'no-eligible-target',
      null,
      'no-rule-applies',
      `no registered available target meets the declared requirements; closest was ${closest.targetId}, `
        + `missing ${describeMisses(closest.unmet)}`,
    );
  }

  const chosen = eligible.reduce((best, entry) =>
    (entry.surplus.length < best.surplus.length
      || (entry.surplus.length === best.surplus.length && compareIds(entry.targetId, best.targetId) < 0)
      ? entry
      : best));
  const target = targets.find((candidate) => candidate.id === chosen.targetId)!;
  return finish(
    'selected',
    target,
    'least-surplus-capabilities',
    `target ${chosen.targetId} declares the fewest capabilities the request did not ask for `
      + `(${chosen.surplus.length} of ${chosen.surplus.length + requirements.capabilities.length}) `
      + `among ${eligible.length} eligible target(s); ties break on the lower target id`,
  );
}
