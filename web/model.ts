export const BOARD_SCHEMA_VERSION = 2;

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

function isMessage(value: unknown): value is BoardMessage {
  return isRecord(value) && hasExactKeys(value, ['id', 'author', 'body', 'createdAt'])
    && isText(value.id) && isText(value.author) && isText(value.body) && isTimestamp(value.createdAt);
}

function isIssue(value: unknown, allowEmptyBody: boolean): value is BoardIssue {
  return isRecord(value) && hasExactKeys(value, ['number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'messages'])
    && Number.isSafeInteger(value.number) && (value.number as number) > 0 && isText(value.title)
    && (allowEmptyBody ? typeof value.body === 'string' : isText(value.body))
    && (value.state === 'open' || value.state === 'closed') && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt) && Array.isArray(value.messages) && value.messages.every(isMessage);
}

function isValidHost(host: string): boolean {
  return /^lubko:\/\/[^/\s]+$/.test(host);
}

function isValidPath(path: string): boolean {
  if (path === '/') return true;
  return path.startsWith('/') && !path.endsWith('/') && !/(?:\/\/|\/\.?(?:\/|$))/.test(path)
    && path.split('/').every((segment) => segment !== '.' && segment !== '..');
}

export function canonicalHost(value: string): string {
  const host = value.trim();
  if (!isValidHost(host)) throw new Error('Host must be lubko://<non-empty-server-name>');
  return host;
}

export function canonicalPath(value: string): string {
  const path = value.trim();
  if (!isValidPath(path)) throw new Error('Path must be an absolute normalized POSIX path without a trailing slash');
  return path;
}

function isResource(value: unknown, issueNumbers: Set<number>): value is BoardResource {
  return isRecord(value) && hasExactKeys(value, ['host', 'path', 'issueNumbers', 'createdAt', 'updatedAt'])
    && isText(value.host) && isValidHost(value.host) && isText(value.path) && isValidPath(value.path)
    && Array.isArray(value.issueNumbers) && value.issueNumbers.length > 0
    && value.issueNumbers.every((number) => Number.isSafeInteger(number) && issueNumbers.has(number as number))
    && value.issueNumbers.every((number, index, all) => index === 0 || (number as number) > (all[index - 1] as number))
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function validateBoard(board: Board): Board {
  const numbers = new Set<number>();
  for (const issue of board.issues) {
    if (numbers.has(issue.number)) throw new Error(`Antonina board contains duplicate issue ${issue.number}`);
    numbers.add(issue.number);
    for (let index = 1; index < issue.messages.length; index += 1) {
      if (Date.parse(issue.messages[index - 1].createdAt) > Date.parse(issue.messages[index].createdAt)) {
        throw new Error(`Antonina issue ${issue.number} has messages out of chronological order`);
      }
    }
  }
  if (board.nextIssueNumber <= Math.max(0, ...numbers)) throw new Error('Antonina board issue number counter is inconsistent with its issues');
  const resources = new Set<string>();
  for (const resource of board.resources) {
    const key = JSON.stringify([resource.host, resource.path]);
    if (resources.has(key)) throw new Error('Antonina board contains a duplicate resource');
    resources.add(key);
    if (!isResource(resource, numbers)) throw new Error('Antonina board contains a malformed resource');
  }
  return board;
}

export function parseCanonicalBoard(value: unknown): Board {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'nextIssueNumber', 'issues', 'resources'])
      || value.schemaVersion !== BOARD_SCHEMA_VERSION || !Number.isSafeInteger(value.nextIssueNumber)
      || (value.nextIssueNumber as number) < 1 || !Array.isArray(value.issues) || !value.issues.every((entry) => isIssue(entry, true))
      || !Array.isArray(value.resources)) throw new Error('Skrynia object antonina/board-v1 contains an incompatible or malformed board');
  return validateBoard(value as unknown as Board);
}

export function parseBoard(value: unknown): Board {
  return parseCanonicalBoard(value);
}

export function resourceState(resource: BoardResource, issues: BoardIssue[]): ResourceState {
  return resource.issueNumbers.some((number) => issues.find((issue) => issue.number === number)?.state === 'open')
    ? 'protected' : 'collectible';
}
