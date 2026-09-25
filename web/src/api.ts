import { BOARD_SCHEMA_VERSION, canonicalHost, canonicalPath, emptyBoard, type Board, type BoardIssue, type BoardMessage, type BoardResource, parseBoard } from './model';

export const ANTONINA_NAMESPACE = 'antonina';
export const BOARD_KEY = 'board-v1';
const CAPABILITY_STORAGE_KEY = 'antonina:skrynia:capability:board-v1';
const MAX_ATTEMPTS = 6;

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
}

interface StoredBoard {
  board: Board;
  etag: string;
}

export type BoardInitialization = {
  board: Board;
  initializedElsewhere: boolean;
};

export class AntoninaApiError extends Error {}

type Mutation = (board: Board) => Board;

function browserStorage(): CapabilityStorage {
  return {
    get: (key) => window.localStorage.getItem(key),
    set: (key, value) => window.localStorage.setItem(key, value),
    remove: (key) => window.localStorage.removeItem(key),
  };
}

function defaultId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class BoardApi {
  private readonly fetcher: typeof fetch;
  private readonly url: string;
  private capability: string | null;
  private readonly capabilityStorage?: CapabilityStorage;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxAttempts: number;

  constructor(options: BoardApiOptions = {}) {
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.url = `${options.baseUrl ?? '/_skrynia'}/store/${encodeURIComponent(ANTONINA_NAMESPACE)}/${encodeURIComponent(BOARD_KEY)}`;
    this.capability = options.capability ?? null;
    this.capabilityStorage = options.capabilityStorage;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
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
    if (!/^[0-9a-f]{64}$/i.test(cleanCapability)) {
      throw new AntoninaApiError('Antonina write capability must be 64 hexadecimal characters');
    }
    this.capability = cleanCapability;
    this.capabilityStorage?.set(CAPABILITY_STORAGE_KEY, cleanCapability);
  }

  clearCapability(): void {
    this.capability = null;
    this.capabilityStorage?.remove(CAPABILITY_STORAGE_KEY);
  }

  async loadBoard(): Promise<Board | null> {
    return (await this.read())?.board ?? null;
  }

  async initializeBoard(): Promise<BoardInitialization> {
    const response = await this.fetcher(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skrynia-Mode': 'capability-write' },
      body: JSON.stringify(emptyBoard()),
    });
    if (response.status === 409) {
      const winner = await this.read();
      if (!winner) throw new AntoninaApiError('Antonina board initialization raced, but the board could not be read');
      return { board: winner.board, initializedElsewhere: true };
    }
    if (response.status !== 201) throw await this.httpError('POST', response);
    const created = (await response.json()) as { mode?: string; capability?: string };
    if (created.mode !== 'capability-write' || !created.capability) {
      throw new AntoninaApiError('Skrynia did not return the editing key for the Antonina board');
    }
    this.setCapability(created.capability);
    const confirmed = await this.read();
    if (!confirmed) throw new AntoninaApiError('Antonina board could not be read after initialization');
    return { board: confirmed.board, initializedElsewhere: false };
  }

  createIssue(title: string, body = ''): Promise<BoardIssue> {
    const cleanTitle = title.trim();
    if (!cleanTitle) return Promise.reject(new AntoninaApiError('Issue title is required'));
    let created: BoardIssue | undefined;
    return this.mutate((board) => {
      const timestamp = this.now().toISOString();
      created = {
        number: board.nextIssueNumber,
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
    }).then((board) => board.issues.find((issue) => issue.number === created?.number) as BoardIssue);
  }

  editIssueBody(number: number, body: string): Promise<BoardIssue> {
    return this.updateIssue(number, (issue) => {
      if (issue.state === 'closed') throw new AntoninaApiError('Closed issue descriptions cannot be edited');
      return { ...issue, body: body.trim() };
    });
  }

  listResources(): Promise<BoardResource[]> {
    return this.requireBoard().then((board) => board.resources);
  }

  addResourceDependency(host: string, path: string, issueNumber: number): Promise<BoardResource> {
    let cleanHost: string;
    let cleanPath: string;
    try {
      cleanHost = canonicalHost(host);
      cleanPath = canonicalPath(path);
    } catch (error) {
      return Promise.reject(new AntoninaApiError(error instanceof Error ? error.message : 'Invalid resource'));
    }
    let created: BoardResource | undefined;
    return this.mutate((board) => {
      const issue = this.requireIssue(board.issues, issueNumber);
      if (issue.state !== 'open') throw new AntoninaApiError('A resource dependency requires an open issue');
      const key = JSON.stringify([cleanHost, cleanPath]);
      const index = board.resources.findIndex((resource) => JSON.stringify([resource.host, resource.path]) === key);
      const timestamp = this.now().toISOString();
      if (index >= 0) {
        const current = board.resources[index];
        if (current.issueNumbers.includes(issueNumber)) {
          created = current;
          return board;
        }
        created = { ...current, issueNumbers: [...current.issueNumbers, issueNumber].sort((a, b) => a - b), updatedAt: timestamp };
        return { ...board, resources: board.resources.map((resource, resourceIndex) => resourceIndex === index ? created! : resource) };
      }
      created = { host: cleanHost, path: cleanPath, issueNumbers: [issueNumber], createdAt: timestamp, updatedAt: timestamp };
      return { ...board, resources: [...board.resources, created] };
    }).then((board) => board.resources.find((resource) => resource.host === created?.host && resource.path === created?.path)!);
  }

  removeResourceDependency(host: string, path: string, issueNumber: number): Promise<BoardResource | undefined> {
    let cleanHost: string;
    let cleanPath: string;
    try {
      cleanHost = canonicalHost(host);
      cleanPath = canonicalPath(path);
    } catch (error) {
      return Promise.reject(new AntoninaApiError(error instanceof Error ? error.message : 'Invalid resource'));
    }
    let removed: BoardResource | undefined;
    return this.mutate((board) => {
      const index = board.resources.findIndex((resource) => resource.host === cleanHost && resource.path === cleanPath);
      if (index < 0) throw new AntoninaApiError('Antonina resource does not exist');
      const current = board.resources[index];
      if (!current.issueNumbers.includes(issueNumber)) throw new AntoninaApiError('The issue is not a resource dependency');
      removed = current;
      const remaining = current.issueNumbers.filter((number) => number !== issueNumber);
      const resources = remaining.length
        ? board.resources.map((resource, resourceIndex) => resourceIndex === index ? { ...resource, issueNumbers: remaining, updatedAt: this.now().toISOString() } : resource)
        : board.resources.filter((_, resourceIndex) => resourceIndex !== index);
      return { ...board, resources };
    }).then(() => removed);
  }

  listIssues(): Promise<BoardIssue[]> {
    return this.requireBoard().then((board) => board.issues);
  }

  getIssue(number: number): Promise<BoardIssue> {
    return this.listIssues().then((issues) => this.requireIssue(issues, number));
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
      const updated = update(current);
      const lastMessageAt = updated.messages.at(-1)?.createdAt;
      return {
        ...board,
        issues: board.issues.map((issue) => issue.number === number
          ? {
              ...updated,
              updatedAt: this.latestTimestamp(current.updatedAt, lastMessageAt),
            }
          : issue),
      };
    }).then((board) => this.requireIssue(board.issues, number));
  }

  private latestTimestamp(...earlierThan: Array<string | undefined>): string {
    const now = this.now().getTime();
    const floor = Math.max(now, ...earlierThan.map((timestamp) => timestamp ? Date.parse(timestamp) : Number.NEGATIVE_INFINITY));
    return new Date(floor).toISOString();
  }

  private async mutate(mutate: Mutation): Promise<Board> {
    if (!this.capability) {
      throw new AntoninaApiError('An Antonina write capability is required');
    }
    const initial = await this.read();
    if (!initial) throw new AntoninaApiError('Antonina board does not exist; initialize it before editing');
    let stored = initial;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const response = await this.fetcher(this.url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Skrynia-Capability': this.capability,
          'If-Match': stored.etag,
        },
        body: JSON.stringify(mutate(stored.board)),
      });
      if (response.status === 412) {
        const latest = await this.read();
        if (!latest) throw new AntoninaApiError('Antonina board disappeared during a conditional write');
        stored = latest;
        continue;
      }
      if (response.status !== 200) throw await this.httpError('PUT', response);
      return (await this.read())?.board ?? this.requireReadAfterWrite();
    }
    throw new AntoninaApiError('Antonina board changed too often; the conditional write was not committed');
  }

  private async requireBoard(): Promise<Board> {
    const board = await this.loadBoard();
    if (!board) throw new AntoninaApiError('Antonina board does not exist; initialize it before use');
    return board;
  }

  private async read(): Promise<StoredBoard | null> {
    const response = await this.fetcher(this.url, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw await this.httpError('GET', response);
    const etag = response.headers.get('ETag');
    if (!etag) throw new AntoninaApiError(`Skrynia GET ${BOARD_KEY} returned no ETag; refusing to risk an unconditional write`);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new AntoninaApiError(`Skrynia object antonina/${BOARD_KEY} is not valid JSON`, { cause: error });
    }
    return { board: parseBoard(value), etag };
  }

  private requireReadAfterWrite(): never {
    throw new AntoninaApiError('Antonina board could not be confirmed after a conditional write');
  }

  private async httpError(method: string, response: Response): Promise<Error> {
    let detail = '';
    try {
      const body = await response.json() as { error?: string };
      detail = body.error ? `: ${body.error}` : '';
    } catch {}
    return new AntoninaApiError(`Skrynia ${method} ${ANTONINA_NAMESPACE}/${BOARD_KEY} failed (${response.status})${detail}`);
  }
}

export function createBrowserBoardApi(storage: CapabilityStorage = browserStorage()): BoardApi {
  return new BoardApi({ capability: storage.get(CAPABILITY_STORAGE_KEY), capabilityStorage: storage });
}

export { CAPABILITY_STORAGE_KEY, parseBoard, BOARD_SCHEMA_VERSION };
