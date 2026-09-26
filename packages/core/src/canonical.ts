export type CanonicalValue =
  | null
  | boolean
  | string
  | number
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

const textEncoder = new TextEncoder();

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Canonical JSON numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`).join(',')}}`;
}

export function canonicalJson(value: CanonicalValue): string {
  return canonicalize(value);
}

export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return textEncoder.encode(canonicalJson(value));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url value');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBuffer(bytes)));
}

export async function sha256Id(prefix: string, bytes: Uint8Array): Promise<string> {
  return `${prefix}:${base64UrlEncode(await sha256(bytes))}`;
}

export interface SigningKeyPair {
  keyId: string;
  publicKey: string;
  privateKey: string;
}

export async function keyIdFromPublicKey(publicKey: string): Promise<string> {
  return sha256Id('ed25519', base64UrlDecode(publicKey));
}

export async function generateSigningKey(): Promise<SigningKeyPair> {
  const generated = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey));
  const pkcs8Private = new Uint8Array(await crypto.subtle.exportKey('pkcs8', generated.privateKey));
  const publicKey = base64UrlEncode(rawPublic);
  return {
    keyId: await keyIdFromPublicKey(publicKey),
    publicKey,
    privateKey: base64UrlEncode(pkcs8Private),
  };
}

async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ownedBuffer(base64UrlDecode(publicKey)), 'Ed25519', false, ['verify']);
}

async function importPrivateKey(privateKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', ownedBuffer(base64UrlDecode(privateKey)), 'Ed25519', false, ['sign']);
}

export async function signBytes(privateKey: string, bytes: Uint8Array): Promise<string> {
  const key = await importPrivateKey(privateKey);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('Ed25519', key, ownedBuffer(bytes))));
}

export async function verifyBytes(publicKey: string, signature: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKey);
    return crypto.subtle.verify('Ed25519', key, ownedBuffer(base64UrlDecode(signature)), ownedBuffer(bytes));
  } catch {
    return false;
  }
}
