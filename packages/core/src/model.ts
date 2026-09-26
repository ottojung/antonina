export const BOARD_SCHEMA_VERSION = 3 as const;
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
  return null;
}

function isTarget(value: unknown): value is BoardExecutionTarget {
  if (!isRecord(value)
      || !hasExactKeys(value, ['id', 'backend', 'kind', 'status', 'capabilities', 'address', 'description', 'createdAt', 'updatedAt'])
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
  let capabilities: ExecutionTargetCapability[];
  try {
    capabilities = parseTargetCapabilities(value.capabilities);
  } catch {
    return false;
  }
  return executionTargetDefect({
    id: value.id,
    backend: value.backend as ExecutionTargetBackend,
    kind: value.kind as ExecutionTargetKind,
    status: value.status as ExecutionTargetStatus,
    capabilities,
    address: value.address as string | null,
    description: value.description,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
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

export function parseCanonicalBoard(value: unknown): Board {
  if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'nextIssueNumber', 'issues', 'resources', 'targets', 'dispatches'])
      || value.schemaVersion !== BOARD_SCHEMA_VERSION
      || !isPositiveSafeInteger(value.nextIssueNumber)
      || !Array.isArray(value.issues)
      || !value.issues.every(isIssue)
      || !Array.isArray(value.resources)
      || !Array.isArray(value.targets)
      || !Array.isArray(value.dispatches)) {
    throw new Error('Antonina board object is incompatible or malformed');
  }

  const board = value as unknown as Board;
  const numbers = new Set<number>();
  for (const issue of board.issues) {
    if (numbers.has(issue.number)) {
      throw new Error('Antonina board issue number counter is inconsistent with its issues');
    }
    numbers.add(issue.number);
    for (let index = 1; index < issue.messages.length; index += 1) {
      const previous = issue.messages[index - 1];
      const current = issue.messages[index];
      if (!previous || !current) throw new Error(`Antonina issue ${issue.number} has malformed messages`);
      if (Date.parse(previous.createdAt) > Date.parse(current.createdAt)) {
        throw new Error(`Antonina issue ${issue.number} has messages out of chronological order`);
      }
    }
  }
  if (board.nextIssueNumber <= Math.max(0, ...numbers)) {
    throw new Error('Antonina board issue number counter is inconsistent with its issues');
  }

  const resources = new Set<string>();
  for (const resource of board.resources) {
    const key = JSON.stringify([resource.host, resource.path]);
    if (resources.has(key)) throw new Error('Antonina board contains duplicate resources');
    resources.add(key);
    if (!isResource(resource, numbers)) {
      throw new Error('Antonina board contains an incompatible or malformed resource');
    }
  }

  const targetIds = new Set<string>();
  const targetAddresses = new Set<string>();
  for (const target of board.targets) {
    if (!isTarget(target)) {
      throw new Error('Antonina board contains an incompatible or malformed execution target');
    }
    if (targetIds.has(target.id)) {
      throw new Error('Antonina board contains duplicate execution target identities');
    }
    targetIds.add(target.id);
    if (target.address !== null) {
      // Two targets answering to one host address would make "the host of this
      // resource" ambiguous, so the address is as identifying as the id here.
      if (targetAddresses.has(target.address)) {
        throw new Error('Antonina board contains two execution targets for one Lubko address');
      }
      targetAddresses.add(target.address);
    }
  }

  const dispatchedIssues = new Set<number>();
  for (const dispatch of board.dispatches) {
    if (!isDispatch(dispatch, numbers)) {
      throw new Error('Antonina board contains an incompatible or malformed dispatch record');
    }
    if (!targetIds.has(dispatch.targetId)) {
      throw new Error('Antonina board dispatch record names an unregistered execution target');
    }
    if (dispatchedIssues.has(dispatch.issueNumber)) {
      throw new Error('Antonina board contains duplicate dispatch records for one issue');
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

export function resourceState(resource: BoardResource, issues: BoardIssue[]): ResourceState {
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

export function targetViews(board: Board): TargetView[] {
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
