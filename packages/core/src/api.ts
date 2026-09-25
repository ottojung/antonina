import {
  BOARD_SCHEMA_VERSION,
  MAX_SAFE_INTEGER,
  canonicalHost,
  canonicalPath,
  emptyBoard,
  parseBoard,
  resourceViews,
  type Board,
  type BoardIssue,
  type BoardMessage,
  type BoardResource,
  type IssueState,
  type ResourceView,
} from './model.js';

export const ANTONINA_NAMESPACE = 'antonina';
export const BOARD_KEY = 'board-v1';
export const CAPABILITY_STORAGE_KEY = 'antonina:skrynia:capability:board-v1';
export const DEFAULT_BOARD_BASE_URL = 'https://vau.place/_skrynia';
const MAX_ATTEMPTS = 6;
const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/i;

export interface CapabilityStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface BoardApiOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  capability?: string | null;
  capabilityStorage?: CapabilityStorage;
  now?: () => Date;
  newId?: () => string;
  maxAttempts?: number;
  createIfMissingOnMutation?: boolean;
}

interface StoredBoard {
  board: Board;
  etag: string;
}

type Mutation = (board: Board) => Board;

export class AntoninaApiError extends Error {}

function defaultId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class BoardApi {
  private readonly fetcher: typeof fetch;
  private readonly url: string;
  private capability: string | null;
  private readonly capabilityStorage: CapabilityStorage | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxAttempts: number;
  private readonly createIfMissingOnMutation: boolean;

  constructor(options: BoardApiOptions = {}) {
    const baseUrl = options.baseUrl ?? '/_skrynia';
    if (options.maxAttempts !== undefined && options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be positive');
    }
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.url = `${baseUrl.replace(/\/$/, '')}/store/${encodeURIComponent(ANTONINA_NAMESPACE)}/${encodeURIComponent(BOARD_KEY)}`;
    this.capability = options.capability?.trim() || null;
    this.capabilityStorage = options.capabilityStorage;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.createIfMissingOnMutation = options.createIfMissingOnMutation ?? true;
  }

  getCapability(): string | null {
    return this.capability;
  }

  hasWriteAccess(): boolean {
    return this.capability !== null;
  }

  setCapability(capability: string): void {
    const cleanCapability = capability.trim();
    if (!cleanCapability) throw new AntoninaApiError('Antonina write capability is required');
    if (!CAPABILITY_PATTERN.test(cleanCapability)) {
      throw new AntoninaApiError('Antonina write capability must be 64 hexadecimal characters');
    }
    this.capability = cleanCapability;
    this.capabilityStorage?.set(CAPABILITY_STORAGE_KEY, cleanCapability);
  }

  clearCapability(): void {
    this.capability = null;
    this.capabilityStorage?.remove(CAPABILITY_STORAGE_KEY);
  }

  async loadBoard(): Promise<Board> {
    const stored = await this.read();
    if (!stored) throw new AntoninaApiError('Antonina board does not exist');
    return stored.board;
  }

  async ensureBoard(): Promise<Board> {
    return (await this.ensureStored()).board;
  }

  async listIssues(state?: IssueState): Promise<BoardIssue[]> {
    const issues = (await this.loadBoard()).issues;
    return issues
      .filter((issue) => state === undefined || issue.state === state)
      .sort((left, right) => left.number - right.number);
  }

  async getIssue(number: number): Promise<BoardIssue> {
    return this.requireIssue((await this.loadBoard()).issues, number);
  }

  async createIssue(title: string, body = ''): Promise<BoardIssue> {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new AntoninaApiError('Issue title is required');
    let createdNumber = 0;
    const committed = await this.mutate((board) => {
      createdNumber = board.nextIssueNumber;
      if (createdNumber >= MAX_SAFE_INTEGER) {
        throw new AntoninaApiError('Antonina issue number space is exhausted');
      }
      const timestamp = this.now().toISOString();
      const created: BoardIssue = {
        number: createdNumber,
        title: cleanTitle,
        body: body.trim(),
        state: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
      };
      return {
        ...board,
        nextIssueNumber: board.nextIssueNumber + 1,
        issues: [...board.issues, created],
      };
    });
    return this.requireIssue(committed.issues, createdNumber);
  }

  editIssueBody(number: number, body: string): Promise<BoardIssue> {
    return this.updateIssue(number, (issue) => {
      if (issue.state === 'closed') throw new AntoninaApiError(`Antonina issue ${number} is closed`);
      return { ...issue, body: body.trim() };
    });
  }

  async listResources(host?: string, issueNumber?: number): Promise<ResourceView[]> {
    return resourceViews(await this.loadBoard(), host, issueNumber);
  }

  async addResourceDependency(host: string, path: string, issueNumber: number): Promise<BoardResource> {
    let cleanHost: string;
    let cleanPath: string;
    try {
      cleanHost = canonicalHost(host);
      cleanPath = canonicalPath(path);
    } catch (error) {
      throw new AntoninaApiError(error instanceof Error ? error.message : 'Invalid resource');
    }
    let resultKey = '';
    const committed = await this.mutate((board) => {
      const issue = this.requireIssue(board.issues, issueNumber);
      if (issue.state !== 'open') throw new AntoninaApiError(`Antonina issue ${issueNumber} is closed`);
      const candidate = clone(board);
      const timestamp = this.now().toISOString();
      const current = candidate.resources.find((resource) => resource.host === cleanHost && resource.path === cleanPath);
      if (current) {
        if (!current.issueNumbers.includes(issueNumber)) {
          current.issueNumbers.push(issueNumber);
          current.issueNumbers.sort((a, b) => a - b);
          current.updatedAt = timestamp;
        }
      } else {
        candidate.resources.push({
          host: cleanHost,
          path: cleanPath,
          issueNumbers: [issueNumber],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      candidate.resources.sort((left, right) => left.host.localeCompare(right.host) || left.path.localeCompare(right.path));
      resultKey = JSON.stringify([cleanHost, cleanPath]);
      return candidate;
    });
    const resource = committed.resources.find((entry) => JSON.stringify([entry.host, entry.path]) === resultKey);
    if (!resource) throw new AntoninaApiError('Antonina resource disappeared after mutation');
    return resource;
  }

  async removeResourceDependency(host: string, path: string, issueNumber: number): Promise<BoardResource[]> {
    let cleanHost: string;
    let cleanPath: string;
    try {
      cleanHost = canonicalHost(host);
      cleanPath = canonicalPath(path);
    } catch (error) {
      throw new AntoninaApiError(error instanceof Error ? error.message : 'Invalid resource');
    }
    const committed = await this.mutate((board) => {
      const candidate = clone(board);
      const index = candidate.resources.findIndex((resource) => resource.host === cleanHost && resource.path === cleanPath);
      const current = index < 0 ? undefined : candidate.resources[index];
      if (!current || !current.issueNumbers.includes(issueNumber)) {
        throw new AntoninaApiError('Antonina resource dependency does not exist');
      }
      current.issueNumbers = current.issueNumbers.filter((number) => number !== issueNumber);
      if (current.issueNumbers.length === 0) {
        candidate.resources.splice(index, 1);
      } else {
        current.updatedAt = this.latestTimestamp(current.updatedAt);
      }
      return candidate;
    });
    return committed.resources;
  }

  comment(number: number, author: string, body: string): Promise<BoardIssue> {
    const cleanAuthor = author.trim();
    const cleanBody = body.trim();
    if (!cleanAuthor) return Promise.reject(new AntoninaApiError('Message author is required'));
    if (!cleanBody) return Promise.reject(new AntoninaApiError('Message body is required'));
    const messageId = this.newId();
    return this.updateIssue(number, (issue) => {
      const lastMessageAt = issue.messages.at(-1)?.createdAt;
      const createdAt = this.latestTimestamp(lastMessageAt);
      const message: BoardMessage = { id: messageId, author: cleanAuthor, body: cleanBody, createdAt };
      return { ...issue, messages: [...issue.messages, message] };
    });
  }

  close(number: number): Promise<BoardIssue> {
    return this.updateIssue(number, (issue) => ({ ...issue, state: 'closed' }));
  }

  reopen(number: number): Promise<BoardIssue> {
    return this.updateIssue(number, (issue) => ({ ...issue, state: 'open' }));
  }

  private requireIssue(issues: BoardIssue[], number: number): BoardIssue {
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw new AntoninaApiError(`Antonina issue ${number} does not exist`);
    return issue;
  }

  private updateIssue(number: number, update: (issue: BoardIssue) => BoardIssue): Promise<BoardIssue> {
    return this.mutate((board) => {
      const current = this.requireIssue(board.issues, number);
      const updated = update(clone(current));
      const lastMessageAt = updated.messages.at(-1)?.createdAt;
      return {
        ...board,
        issues: board.issues.map((issue) => issue.number === number
          ? { ...updated, updatedAt: this.latestTimestamp(current.updatedAt, lastMessageAt) }
          : issue),
      };
    }).then((board) => this.requireIssue(board.issues, number));
  }

  private latestTimestamp(...floors: Array<string | undefined>): string {
    const now = this.now().getTime();
    const floor = Math.max(now, ...floors.map((timestamp) => timestamp ? Date.parse(timestamp) : Number.NEGATIVE_INFINITY));
    return new Date(floor).toISOString();
  }

  private requireCapability(): string {
    if (!this.capability) throw new AntoninaApiError('A Antonina write capability is required');
    if (!CAPABILITY_PATTERN.test(this.capability)) {
      throw new AntoninaApiError('The Antonina write capability must be 64 hexadecimal characters');
    }
    return this.capability;
  }

  private async mutate(mutate: Mutation): Promise<Board> {
    const capability = this.requireCapability();
    let stored = this.createIfMissingOnMutation ? await this.ensureStored() : await this.requireStored();
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const candidate = mutate(clone(stored.board));
      const response = await this.fetcher(this.url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Skrynia-Capability': capability,
          'If-Match': stored.etag,
        },
        body: JSON.stringify(candidate),
      });
      if (response.status === 412) {
        stored = await this.requireStored();
        continue;
      }
      if (response.status !== 200) throw await this.httpError('PUT', response);
      return (await this.requireStored()).board;
    }
    throw new AntoninaApiError('Antonina board changed too often; the conditional write was not committed');
  }

  private async ensureStored(): Promise<StoredBoard> {
    const existing = await this.read();
    if (existing) return existing;
    const response = await this.fetcher(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skrynia-Mode': 'capability-write' },
      body: JSON.stringify(emptyBoard()),
    });
    if (response.status === 409) return this.requireStored();
    if (response.status !== 201) throw await this.httpError('POST', response);
    const created = await this.parseJson(response, 'Skrynia POST antonina/board-v1') as { mode?: unknown; capability?: unknown };
    if (created.mode !== 'capability-write' || typeof created.capability !== 'string') {
      throw new AntoninaApiError('Skrynia did not return the capability for the Antonina board');
    }
    this.setCapability(created.capability);
    return this.requireStored();
  }

  private async requireStored(): Promise<StoredBoard> {
    const stored = await this.read();
    if (!stored) throw new AntoninaApiError('Antonina board does not exist');
    return stored;
  }

  private async read(): Promise<StoredBoard | null> {
    const response = await this.fetcher(this.url, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw await this.httpError('GET', response);
    const etag = response.headers.get('ETag');
    if (!etag) throw new AntoninaApiError('Skrynia GET board-v1 returned no ETag; refusing an unsafe board write');
    const value = await this.parseJson(response, 'Skrynia GET antonina/board-v1');
    return { board: parseBoard(value), etag };
  }

  private async parseJson(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new AntoninaApiError(`${context} returned invalid JSON`, { cause: error });
    }
  }

  private async httpError(method: string, response: Response): Promise<Error> {
    return new AntoninaApiError(`Skrynia ${method} ${ANTONINA_NAMESPACE}/${BOARD_KEY} failed (${response.status})`);
  }
}

export { BOARD_SCHEMA_VERSION, parseBoard } from './model.js';
