export const BOARD_SCHEMA_VERSION = 2 as const;
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type IssueState = 'open' | 'closed';
export type ResourceState = 'protected' | 'collectible';

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

export interface Board {
  schemaVersion: typeof BOARD_SCHEMA_VERSION;
  nextIssueNumber: number;
  issues: BoardIssue[];
  resources: BoardResource[];
}

export interface ResourceDependencyView {
  number: number;
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
  return { schemaVersion: BOARD_SCHEMA_VERSION, nextIssueNumber: 1, issues: [], resources: [] };
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
  if (typeof path !== 'string' || path.length === 0) return 'empty';
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
      || !hasExactKeys(value, ['schemaVersion', 'nextIssueNumber', 'issues', 'resources'])
      || value.schemaVersion !== BOARD_SCHEMA_VERSION
      || !isPositiveSafeInteger(value.nextIssueNumber)
      || !Array.isArray(value.issues)
      || !value.issues.every(isIssue)
      || !Array.isArray(value.resources)) {
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

  return {
    ...board,
    resources: [...board.resources].sort((left, right) =>
      left.host.localeCompare(right.host) || left.path.localeCompare(right.path)),
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
        path: resource.path,
        issues: dependencies,
        protected: isProtected,
        collectible: !isProtected,
      };
    });
}
