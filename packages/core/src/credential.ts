import {
  base64UrlDecode,
  canonicalBytes,
  canonicalJson,
  keyIdFromPublicKey,
  signBytes,
  verifyBytes,
  type CanonicalValue,
  type SigningKeyPair,
} from './canonical.js';
import type { BoardTrustAnchor } from './operations.js';

export const BOARD_CREDENTIAL_SCHEMA_VERSION = 1 as const;
export const BOARD_CREDENTIAL_STORAGE_KEY = 'antonina:board-v2:credential';
export const BOARD_TRUST_STORAGE_KEY = 'antonina:board-v2:trust';
export const BOARD_HEAD_STORAGE_KEY = 'antonina:board-v2:accepted-head';

export interface BoardCredential {
  schemaVersion: typeof BOARD_CREDENTIAL_SCHEMA_VERSION;
  boardId: string;
  rootKeyId: string;
  rootPublicKey: string;
  keyId: string;
  publicKey: string;
  privateKey: string;
  storageCapability: string;
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

function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^ed25519:[A-Za-z0-9_-]{43}$/.test(value);
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

function isStorageCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function parseBoardTrustAnchor(value: unknown): BoardTrustAnchor {
  if (!isRecord(value)
      || !hasExactKeys(value, ['boardId', 'rootKeyId', 'rootPublicKey'])
      || !isText(value.boardId)
      || !isKeyId(value.rootKeyId)
      || !isBase64Url(value.rootPublicKey)) {
    throw new Error('Antonina board trust anchor is malformed');
  }
  return {
    boardId: value.boardId,
    rootKeyId: value.rootKeyId,
    rootPublicKey: value.rootPublicKey,
  };
}

export async function verifyBoardTrustAnchor(value: unknown): Promise<BoardTrustAnchor> {
  const anchor = parseBoardTrustAnchor(value);
  const derived = await keyIdFromPublicKey(anchor.rootPublicKey);
  if (derived !== anchor.rootKeyId) throw new Error('Antonina board trust anchor key ID does not match its public key');
  return anchor;
}

export function parseBoardCredential(value: unknown): BoardCredential {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        'schemaVersion',
        'boardId',
        'rootKeyId',
        'rootPublicKey',
        'keyId',
        'publicKey',
        'privateKey',
        'storageCapability',
      ])
      || value.schemaVersion !== BOARD_CREDENTIAL_SCHEMA_VERSION
      || !isText(value.boardId)
      || !isKeyId(value.rootKeyId)
      || !isBase64Url(value.rootPublicKey)
      || !isKeyId(value.keyId)
      || !isBase64Url(value.publicKey)
      || !isBase64Url(value.privateKey)
      || !isStorageCapability(value.storageCapability)) {
    throw new Error('Antonina board credential is malformed');
  }
  return {
    schemaVersion: BOARD_CREDENTIAL_SCHEMA_VERSION,
    boardId: value.boardId,
    rootKeyId: value.rootKeyId,
    rootPublicKey: value.rootPublicKey,
    keyId: value.keyId,
    publicKey: value.publicKey,
    privateKey: value.privateKey,
    storageCapability: value.storageCapability.toLowerCase(),
  };
}

export function credentialTrustAnchor(credential: BoardCredential): BoardTrustAnchor {
  return {
    boardId: credential.boardId,
    rootKeyId: credential.rootKeyId,
    rootPublicKey: credential.rootPublicKey,
  };
}

export function credentialSigningKey(credential: BoardCredential): SigningKeyPair {
  return {
    keyId: credential.keyId,
    publicKey: credential.publicKey,
    privateKey: credential.privateKey,
  };
}

export async function verifyBoardCredential(value: unknown): Promise<BoardCredential> {
  const credential = parseBoardCredential(value);
  const anchor = await verifyBoardTrustAnchor(credentialTrustAnchor(credential));
  const derivedKeyId = await keyIdFromPublicKey(credential.publicKey);
  if (derivedKeyId !== credential.keyId) throw new Error('Antonina credential key ID does not match its public key');

  const challenge = canonicalBytes({
    boardId: anchor.boardId,
    keyId: credential.keyId,
    purpose: 'antonina-board-credential-self-check-v1',
  });
  const signature = await signBytes(credential.privateKey, challenge);
  if (!await verifyBytes(credential.publicKey, signature, challenge)) {
    throw new Error('Antonina credential private key does not match its public key');
  }
  return credential;
}

export async function createBoardCredential(
  anchor: BoardTrustAnchor,
  signingKey: SigningKeyPair,
  storageCapability: string,
): Promise<BoardCredential> {
  return verifyBoardCredential({
    schemaVersion: BOARD_CREDENTIAL_SCHEMA_VERSION,
    boardId: anchor.boardId,
    rootKeyId: anchor.rootKeyId,
    rootPublicKey: anchor.rootPublicKey,
    keyId: signingKey.keyId,
    publicKey: signingKey.publicKey,
    privateKey: signingKey.privateKey,
    storageCapability,
  });
}

export function serializeBoardCredential(credential: BoardCredential): string {
  return canonicalJson(parseBoardCredential(credential) as unknown as CanonicalValue);
}

export function serializeBoardTrustAnchor(anchor: BoardTrustAnchor): string {
  return canonicalJson(parseBoardTrustAnchor(anchor) as unknown as CanonicalValue);
}

export async function parseBoardCredentialText(text: string): Promise<BoardCredential> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('Antonina board credential is not valid JSON', { cause: error });
  }
  return verifyBoardCredential(value);
}

export async function parseBoardTrustAnchorText(text: string): Promise<BoardTrustAnchor> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('Antonina board trust anchor is not valid JSON', { cause: error });
  }
  return verifyBoardTrustAnchor(value);
}

export function assertPublicKeyEncoding(publicKey: string): void {
  const bytes = base64UrlDecode(publicKey);
  if (bytes.byteLength !== 32) throw new Error('Antonina Ed25519 public key must be 32 bytes');
}
