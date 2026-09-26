import { canonicalBytes, keyIdFromPublicKey, sha256Id, signBytes, type CanonicalValue, type SigningKeyPair } from './canonical.js';
import { parseBoard, type Board } from './model.js';

export const OPLOG_SCHEMA_VERSION = 1 as const;

export const BOARD_CAPABILITIES = [
  'board.read',
  'issue.create',
  'issue.edit',
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

export function unsignedOperationValue(operation: UnsignedBoardOperation): CanonicalValue {
  return operation as unknown as CanonicalValue;
}

export async function operationId(operation: UnsignedBoardOperation): Promise<string> {
  return sha256Id('sha256', canonicalBytes(unsignedOperationValue(operation)));
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
  const bytes = canonicalBytes(unsignedOperationValue(unsigned));
  return {
    ...unsigned,
    opId: await sha256Id('sha256', bytes),
    signature: await signBytes(signer.privateKey, bytes),
  };
}
