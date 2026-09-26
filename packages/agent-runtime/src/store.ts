import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { validateAgentMetadata, type AgentMetadata } from './metadata.js';
import { persistedAgentId, procStartTicks } from './process.js';

const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 400;
const LOCK_TOKEN = /^[0-9a-f]{32}$/;

export interface StoreFs {
  closeSync: typeof nodeFs.closeSync;
  fsyncSync: typeof nodeFs.fsyncSync;
  mkdirSync: typeof nodeFs.mkdirSync;
  openSync: typeof nodeFs.openSync;
  readFileSync: typeof nodeFs.readFileSync;
  renameSync: typeof nodeFs.renameSync;
  rmSync: typeof nodeFs.rmSync;
  unlinkSync: typeof nodeFs.unlinkSync;
  writeFileSync: typeof nodeFs.writeFileSync;
}

const DEFAULT_FS: StoreFs = {
  closeSync: nodeFs.closeSync,
  fsyncSync: nodeFs.fsyncSync,
  mkdirSync: nodeFs.mkdirSync,
  openSync: nodeFs.openSync,
  readFileSync: nodeFs.readFileSync,
  renameSync: nodeFs.renameSync,
  rmSync: nodeFs.rmSync,
  unlinkSync: nodeFs.unlinkSync,
  writeFileSync: nodeFs.writeFileSync,
};

export interface StatePathsOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  fs?: StoreFs;
}

export class AgentStateMissingError extends Error {}
export class MetadataReadError extends Error {}
export class MetadataLockError extends Error {}
export class MetadataWriteError extends Error {}

function filesystem(options: StatePathsOptions): StoreFs {
  return options.fs ?? DEFAULT_FS;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function agentDirectoryMissing(
  agentId: string,
  options: StatePathsOptions,
  fs: StoreFs,
  errorKind: 'read' | 'write',
): boolean {
  const directory = agentDir(agentId, options);
  let fd: number;
  try {
    fd = fs.openSync(directory, 'r');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return true;
    const message = `failed to inspect state directory for agent ${agentId}`;
    if (errorKind === 'read') throw new MetadataReadError(message, { cause: error });
    throw new MetadataWriteError(message, { cause: error });
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    const message = `failed to close state directory for agent ${agentId}`;
    if (errorKind === 'read') throw new MetadataReadError(message, { cause: error });
    throw new MetadataWriteError(message, { cause: error });
  }
  return false;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function stateRoot(options: StatePathsOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const base = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(base, 'antonina');
}

export function agentsDir(options: StatePathsOptions = {}): string {
  return join(stateRoot(options), 'agents');
}

export function agentDir(agentId: string, options: StatePathsOptions = {}): string {
  return join(agentsDir(options), agentId);
}

export function metaPath(agentId: string, options: StatePathsOptions = {}): string {
  return join(agentDir(agentId, options), 'meta.json');
}

export function logPath(agentId: string, options: StatePathsOptions = {}): string {
  return join(agentDir(agentId, options), 'output.log');
}

export function readMeta(agentId: string, options: StatePathsOptions = {}): AgentMetadata | null {
  if (persistedAgentId(agentId) !== agentId) {
    throw new MetadataReadError('managed-agent id is malformed');
  }
  const fs = filesystem(options);
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath(agentId, options), 'utf8') as string;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      if (agentDirectoryMissing(agentId, options, fs, 'read')) return null;
      throw new MetadataReadError(`metadata file is missing for agent ${agentId}`, { cause: error });
    }
    throw new MetadataReadError(`failed to read metadata for agent ${agentId}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new MetadataReadError(`managed-agent metadata for ${agentId} is malformed JSON`, { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MetadataReadError(`managed-agent metadata for ${agentId} is malformed`);
  }
  const meta = value as AgentMetadata;
  try {
    validateAgentMetadata(meta);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new MetadataReadError(`managed-agent metadata for ${agentId} is incompatible or malformed${detail}`, { cause: error });
  }
  if (persistedAgentId(meta.id) !== agentId) {
    throw new MetadataReadError(`managed-agent metadata id for ${agentId} is malformed or mismatched`);
  }
  return meta;
}

function syncDirectory(path: string, fs: StoreFs): void {
  let fd: number;
  try {
    fd = fs.openSync(path, 'r');
  } catch (error) {
    throw new MetadataWriteError(`failed to open metadata directory for sync: ${path}`, { cause: error });
  }
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    throw new MetadataWriteError(`failed to sync metadata directory: ${path}`, { cause: error });
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      throw new MetadataWriteError(`failed to close metadata directory: ${path}`, { cause: error });
    }
  }
}

export function writeMeta(agentId: string, meta: AgentMetadata, options: StatePathsOptions = {}): void {
  if (persistedAgentId(agentId) !== agentId || persistedAgentId(meta.id) !== agentId) {
    throw new MetadataWriteError('managed-agent metadata id is malformed or mismatched');
  }
  try {
    validateAgentMetadata(meta);
  } catch (error) {
    throw new MetadataWriteError(`refusing to persist incompatible or malformed metadata for agent ${agentId}`, { cause: error });
  }
  const fs = filesystem(options);
  const destination = metaPath(agentId, options);
  const directory = dirname(destination);
  const temporary = join(directory, `.meta-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | null = null;
  try {
    // The directory must already exist. Never recreate it here: a missing
    // directory means deletion won the race and durable authority is gone.
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, destination);
    syncDirectory(directory, fs);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    if (error instanceof MetadataWriteError) throw error;
    if (hasCode(error, 'ENOENT') && agentDirectoryMissing(agentId, options, fs, 'write')) {
      throw new AgentStateMissingError(`agent state disappeared while writing metadata for ${agentId}`, { cause: error });
    }
    throw new MetadataWriteError(`failed to persist metadata for agent ${agentId}`, { cause: error });
  }
}

interface LockOwner {
  pid: number;
  startTicks: number | null;
  // Identifies one acquisition, not one process. pid/startTicks are process
  // identity, so a still-live process that re-acquires after a delete/re-create
  // cycle would otherwise produce a byte-identical record; the token keeps every
  // acquisition distinguishable. Absent in records written before tokens existed,
  // which are then distinguished by raw content.
  token: string | null;
}

type LockOwnerRecord =
  | { state: 'missing' }
  | { state: 'malformed' }
  | { state: 'valid'; owner: LockOwner; raw: string };

function parseLockOwner(path: string, fs: StoreFs): LockOwnerRecord {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8') as string;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { state: 'missing' };
    throw new MetadataLockError(`failed to read metadata lock: ${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: 'malformed' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: 'malformed' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    return { state: 'malformed' };
  }
  if (
    record.startTicks !== null
    && (typeof record.startTicks !== 'number' || !Number.isSafeInteger(record.startTicks) || record.startTicks < 0)
  ) {
    return { state: 'malformed' };
  }
  if (record.token !== undefined && (typeof record.token !== 'string' || !LOCK_TOKEN.test(record.token))) {
    return { state: 'malformed' };
  }
  return {
    state: 'valid',
    owner: { pid: record.pid, startTicks: record.startTicks as number | null, token: (record.token as string) ?? null },
    raw,
  };
}

// Two records name the same acquisition only when they share a token. Records
// without a token predate acquisition tokens, so they fall back to exact-content
// identity, which is all that can be established about them.
function sameAcquisition(left: LockOwner, right: LockOwner): boolean {
  if (left.token !== null && right.token !== null) return left.token === right.token;
  return `${left.pid}/${left.startTicks}` === `${right.pid}/${right.startTicks}`;
}

function lockOwnerAlive(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch {
    return false;
  }
  if (owner.startTicks === null) return true;
  return procStartTicks(owner.pid) === owner.startTicks;
}

async function acquireLock(path: string, fs: StoreFs): Promise<{ fd: number; raw: string; owner: LockOwner }> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let fd: number;
    try {
      fd = fs.openSync(path, 'wx', 0o600);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        throw new AgentStateMissingError(`agent state directory no longer exists: ${dirname(path)}`, { cause: error });
      }
      if (!hasCode(error, 'EEXIST')) {
        throw new MetadataLockError(`failed to acquire metadata lock: ${path}`, { cause: error });
      }

      const observed = parseLockOwner(path, fs);
      if (observed.state === 'missing') continue;
      if (observed.state === 'valid' && !lockOwnerAlive(observed.owner)) {
        // Re-read before unlinking: between the observation and this point another
        // owner may have reclaimed the same stale lock and installed its own. Only
        // the exact stale acquisition we judged dead may be removed.
        const current = parseLockOwner(path, fs);
        if (current.state === 'missing') continue;
        // Content equality is required in addition to acquisition identity. A
        // tokenless record's only identity is its content, so pid/startTicks
        // alone would let a different acquisition sharing them be unlinked.
        if (current.state !== 'valid' || !sameAcquisition(current.owner, observed.owner) || current.raw !== observed.raw) {
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        try {
          fs.unlinkSync(path);
          continue;
        } catch (unlinkError) {
          if (hasCode(unlinkError, 'ENOENT')) continue;
          throw new MetadataLockError(`failed to reclaim stale metadata lock: ${path}`, { cause: unlinkError });
        }
      }
      // A malformed lock can be the tiny create-before-write window of a live
      // owner. Never steal it. If it stays malformed, time out explicitly.
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    const owner: LockOwner = {
      pid: process.pid,
      startTicks: procStartTicks(process.pid),
      token: randomBytes(16).toString('hex'),
    };
    const raw = JSON.stringify(owner);
    try {
      fs.writeFileSync(fd, raw, 'utf8');
      fs.fsyncSync(fd);
      return { fd, raw, owner };
    } catch (error) {
      try { fs.closeSync(fd); } catch {}
      // Only clean up while the path still holds the record this acquisition
      // produced. A delete/re-create cycle during the failed write can leave
      // another owner's live lock here, and a malformed file at the path may be
      // a live owner's create-before-write window, which is indistinguishable
      // from our own partial write. Fail closed on anything but our own
      // acquisition's record; the leftover file is recoverable, a deleted live
      // lock is not.
      const partial = parseLockOwner(path, fs);
      if (partial.state === 'valid' && sameAcquisition(partial.owner, owner)) {
        try { fs.unlinkSync(path); } catch {}
      }
      throw new MetadataLockError(`failed to initialize metadata lock: ${path}`, { cause: error });
    }
  }
  throw new MetadataLockError(`timed out acquiring Antonina metadata lock: ${path}`);
}

function releaseLock(path: string, fd: number, held: LockOwner, raw: string, fs: StoreFs): void {
  try {
    fs.closeSync(fd);
  } catch (error) {
    throw new MetadataLockError(`failed to close metadata lock: ${path}`, { cause: error });
  }
  // Unlink by path is only safe while the path still names this acquisition. The
  // agent directory being deleted and re-created, or another owner reclaiming,
  // can replace the file at this path while we are still inside the critical
  // section; if the replacement belongs to the same still-live process, pid and
  // startTicks alone cannot tell the two acquisitions apart, so compare the
  // acquisition token too and leave a lock we no longer hold in place.
  const current = parseLockOwner(path, fs);
  if (current.state === 'missing') return;
  if (current.state !== 'valid' || !sameAcquisition(current.owner, held) || current.raw !== raw) return;
  try {
    fs.unlinkSync(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw new MetadataLockError(`failed to release metadata lock: ${path}`, { cause: error });
  }
}

export async function withAgentLock<T>(
  agentId: string,
  fn: () => Promise<T> | T,
  options: StatePathsOptions = {},
): Promise<T> {
  const fs = filesystem(options);
  const path = join(agentDir(agentId, options), '.lock');
  const held = await acquireLock(path, fs);
  try {
    return await fn();
  } finally {
    releaseLock(path, held.fd, held.owner, held.raw, fs);
  }
}

export async function updateMeta(
  agentId: string,
  mutate: (meta: AgentMetadata) => void,
  options: StatePathsOptions = {},
): Promise<AgentMetadata | null> {
  try {
    return await withAgentLock(agentId, () => {
      const meta = readMeta(agentId, options);
      if (meta === null) return null;
      mutate(meta);
      writeMeta(agentId, meta, options);
      return meta;
    }, options);
  } catch (error) {
    // Intentional deletion is the one non-error no-op: a late runner may lose
    // the directory race, but it must never recreate deleted authority.
    if (error instanceof AgentStateMissingError) return null;
    throw error;
  }
}

export function createAgentDirectory(agentId: string, options: StatePathsOptions = {}): boolean {
  const fs = filesystem(options);
  const directory = agentDir(agentId, options);
  let created = false;
  try {
    fs.mkdirSync(agentsDir(options), { recursive: true });
    fs.mkdirSync(directory);
    created = true;
    syncDirectory(agentsDir(options), fs);
    return true;
  } catch (error) {
    if (!created && hasCode(error, 'EEXIST')) return false;
    if (created) {
      try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
      } catch (cleanupError) {
        throw new MetadataWriteError(
          `failed to create and clean up state directory for agent ${agentId}`,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    if (error instanceof MetadataWriteError) throw error;
    throw new MetadataWriteError(`failed to create state directory for agent ${agentId}`, { cause: error });
  }
}

export function removeAgentDirectory(agentId: string, options: StatePathsOptions = {}): void {
  const fs = filesystem(options);
  try {
    fs.rmSync(agentDir(agentId, options), {
      recursive: true,
      force: true,
      // A just-converged detached runner may still be closing/unlinking its
      // final files. Retry only the transient recursive-removal races; a
      // persistent filesystem failure still propagates below.
      maxRetries: 5,
      retryDelay: 20,
    });
    syncDirectory(agentsDir(options), fs);
  } catch (error) {
    if (error instanceof MetadataWriteError) throw error;
    throw new MetadataWriteError(`failed to remove state directory for agent ${agentId}`, { cause: error });
  }
}
