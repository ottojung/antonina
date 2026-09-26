import { canonicalBytes, keyIdFromPublicKey, sha256Id, signBytes, verifyBytes, type CanonicalValue, type SigningKeyPair } from './canonical.js';
import { canonicalHost, canonicalPath, parseBoard, type Board, type BoardIssue } from './model.js';

export const OPLOG_SCHEMA_VERSION = 1 as const;

export const BOARD_CAPABILITIES = [
  'board.read',
  'issue.create',
  'issue.edit',
  'issue.delete',
  'issue.comment',
  'issue.state',
  'queue.reorder',
  'resource.read',
  'resource.modify',
  'board.delete',
  'authority.delegate',
  'authority.revoke',
] as const;

export type BoardCapability = (typeof BOARD_CAPABILITIES)[number];

/** The one place a capability name is accepted or rejected. */
export function parseBoardCapability(value: string): BoardCapability {
  if (!(BOARD_CAPABILITIES as readonly string[]).includes(value)) {
    throw new Error('Unknown Antonina board capability: ' + value);
  }
  return value as BoardCapability;
}

export const BOARD_OPERATION_KINDS = [
  'board.initialize',
  'authority.delegate',
  'authority.revoke',
  'issue.create',
  'issue.edit',
  'issue.comment',
  'issue.close',
  'issue.reopen',
  'issue.delete',
  'resource.add',
  'resource.remove',
  'queue.reorder',
  'board.delete',
] as const;

export type BoardOperationKind = (typeof BOARD_OPERATION_KINDS)[number];

export interface BoardTrustAnchor {
  boardId: string;
  rootKeyId: string;
  rootPublicKey: string;
}

export interface InitializePayload {
  board: Board;
}

export interface DelegatePayload {
  childKeyId: string;
  childPublicKey: string;
  capabilities: BoardCapability[];
}

export interface RevokePayload {
  keyId: string;
}

export interface IssueCreatePayload {
  number: number;
  title: string;
  body: string;
}

export interface IssueEditPayload {
  number: number;
  title: string | null;
  body: string | null;
}

export interface IssueReferencePayload {
  number: number;
}

export interface IssueCommentPayload {
  number: number;
  author: string;
  body: string;
}

export interface ResourcePayload {
  number: number;
  host: string;
  path: string;
}

export interface QueueReorderPayload {
  numbers: number[];
}

export type BoardOperationPayload =
  | InitializePayload
  | DelegatePayload
  | RevokePayload
  | IssueCreatePayload
  | IssueEditPayload
  | IssueReferencePayload
  | IssueCommentPayload
  | ResourcePayload
  | QueueReorderPayload
  | Record<string, never>;

export interface UnsignedBoardOperation {
  schemaVersion: typeof OPLOG_SCHEMA_VERSION;
  boardId: string;
  previous: string | null;
  signerKeyId: string;
  timestamp: string;
  nonce: string;
  kind: BoardOperationKind;
  payload: BoardOperationPayload;
}

export interface SignedBoardOperation extends UnsignedBoardOperation {
  opId: string;
  signature: string;
}

export interface BoardOperationLog {
  schemaVersion: typeof OPLOG_SCHEMA_VERSION;
  boardId: string;
  rootKeyId: string;
  head: string | null;
  operations: SignedBoardOperation[];
}

export interface SignOperationInput {
  boardId: string;
  previous: string | null;
  timestamp: string;
  nonce: string;
  kind: BoardOperationKind;
  payload: BoardOperationPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isText(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[A-Za-z0-9_-]{43}$/.test(value);
}

function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^ed25519:[A-Za-z0-9_-]{43}$/.test(value);
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

function isCapability(value: unknown): value is BoardCapability {
  return typeof value === 'string' && (BOARD_CAPABILITIES as readonly string[]).includes(value);
}

function parseCapabilities(value: unknown): BoardCapability[] {
  if (!Array.isArray(value) || !value.every(isCapability)) throw new Error('Delegation capabilities are malformed');
  const capabilities = [...value] as BoardCapability[];
  const sorted = [...capabilities].sort();
  if (capabilities.some((capability, index) => capability !== sorted[index])) {
    throw new Error('Delegation capabilities must be sorted');
  }
  if (new Set(capabilities).size !== capabilities.length) throw new Error('Delegation capabilities contain duplicates');
  return capabilities;
}

function parsePayload(kind: BoardOperationKind, value: unknown): BoardOperationPayload {
  if (!isRecord(value)) throw new Error(`Operation payload for ${kind} is malformed`);
  switch (kind) {
    case 'board.initialize': {
      if (!hasExactKeys(value, ['board'])) throw new Error('Initialize payload is malformed');
      return { board: parseBoard(value.board) };
    }
    case 'authority.delegate': {
      if (!hasExactKeys(value, ['childKeyId', 'childPublicKey', 'capabilities'])
          || !isKeyId(value.childKeyId)
          || !isBase64Url(value.childPublicKey)) {
        throw new Error('Delegation payload is malformed');
      }
      return {
        childKeyId: value.childKeyId,
        childPublicKey: value.childPublicKey,
        capabilities: parseCapabilities(value.capabilities),
      };
    }
    case 'authority.revoke': {
      if (!hasExactKeys(value, ['keyId']) || !isKeyId(value.keyId)) throw new Error('Revocation payload is malformed');
      return { keyId: value.keyId };
    }
    case 'issue.create': {
      if (!hasExactKeys(value, ['number', 'title', 'body'])
          || !isPositiveSafeInteger(value.number)
          || !isText(value.title)
          || typeof value.body !== 'string') {
        throw new Error('Issue-create payload is malformed');
      }
      return { number: value.number, title: value.title, body: value.body };
    }
    case 'issue.edit': {
      if (!hasExactKeys(value, ['number', 'title', 'body'])
          || !isPositiveSafeInteger(value.number)
          || (value.title !== null && !isText(value.title))
          || (value.body !== null && typeof value.body !== 'string')
          || (value.title === null && value.body === null)) {
        throw new Error('Issue-edit payload is malformed');
      }
      return { number: value.number, title: value.title as string | null, body: value.body as string | null };
    }
    case 'issue.comment': {
      if (!hasExactKeys(value, ['number', 'author', 'body'])
          || !isPositiveSafeInteger(value.number)
          || !isText(value.author)
          || !isText(value.body)) {
        throw new Error('Issue-comment payload is malformed');
      }
      return { number: value.number, author: value.author, body: value.body };
    }
    case 'issue.close':
    case 'issue.reopen':
    case 'issue.delete': {
      if (!hasExactKeys(value, ['number']) || !isPositiveSafeInteger(value.number)) {
        throw new Error(`${kind} payload is malformed`);
      }
      return { number: value.number };
    }
    case 'resource.add':
    case 'resource.remove': {
      if (!hasExactKeys(value, ['number', 'host', 'path'])
          || !isPositiveSafeInteger(value.number)
          || !isText(value.host)
          || !isText(value.path)) {
        throw new Error(`${kind} payload is malformed`);
      }
      return { number: value.number, host: value.host, path: value.path };
    }
    case 'queue.reorder': {
      if (!hasExactKeys(value, ['numbers'])
          || !Array.isArray(value.numbers)
          || !value.numbers.every(isPositiveSafeInteger)
          || new Set(value.numbers).size !== value.numbers.length) {
        throw new Error('Queue-reorder payload is malformed');
      }
      return { numbers: [...value.numbers] as number[] };
    }
    case 'board.delete': {
      if (!hasExactKeys(value, [])) throw new Error('Board-delete payload is malformed');
      return {};
    }
  }
}

export function parseUnsignedBoardOperation(value: unknown): UnsignedBoardOperation {
  if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'boardId', 'previous', 'signerKeyId', 'timestamp', 'nonce', 'kind', 'payload'])
      || value.schemaVersion !== OPLOG_SCHEMA_VERSION
      || !isText(value.boardId)
      || (value.previous !== null && !isOperationId(value.previous))
      || !isKeyId(value.signerKeyId)
      || !isCanonicalTimestamp(value.timestamp)
      || !isText(value.nonce)
      || typeof value.kind !== 'string'
      || !(BOARD_OPERATION_KINDS as readonly string[]).includes(value.kind)) {
    throw new Error('Signed board operation header is malformed');
  }
  const kind = value.kind as BoardOperationKind;
  return {
    schemaVersion: OPLOG_SCHEMA_VERSION,
    boardId: value.boardId,
    previous: value.previous as string | null,
    signerKeyId: value.signerKeyId,
    timestamp: value.timestamp,
    nonce: value.nonce,
    kind,
    payload: parsePayload(kind, value.payload),
  };
}

export function parseSignedBoardOperation(value: unknown): SignedBoardOperation {
  if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'boardId', 'previous', 'signerKeyId', 'timestamp', 'nonce', 'kind', 'payload', 'opId', 'signature'])
      || !isOperationId(value.opId)
      || !isBase64Url(value.signature)) {
    throw new Error('Signed board operation is malformed');
  }
  const unsigned = parseUnsignedBoardOperation({
    schemaVersion: value.schemaVersion,
    boardId: value.boardId,
    previous: value.previous,
    signerKeyId: value.signerKeyId,
    timestamp: value.timestamp,
    nonce: value.nonce,
    kind: value.kind,
    payload: value.payload,
  });
  return { ...unsigned, opId: value.opId, signature: value.signature };
}

export function parseOperationLog(value: unknown): BoardOperationLog {
  if (!isRecord(value)
      || !hasExactKeys(value, ['schemaVersion', 'boardId', 'rootKeyId', 'head', 'operations'])
      || value.schemaVersion !== OPLOG_SCHEMA_VERSION
      || !isText(value.boardId)
      || !isKeyId(value.rootKeyId)
      || (value.head !== null && !isOperationId(value.head))
      || !Array.isArray(value.operations)) {
    throw new Error('Antonina signed operation log is malformed');
  }
  const operations = value.operations.map(parseSignedBoardOperation);
  return {
    schemaVersion: OPLOG_SCHEMA_VERSION,
    boardId: value.boardId,
    rootKeyId: value.rootKeyId,
    head: value.head as string | null,
    operations,
  };
}

export function emptyOperationLog(anchor: BoardTrustAnchor): BoardOperationLog {
  return {
    schemaVersion: OPLOG_SCHEMA_VERSION,
    boardId: anchor.boardId,
    rootKeyId: anchor.rootKeyId,
    head: null,
    operations: [],
  };
}

export async function createTrustAnchor(boardId: string, root: SigningKeyPair): Promise<BoardTrustAnchor> {
  if (!isText(boardId)) throw new Error('Board ID is required');
  const derived = await keyIdFromPublicKey(root.publicKey);
  if (derived !== root.keyId) throw new Error('Root signing key ID does not match its public key');
  return { boardId, rootKeyId: root.keyId, rootPublicKey: root.publicKey };
}

export async function operationId(operation: UnsignedBoardOperation): Promise<string> {
  return sha256Id('sha256', canonicalBytes(operation as unknown as CanonicalValue));
}

export async function signBoardOperation(input: SignOperationInput, signer: SigningKeyPair): Promise<SignedBoardOperation> {
  const derivedSigner = await keyIdFromPublicKey(signer.publicKey);
  if (derivedSigner !== signer.keyId) throw new Error('Signing key ID does not match its public key');
  const unsigned = parseUnsignedBoardOperation({
    schemaVersion: OPLOG_SCHEMA_VERSION,
    boardId: input.boardId,
    previous: input.previous,
    signerKeyId: signer.keyId,
    timestamp: input.timestamp,
    nonce: input.nonce,
    kind: input.kind,
    payload: input.payload,
  });
  const bytes = canonicalBytes(unsigned as unknown as CanonicalValue);
  return {
    ...unsigned,
    opId: await sha256Id('sha256', bytes),
    signature: await signBytes(signer.privateKey, bytes),
  };
}


export interface VerifiedAuthority {
  keyId: string;
  publicKey: string;
  parentKeyId: string | null;
  capabilities: BoardCapability[];
  revoked: boolean;
}

export interface VerifiedBoardState {
  board: Board;
  queue: number[];
  authorities: VerifiedAuthority[];
  deleted: boolean;
  head: string;
}

export interface VerifyOperationLogOptions {
  previouslyAcceptedHead?: string | null;
}

export class OperationLogVerificationError extends Error {}

function unsignedFromSigned(operation: SignedBoardOperation): UnsignedBoardOperation {
  return {
    schemaVersion: operation.schemaVersion,
    boardId: operation.boardId,
    previous: operation.previous,
    signerKeyId: operation.signerKeyId,
    timestamp: operation.timestamp,
    nonce: operation.nonce,
    kind: operation.kind,
    payload: operation.payload,
  };
}

function requiredCapability(kind: BoardOperationKind): BoardCapability | null {
  switch (kind) {
    case 'board.initialize': return null;
    case 'authority.delegate': return 'authority.delegate';
    case 'authority.revoke': return 'authority.revoke';
    case 'issue.create': return 'issue.create';
    case 'issue.edit': return 'issue.edit';
    case 'issue.delete': return 'issue.delete';
    case 'issue.comment': return 'issue.comment';
    case 'issue.close':
    case 'issue.reopen': return 'issue.state';
    case 'resource.add':
    case 'resource.remove': return 'resource.modify';
    case 'queue.reorder': return 'queue.reorder';
    case 'board.delete': return 'board.delete';
  }
}

function requireIssue(board: Board, number: number): BoardIssue {
  const issue = board.issues.find((candidate) => candidate.number === number);
  if (!issue) throw new OperationLogVerificationError(`Operation references missing issue ${number}`);
  return issue;
}

function exactOpenIssueQueue(board: Board, numbers: number[]): void {
  const expected = board.issues.filter((issue) => issue.state === 'open').map((issue) => issue.number).sort((a, b) => a - b);
  const actual = [...numbers].sort((a, b) => a - b);
  if (expected.length !== actual.length || expected.some((number, index) => number !== actual[index])) {
    throw new OperationLogVerificationError('Queue reorder must contain every open issue exactly once');
  }
}

function descendantsOf(authorities: Map<string, VerifiedAuthority>, root: string): Set<string> {
  const result = new Set<string>([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const authority of authorities.values()) {
      if (authority.parentKeyId !== null && result.has(authority.parentKeyId) && !result.has(authority.keyId)) {
        result.add(authority.keyId);
        changed = true;
      }
    }
  }
  return result;
}

function cloneBoard(board: Board): Board {
  return structuredClone(board);
}

function applyBoardMutation(
  operation: SignedBoardOperation,
  board: Board,
  queue: number[],
): { board: Board; queue: number[]; deleted: boolean } {
  const candidate = cloneBoard(board);
  let nextQueue = [...queue];
  switch (operation.kind) {
    case 'board.initialize':
    case 'authority.delegate':
    case 'authority.revoke':
      return { board: candidate, queue: nextQueue, deleted: false };
    case 'issue.create': {
      const payload = operation.payload as IssueCreatePayload;
      if (payload.number !== candidate.nextIssueNumber) {
        throw new OperationLogVerificationError('Issue-create number must equal the next issue number');
      }
      if (candidate.nextIssueNumber >= Number.MAX_SAFE_INTEGER) {
        throw new OperationLogVerificationError('Issue number space is exhausted');
      }
      candidate.issues.push({
        number: payload.number,
        title: payload.title,
        body: payload.body,
        state: 'open',
        createdAt: operation.timestamp,
        updatedAt: operation.timestamp,
        messages: [],
      });
      candidate.nextIssueNumber += 1;
      nextQueue.push(payload.number);
      break;
    }
    case 'issue.edit': {
      const payload = operation.payload as IssueEditPayload;
      const issue = requireIssue(candidate, payload.number);
      if (issue.state === 'closed') throw new OperationLogVerificationError('Closed issue descriptions cannot be edited');
      if (payload.title !== null) issue.title = payload.title;
      if (payload.body !== null) issue.body = payload.body;
      issue.updatedAt = operation.timestamp;
      break;
    }
    case 'issue.comment': {
      const payload = operation.payload as IssueCommentPayload;
      const issue = requireIssue(candidate, payload.number);
      issue.messages.push({
        id: operation.opId,
        author: payload.author,
        body: payload.body,
        createdAt: operation.timestamp,
      });
      issue.updatedAt = operation.timestamp;
      break;
    }
    case 'issue.close': {
      const payload = operation.payload as IssueReferencePayload;
      const issue = requireIssue(candidate, payload.number);
      issue.state = 'closed';
      issue.updatedAt = operation.timestamp;
      nextQueue = nextQueue.filter((number) => number !== payload.number);
      break;
    }
    case 'issue.reopen': {
      const payload = operation.payload as IssueReferencePayload;
      const issue = requireIssue(candidate, payload.number);
      issue.state = 'open';
      issue.updatedAt = operation.timestamp;
      if (!nextQueue.includes(payload.number)) nextQueue.push(payload.number);
      break;
    }
    case 'issue.delete': {
      const payload = operation.payload as IssueReferencePayload;
      requireIssue(candidate, payload.number);
      candidate.issues = candidate.issues.filter((issue) => issue.number !== payload.number);
      candidate.resources = candidate.resources.flatMap((resource) => {
        const issueNumbers = resource.issueNumbers.filter((number) => number !== payload.number);
        return issueNumbers.length === 0 ? [] : [{ ...resource, issueNumbers, updatedAt: operation.timestamp }];
      });
      nextQueue = nextQueue.filter((number) => number !== payload.number);
      break;
    }
    case 'resource.add': {
      const payload = operation.payload as ResourcePayload;
      const issue = requireIssue(candidate, payload.number);
      if (issue.state !== 'open') throw new OperationLogVerificationError('A resource dependency requires an open issue');
      const host = canonicalHost(payload.host);
      const path = canonicalPath(payload.path);
      const current = candidate.resources.find((resource) => resource.host === host && resource.path === path);
      if (current) {
        if (!current.issueNumbers.includes(payload.number)) {
          current.issueNumbers.push(payload.number);
          current.issueNumbers.sort((a, b) => a - b);
          current.updatedAt = operation.timestamp;
        }
      } else {
        candidate.resources.push({
          host,
          path,
          issueNumbers: [payload.number],
          createdAt: operation.timestamp,
          updatedAt: operation.timestamp,
        });
      }
      candidate.resources.sort((left, right) => left.host.localeCompare(right.host) || left.path.localeCompare(right.path));
      break;
    }
    case 'resource.remove': {
      const payload = operation.payload as ResourcePayload;
      const host = canonicalHost(payload.host);
      const path = canonicalPath(payload.path);
      const index = candidate.resources.findIndex((resource) => resource.host === host && resource.path === path);
      const current = index < 0 ? undefined : candidate.resources[index];
      if (!current || !current.issueNumbers.includes(payload.number)) {
        throw new OperationLogVerificationError('Resource dependency does not exist');
      }
      current.issueNumbers = current.issueNumbers.filter((number) => number !== payload.number);
      if (current.issueNumbers.length === 0) candidate.resources.splice(index, 1);
      else current.updatedAt = operation.timestamp;
      break;
    }
    case 'queue.reorder': {
      const payload = operation.payload as QueueReorderPayload;
      exactOpenIssueQueue(candidate, payload.numbers);
      nextQueue = [...payload.numbers];
      break;
    }
    case 'board.delete':
      return { board: candidate, queue: nextQueue, deleted: true };
  }
  return { board: parseBoard(candidate), queue: nextQueue, deleted: false };
}

function publicAuthorities(authorities: Map<string, VerifiedAuthority>): VerifiedAuthority[] {
  return [...authorities.values()]
    .map((authority) => ({ ...authority, capabilities: [...authority.capabilities] }))
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
}

export async function verifyAndReplayOperationLog(
  value: unknown,
  anchor: BoardTrustAnchor,
  options: VerifyOperationLogOptions = {},
): Promise<VerifiedBoardState> {
  const derivedRootKeyId = await keyIdFromPublicKey(anchor.rootPublicKey);
  if (derivedRootKeyId !== anchor.rootKeyId) {
    throw new OperationLogVerificationError('Root trust anchor key ID does not match its public key');
  }

  const log = parseOperationLog(value);
  if (log.boardId !== anchor.boardId || log.rootKeyId !== anchor.rootKeyId) {
    throw new OperationLogVerificationError('Operation log does not match the configured board trust anchor');
  }
  if (log.operations.length === 0) {
    throw new OperationLogVerificationError('Operation log has not been initialized');
  }

  const authorities = new Map<string, VerifiedAuthority>();
  authorities.set(anchor.rootKeyId, {
    keyId: anchor.rootKeyId,
    publicKey: anchor.rootPublicKey,
    parentKeyId: null,
    capabilities: [...BOARD_CAPABILITIES],
    revoked: false,
  });

  let previous: string | null = null;
  let previousTimestamp: string | null = null;
  let board: Board | undefined;
  let queue: number[] = [];
  let deleted = false;
  const seen = new Set<string>();

  for (let index = 0; index < log.operations.length; index += 1) {
    const operation = log.operations[index]!;
    if (operation.boardId !== anchor.boardId) {
      throw new OperationLogVerificationError('Operation belongs to a different board');
    }
    if (operation.previous !== previous) {
      throw new OperationLogVerificationError('Operation history predecessor chain is invalid');
    }
    if (previousTimestamp !== null && operation.timestamp < previousTimestamp) {
      throw new OperationLogVerificationError('Operation history timestamps must be nondecreasing');
    }

    const unsigned = unsignedFromSigned(operation);
    const bytes = canonicalBytes(unsigned as unknown as CanonicalValue);
    const expectedId = await sha256Id('sha256', bytes);
    if (operation.opId !== expectedId) throw new OperationLogVerificationError('Operation identity hash is invalid');
    if (seen.has(operation.opId)) throw new OperationLogVerificationError('Operation history contains a duplicate operation');
    seen.add(operation.opId);

    const authority = authorities.get(operation.signerKeyId);
    if (!authority || authority.revoked) {
      throw new OperationLogVerificationError('Operation signer is unknown or revoked');
    }
    if (!await verifyBytes(authority.publicKey, operation.signature, bytes)) {
      throw new OperationLogVerificationError('Operation signature is invalid');
    }

    if (index === 0) {
      if (operation.kind !== 'board.initialize'
          || operation.signerKeyId !== anchor.rootKeyId
          || operation.previous !== null) {
        throw new OperationLogVerificationError('First operation must initialize the board under the root authority');
      }
      board = cloneBoard((operation.payload as InitializePayload).board);
      queue = board.issues.filter((issue) => issue.state === 'open').map((issue) => issue.number);
      previous = operation.opId;
      previousTimestamp = operation.timestamp;
      continue;
    }
    if (operation.kind === 'board.initialize') {
      throw new OperationLogVerificationError('Board initialization may only appear as the first operation');
    }
    if (!board) throw new OperationLogVerificationError('Board state is not initialized');
    if (deleted) throw new OperationLogVerificationError('Operations may not follow board deletion');

    const capability = requiredCapability(operation.kind);
    if (capability !== null && !authority.capabilities.includes(capability)) {
      throw new OperationLogVerificationError(`Signer lacks required capability ${capability}`);
    }

    if (operation.kind === 'authority.delegate') {
      const payload = operation.payload as DelegatePayload;
      if (authorities.has(payload.childKeyId)) {
        throw new OperationLogVerificationError('Delegated key ID has already appeared in this board history');
      }
      const childKeyId = await keyIdFromPublicKey(payload.childPublicKey);
      if (childKeyId !== payload.childKeyId) {
        throw new OperationLogVerificationError('Delegated key ID does not match its public key');
      }
      for (const childCapability of payload.capabilities) {
        if (!authority.capabilities.includes(childCapability)) {
          throw new OperationLogVerificationError('Delegation attempts capability escalation');
        }
      }
      authorities.set(payload.childKeyId, {
        keyId: payload.childKeyId,
        publicKey: payload.childPublicKey,
        parentKeyId: authority.keyId,
        capabilities: [...payload.capabilities],
        revoked: false,
      });
    } else if (operation.kind === 'authority.revoke') {
      const payload = operation.payload as RevokePayload;
      if (payload.keyId === anchor.rootKeyId) {
        throw new OperationLogVerificationError('Root authority cannot be revoked through the board log');
      }
      const target = authorities.get(payload.keyId);
      if (!target || target.revoked) {
        throw new OperationLogVerificationError('Revocation target is unknown or already revoked');
      }
      for (const keyId of descendantsOf(authorities, payload.keyId)) {
        const descendant = authorities.get(keyId);
        if (descendant) descendant.revoked = true;
      }
    } else {
      const applied = applyBoardMutation(operation, board, queue);
      board = applied.board;
      queue = applied.queue;
      deleted = applied.deleted;
    }

    previous = operation.opId;
    previousTimestamp = operation.timestamp;
  }

  if (!board || previous === null) throw new OperationLogVerificationError('Operation log has no initialized board state');
  if (log.head !== previous) throw new OperationLogVerificationError('Operation log head does not match its signed history');

  const remembered = options.previouslyAcceptedHead;
  if (remembered !== undefined && remembered !== null && !seen.has(remembered)) {
    throw new OperationLogVerificationError('Operation log does not contain the previously accepted head; refusing rollback or divergent replacement');
  }

  return {
    board: parseBoard(board),
    queue: [...queue],
    authorities: publicAuthorities(authorities),
    deleted,
    head: previous,
  };
}
