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

export const BOARD_SCHEMA_VERSION = 5 as const;
export const RETIRED_BOARD_SCHEMA_VERSION = 4 as const;
export const PREVIOUS_BOARD_SCHEMA_VERSION = 3 as const;
export const LEGACY_BOARD_SCHEMA_VERSION = 2 as const;
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type IssueState = 'open' | 'closed';
export type ResourceState = 'protected' | 'collectible';

export interface BoardMessage {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

/**
 * The two things a review of a branch can conclude.
 *
 * A closed vocabulary, because "how did the review go" is a question about typed
 * membership and not about reading prose. `request-changes` is the verdict that
 * carries a blocker: docs/skills/review.md reserves it for a finding that must
 * be fixed before approval, and docs/skills/itinerary-antonina.md makes "no
 * unresolved review blocker remains" part of the completion predicate. Recording
 * that verdict on the board is what lets the predicate be enforced rather than
 * merely asserted.
 */
export const REVIEW_VERDICTS = ['request-changes', 'approve'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function parseReviewVerdict(value: string): ReviewVerdict {
  if (!(REVIEW_VERDICTS as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina review verdict: ' + value);
  }
  return value as ReviewVerdict;
}

/**
 * A full, lowercase hex object id, or nothing.
 *
 * The commit a review names is the only thing that makes the comparison in
 * {@link reviewMayReplace} mean anything, and a partial or differently cased
 * spelling of one commit is a *different string* from the same commit. So the
 * shape is not "some string that looks like a commit": it is either the whole
 * 40-character lowercase digest or the empty string. `git rev-parse --short`
 * output and a hand-typed digest in the wrong case are refused as malformed
 * rather than stored as some other commit's id, which is what previously let
 * the very same commit be "re-approved" through an abbreviation.
 */
export const REVIEW_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** Whether `value` is a commit id this board is willing to compare. */
export function isReviewCommitId(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || REVIEW_COMMIT_PATTERN.test(value));
}

/**
 * The canonical form of a supplied commit id: surrounding whitespace removed,
 * and nothing else changed.
 *
 * Case is deliberately *not* folded: a digest written `AAAA...` is refused
 * rather than silently repaired, because a reader who cannot be trusted to
 * reproduce a digest exactly is not a reader whose commit ids should be
 * compared against a review blocker's. Refusing at the door is the only shape
 * in which a case-folded id cannot later read as "a different commit".
 */
export function canonicalReviewCommit(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Antonina review commit is not a string');
  const trimmed = value.trim();
  if (!isReviewCommitId(trimmed)) {
    throw new Error('Antonina review commit must be a full 40-character lowercase hex object id or empty: ' + JSON.stringify(value));
  }
  return trimmed;
}

/**
 * One review verdict about one exact commit.
 *
 * `commit` is what makes the record a blocker rather than an opinion. A verdict
 * is about a particular tree: re-reviewing a different commit is how a fix clears
 * a block, so an approval of the very commit a review refused is not a
 * re-review at all, and {@link reviewBlocksCompletion} refuses to read it as
 * one.
 */
export interface BoardReview {
  /** The exact commit the review was about, or empty when no commit was named. */
  commit: string;
  verdict: ReviewVerdict;
  reviewer: string;
  rationale: string;
  recordedAt: string;
}

export interface BoardIssue {
  number: string;
  title: string;
  body: string;
  state: IssueState;
  createdAt: string;
  updatedAt: string;
  messages: BoardMessage[];
  /**
   * The newest recorded review verdict about this issue's work, or absent when
   * no review has been recorded.
   *
   * Optional rather than a collection so that every board signed before this
   * field existed still parses and replays: the operation log is append-only,
   * and a record that could not hold its own history would be a field that can
   * only be written once. Only the newest verdict is kept, because the question
   * the board is asked is whether the work as it stands is cleared, and the
   * superseded verdicts are already in the issue's own append-only thread.
   */
  review?: BoardReview;
  /**
   * Every commit a `request-changes` verdict on this issue has named, so that
   * the newest verdict is not the only thing that decides whether an approval is
   * legitimate.
   *
   * This is the permanent record of what has been blocked, not the set of
   * blockers still in force. The distinction is load-bearing in both
   * directions, and it is the one the field's earlier description got backwards.
   * Keeping only the newest verdict made the override rule order-dependent: an
   * `approve` about one commit followed by a re-block about another commit left
   * the first blocked commit with nothing on the board to stop a later approval
   * of it, and any four-operation ordering could launder a block out from under
   * the rule. A commit named here can never be the commit of an approval,
   * whatever verdicts were recorded since, and an entry is removed only by an
   * approval that names that same commit -- which is refused while it is here.
   * So the set only ever grows, which is the right direction for a record whose
   * whole purpose is to refuse, and which is what
   * docs/skills/orchestrator.md means by "the board keeps every commit a block
   * named, so no ordering of approvals and re-blocks can launder one out".
   *
   * What clears a block is a different thing, and it is the verdict, not this
   * set: docs/skills/itinerary-antonina.md states that "a block is cleared only
   * by an approval naming a commit that no `request-changes` on that issue has
   * named", so `request-changes(a)` followed by `approve(c)` has cleared the
   * blocker and the issue may complete. Reading this set as a completion gate
   * would contradict that sentence and would also make completion unreachable
   * for good after any single block ever existed, because the set never empties.
   * So the set is the override rule's memory, and
   * {@link reviewBlocksCompletion} reads the verdict alone.
   *
   * Optional and append-only, like `review`: a board signed before the field
   * existed still parses and replays.
   */
  outstandingBlocks?: string[];
}

/**
 * Whether a recorded review verdict still blocks this issue's completion, and
 * if so why, or `null` when nothing blocks it.
 *
 * This is the completion predicate docs/skills/itinerary-antonina.md states in
 * prose -- "no unresolved review blocker remains" -- as a function the board can
 * be asked, rather than a sentence an orchestrator is trusted to have read. Only
 * a `request-changes` verdict blocks; an `approve` and an absent review both
 * return `null`, so an issue that was never reviewed is not blocked by the
 * absence of a review, which is a different statement from being approved.
 *
 * `outstandingBlocks` is deliberately not consulted, and the reason is that the
 * two fields answer different questions: this one answers whether the work as it
 * stands is cleared, which is the newest verdict, and `outstandingBlocks`
 * answers which commits may never be approved. An approval naming a commit no
 * block named is the review that cleared the blocker, so reading the permanent
 * block record as a second, permanent blocker would make the two rules
 * contradict each other and would refuse the close of work the board has already
 * cleared.
 */
export function reviewBlocksCompletion(issue: Pick<BoardIssue, 'number' | 'review'>): string | null {
  const review = issue.review;
  if (review === undefined || review.verdict !== 'request-changes') return null;
  const about = review.commit === '' ? 'no named commit' : `commit ${review.commit}`;
  return `issue ${issue.number} carries an unresolved review blocker recorded by ${review.reviewer} against ${about}: ${review.rationale}`;
}

/**
 * Whether a new verdict may be recorded over the ones the issue carries.
 *
 * The rule is narrow on purpose, because the history this repository documents
 * is a recommend-no-merge finding being overridden rather than acted on. So:
 *
 * - recording a verdict over no verdict, or a second blocked verdict, is always
 *   allowed -- a re-review that still finds a blocker is ordinary review work;
 * - an approval is allowed only when it names a commit that no
 *   `request-changes` on this issue has named, because a fix is a new commit
 *   and a re-reading of a commit somebody asked for changes to is not a fix;
 * - the comparison is against every outstanding block on the issue rather than
 *   against the verdict that happens to be newest, so no ordering of four
 *   operations lands an approval on a commit a `request-changes` named;
 * - an approval that names no commit clears nothing, so it is refused while any
 *   block is outstanding rather than becoming the newest verdict and reading as
 *   a clearance.
 *
 * Returns `null` when the record is allowed, and the reason it is refused
 * otherwise, so the caller reports the refusal instead of dropping it.
 */
export function reviewMayReplace(
  issue: Pick<BoardIssue, 'review' | 'outstandingBlocks'>,
  next: BoardReview,
): string | null {
  if (next.verdict !== 'approve') return null;
  const outstanding = issue.outstandingBlocks ?? [];
  if (outstanding.length === 0) return null;
  const named = canonicalReviewCommit(next.commit);
  if (named === '') {
    return 'an approval that names no commit clears no review blocker; name the commit the fix is on so the outstanding blocker can be compared against it';
  }
  if (outstanding.includes(named)) {
    return `an approval cannot clear the review blocker recorded against commit ${named}; re-review the commit that carries the fix`;
  }
  return null;
}

/**
 * The issue's outstanding blocked commits after `next` is recorded.
 *
 * A block adds its commit. An approval removes exactly the commit it names,
 * which is normally none of them: `reviewMayReplace` refuses an approval that
 * names a commit already in the set, and an approval that names a different
 * commit is the review that cleared the block rather than one that discharges
 * the commit it names, so the set is carried forward and only grows. The one
 * case the filter below does remove is the unnamed block: an approval that
 * names a commit clears the `['']` entry, because that is the shape fix 3 in
 * /workspace/BOARD44-REVIEW-2600.md decides explicitly -- a block that named no
 * commit is cleared by the first approval that names one, because that approval
 * is the review that finally looked at a tree. That makes the field's set
 * shrink in exactly the one case the normative text says it does, and never
 * anywhere else.
 */
export function outstandingBlocksAfter(
  issue: Pick<BoardIssue, 'outstandingBlocks'>,
  next: BoardReview,
): string[] {
  const outstanding = issue.outstandingBlocks ?? [];
  if (next.verdict !== 'request-changes') {
    // An approval clears the entry it names. It also clears an unnamed entry,
    // which is the shape fix 3 in /workspace/BOARD44-REVIEW-2600.md decides
    // explicitly: a block that named no commit is cleared by the first approval
    // that names one, because that approval is the review that finally looked
    // at a tree.
    return outstanding.filter((commit) => commit !== next.commit && !(commit === '' && next.commit !== ''));
  }
  const commit = canonicalReviewCommit(next.commit);
  return outstanding.includes(commit) ? [...outstanding] : [...outstanding, commit];
}

export interface BoardResource {
  host: string;
  path: string;
  issueNumbers: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  schemaVersion: typeof BOARD_SCHEMA_VERSION;
  nextIssueNumber: number;
  issues: BoardIssue[];
}

/** Only for verified pre-v5 signed history. Not exposed as active board state. */
export interface LegacyBoardV4 {
  schemaVersion: typeof RETIRED_BOARD_SCHEMA_VERSION;
  nextIssueNumber: number;
  issues: BoardIssue[];
  resources: BoardResource[];
}

export interface LegacyBoardV2 {
  schemaVersion: typeof LEGACY_BOARD_SCHEMA_VERSION;
  nextIssueNumber: number;
  issues: BoardIssue[];
  resources: BoardResource[];
}

export interface LegacyBoardV3 {
  schemaVersion: typeof PREVIOUS_BOARD_SCHEMA_VERSION;
  nextIssueNumber: number;
  issues: BoardIssue[];
  resources: BoardResource[];
  /** Deprecated data is accepted only for migration; it is never exposed as a domain object. */
  targets: unknown[];
  dispatches: unknown[];
}

export type PersistedBoard = Board | LegacyBoardV2 | LegacyBoardV3 | LegacyBoardV4;

export interface ResourceDependencyView {
  number: string;
  state: IssueState;
}

export interface ResourceView {
  host: string;
  path: string;
  issues: ResourceDependencyView[];
  protected: boolean;
  collectible: boolean;
}

export function emptyBoard(): Board {
  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    nextIssueNumber: 1,
    issues: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every key of `value` is required or explicitly optional, and nothing else is.
 *
 * The optional list exists so a signed board written before a field existed
 * still parses: this board is append-only and versioned, and a shape that
 * tightened would make every board it had already written unreadable.
 */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actualKeys = Object.keys(value);
  const known = [...keys, ...optional];
  return keys.every((key) => Object.hasOwn(value, key))
    && actualKeys.every((key) => known.includes(key));
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

/**
 * Boundary adapter for records written before issue identifiers were strings.
 * The signed representation is never mutated; callers receive cloned domain state.
 */
function normalizePersistedIdentifiers(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const board = structuredClone(value);
  if (!Array.isArray(board.issues) || !Array.isArray(board.resources)) return board;
  const asId = (id: unknown): unknown => isPositiveSafeInteger(id) ? String(id) : id;
  board.issues = board.issues.map((issue: unknown) =>
    isRecord(issue) ? { ...issue, number: asId(issue.number) } : issue);
  board.resources = board.resources.map((resource: unknown) =>
    isRecord(resource) && Array.isArray(resource.issueNumbers)
      ? { ...resource, issueNumbers: resource.issueNumbers.map(asId).sort() }
      : resource);
  return board;
}
function oldNumericMaximum(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.issues)) return 0;
  return Math.max(0, ...value.issues.map((issue: unknown) =>
    isRecord(issue) && isPositiveSafeInteger(issue.number) ? issue.number : 0));
}

function isMessage(value: unknown): value is BoardMessage {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'author', 'body', 'createdAt'])
    && isText(value.id)
    && isText(value.author)
    && isText(value.body)
    && isTimestamp(value.createdAt);
}

function isReview(value: unknown): value is BoardReview {
  return isRecord(value)
    && hasExactKeys(value, ['commit', 'verdict', 'reviewer', 'rationale', 'recordedAt'])
    && isReviewCommitId(value.commit)
    && (REVIEW_VERDICTS as readonly string[]).includes(value.verdict as string)
    && isText(value.reviewer)
    && isText(value.rationale)
    && isTimestamp(value.recordedAt);
}

function isOutstandingBlocks(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isReviewCommitId)
    && new Set(value).size === value.length;
}

function isIssue(value: unknown): value is BoardIssue {
  return isRecord(value)
    && hasExactKeys(
      value,
      ['number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'messages'],
      ['review', 'outstandingBlocks'],
    )
    && isText(value.number)
    && isText(value.title)
    && typeof value.body === 'string'
    && (value.state === 'open' || value.state === 'closed')
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
    && Array.isArray(value.messages)
    && value.messages.every(isMessage)
    && (value.review === undefined || isReview(value.review))
    && (value.outstandingBlocks === undefined || isOutstandingBlocks(value.outstandingBlocks));
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

function isResource(value: unknown, issueNumbers: Set<string>): value is BoardResource {
  return isRecord(value)
    && hasExactKeys(value, ['host', 'path', 'issueNumbers', 'createdAt', 'updatedAt'])
    && isText(value.host)
    && isValidHost(value.host)
    && isText(value.path)
    && isValidPath(value.path)
    && Array.isArray(value.issueNumbers)
    && value.issueNumbers.length > 0
    && value.issueNumbers.every((number) => isText(number) && issueNumbers.has(number))
    && value.issueNumbers.every((number, index, all) => index === 0 || number > all[index - 1])
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt);
}

const CANONICAL_BOARD_KEYS = [
  'schemaVersion', 'nextIssueNumber', 'issues',
] as const;
const LEGACY_BOARD_V4_KEYS = [
  'schemaVersion', 'nextIssueNumber', 'issues', 'resources',
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

/** {@link isReview}, explained. Consulted only after {@link isReview} has refused. */
function reviewDefect(value: unknown, where: string): BoardDefect | null {
  const keys = ['commit', 'verdict', 'reviewer', 'rationale', 'recordedAt'];
  if (!isRecord(value)) return notARecordDefect(where, value);
  if (!hasExactKeys(value, keys)) return keySetDefect(where, keys, value);
  return firstDefect(where, [
    {
      field: 'commit',
      expected: 'a full 40-character lowercase hex object id, or empty when no commit was named',
      ok: isReviewCommitId(value.commit),
      value: value.commit,
    },
    {
      field: 'verdict',
      expected: `the string ${REVIEW_VERDICTS.map((v) => `"${v}"`).join(' or ')}`,
      ok: typeof value.verdict === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(value.verdict),
      value: value.verdict,
    },
    { field: 'reviewer', expected: 'a non-empty string', ok: isText(value.reviewer), value: value.reviewer },
    { field: 'rationale', expected: 'a non-empty string', ok: isText(value.rationale), value: value.rationale },
    {
      field: 'recordedAt',
      expected: 'a parseable timestamp string',
      ok: isTimestamp(value.recordedAt),
      value: value.recordedAt,
    },
  ]);
}

/** {@link isIssue}, explained. Consulted only after {@link isIssue} has refused. */
function issueDefect(value: unknown, index: number): BoardDefect {
  const where = `board issue at index ${index}`;
  const issueKeys = ['number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'messages'];
  if (!isRecord(value)) return { ...notARecordDefect(where, value), kind: 'element', field: '' };
  if (!hasExactKeys(value, issueKeys, ['review', 'outstandingBlocks'])) {
    return { ...keySetDefect(where, issueKeys, value), kind: 'element' };
  }
  const field = firstDefect(where, [
    {
      field: 'number',
      expected: 'a non-empty opaque identifier string',
      ok: isText(value.number),
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
  if (value.review !== undefined) {
    const detail = reviewDefect(value.review, `board issue ${value.number as number} review`);
    if (detail !== null) return { ...detail, kind: 'element' };
  }
  if (value.outstandingBlocks !== undefined) {
    const detail = firstDefect(where, [{
      field: 'outstandingBlocks',
      expected: 'an array of full lowercase hex commit ids or empty strings, without repeats',
      ok: isOutstandingBlocks(value.outstandingBlocks),
      value: value.outstandingBlocks,
    }]);
    if (detail !== null) return { ...detail, kind: 'element' };
  }
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
function resourceDefect(value: unknown, issueNumbers: Set<string>, index: number): BoardDefect {
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
    if (!isText(entry)) {
      return {
        ...fieldDefect(where, `issueNumbers index ${position}`,
          entry, 'a non-empty opaque issue identifier'),
        kind: 'element',
      };
    }
    if (!issueNumbers.has(entry)) {
      return {
        ...fieldDefect(where, `issueNumbers index ${position}`,
          entry, 'an issue identifier that exists on this board'),
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

/** Historical v4 shape validation; active v5 boards never consume its resource fields. */
function legacyBoardV4Defect(value: unknown): BoardDefect {
  if (!isRecord(value)) return notARecordDefect('legacy board', value);
  if (value.schemaVersion !== RETIRED_BOARD_SCHEMA_VERSION)
    return versionDefect(value.schemaVersion, RETIRED_BOARD_SCHEMA_VERSION);
  if (!hasExactKeys(value, LEGACY_BOARD_V4_KEYS))
    return keySetDefect('legacy board', LEGACY_BOARD_V4_KEYS, value);
  return { ...unclassifiedElementDefect('legacy board', 0), subject: 'legacy board', field: '' };
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
  // Keep the exact persisted wire values (including JSON numbers) for signature validation.
  const persistedWire = structuredClone(value);
  const counterFloor = oldNumericMaximum(value);
  value = normalizePersistedIdentifiers(value);
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
  const numbers = new Set<string>();
  for (const issue of board.issues) {
    if (numbers.has(issue.number)) {
      throw new BoardIncompatibilityError(corruptDefect(
        'board.issues', `number ${issue.number}`,
        'is used by more than one issue',
        'Antonina board issue number counter is inconsistent with its issues'));
    }
    numbers.add(issue.number);
  }
  if (board.nextIssueNumber <= counterFloor) {
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
  return persistedWire as LegacyBoardV2;
}

export function parseLegacyBoardV3(value: unknown): LegacyBoardV3 {
  const keys = [...LEGACY_BOARD_V2_KEYS, 'targets', 'dispatches'];
  if (!isRecord(value) || value.schemaVersion !== PREVIOUS_BOARD_SCHEMA_VERSION
      || !hasExactKeys(value, keys) || !Array.isArray(value.targets) || !Array.isArray(value.dispatches)) {
    throw new BoardIncompatibilityError(keySetDefect('legacy v3 board', keys, isRecord(value) ? value : {}));
  }
  const validated = parseLegacyBoardV2({
    schemaVersion: LEGACY_BOARD_SCHEMA_VERSION,
    nextIssueNumber: value.nextIssueNumber,
    issues: value.issues,
    resources: value.resources,
  });
  return {
    ...validated,
    schemaVersion: PREVIOUS_BOARD_SCHEMA_VERSION,
    targets: structuredClone(value.targets),
    dispatches: structuredClone(value.dispatches),
  };
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
  PREVIOUS_BOARD_SCHEMA_VERSION,
  RETIRED_BOARD_SCHEMA_VERSION,
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
  [PREVIOUS_BOARD_SCHEMA_VERSION]: parseLegacyBoardV3,
  [RETIRED_BOARD_SCHEMA_VERSION]: parseLegacyBoardV4,
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

export function parseLegacyBoardV4(value: unknown): LegacyBoardV4 {
  const counterFloor = oldNumericMaximum(value);
  value = normalizePersistedIdentifiers(value);
  // The guard is unchanged from the one this parser always ran: it is the sole
  // authority on what a canonical board is, and it runs first and alone. The
  // defect functions below are only reached when it has already refused, so
  // they choose which reason an operator is told and cannot widen what is
  // accepted. Every defect path below therefore throws in exactly the cases
  // this condition throws in, and no others.
  if (!isRecord(value)
      || !hasExactKeys(value, LEGACY_BOARD_V4_KEYS)
      || value.schemaVersion !== RETIRED_BOARD_SCHEMA_VERSION
      || !isPositiveSafeInteger(value.nextIssueNumber)
      || !Array.isArray(value.issues)
      || !value.issues.every(isIssue)
      || !Array.isArray(value.resources)
      ) {
    throw new BoardIncompatibilityError(legacyBoardV4Defect(value));
  }

  const board = value as unknown as LegacyBoardV4;
  const numbers = new Set<string>();
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
  if (board.nextIssueNumber <= counterFloor) {
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

  return {
    ...board,
    resources: [...board.resources].sort((left, right) =>
      left.host.localeCompare(right.host) || left.path.localeCompare(right.path)),
  };
}

export function parseCanonicalBoard(value: unknown): Board {
  const counterFloor = oldNumericMaximum(value);
  value = normalizePersistedIdentifiers(value);
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
      ) {
    throw new BoardIncompatibilityError(canonicalBoardDefect(value));
  }

  const board = value as unknown as Board;
  const numbers = new Set<string>();
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
  if (board.nextIssueNumber <= counterFloor) {
    throw new BoardIncompatibilityError(corruptDefect(
      'board', 'nextIssueNumber',
      'does not exceed every issue number already on the board',
      'Antonina board issue number counter is inconsistent with its issues'));
  }

  return board;
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

export function resourceViews(board: LegacyBoardV4, host?: string, issueNumber?: string): ResourceView[] {
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
        path: resource.path,
        issues: dependencies,
        protected: isProtected,
        collectible: !isProtected,
      };
    });
}
