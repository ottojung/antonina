import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { persistedOpencodeDbKey, validateAgentMetadata, type AgentMetadata } from './metadata.js';
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

/**
 * Board 186. Where the per-agent OpenCode databases live.
 *
 * A sibling of `agents/`, not a directory inside an agent's own: a fork's clone
 * deliberately keeps using the *source's* database (see `forkMetaSnapshot`, which
 * carries `opencode_db` verbatim because the clone also carries the source's
 * `native_session_id`), so the file has to outlive the deletion of any single
 * agent record and cannot live inside one agent's directory.
 */
export function opencodeDbDir(options: StatePathsOptions = {}): string {
  return join(stateRoot(options), 'opencode');
}

export function opencodeDbPath(key: string, options: StatePathsOptions = {}): string {
  if (persistedAgentId(key) !== key) throw new Error('opencode database key is malformed');
  return join(opencodeDbDir(options), `${key}.db`);
}

/**
 * Creates the database directory if it is missing.
 *
 * This is not optional politeness: OpenCode 1.18.32 opens `OPENCODE_DB` with
 * `unable to open database file` when the parent directory does not exist, so a
 * runtime that only names the path produces a backend that dies before it can be
 * classified. Measured, not assumed (see BOARD186-ISOLATION.md).
 *
 * Mode 0700: the database holds the operator's conversation history and message
 * bodies, and it sits under the state root for the same reason `agents/` does.
 *
 * The real filesystem is used rather than the injected `StoreFs` seam, for the
 * same reason `logSize` uses it: these files are written by the backend process
 * itself, so no test-owned `fs` owns those bytes. The directory this creates is
 * Antonina's own, though, so it is best effort: a failure here is reported by the
 * backend as `unable to open database file`, and turning it into an exception here
 * would change which failure a caller sees without preventing either.
 */
export function ensureOpencodeDbDir(options: StatePathsOptions = {}): void {
  try {
    nodeFs.mkdirSync(opencodeDbDir(options), { recursive: true, mode: 0o700 });
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return;
    throw new MetadataWriteError('failed to create the OpenCode database directory', { cause: error });
  }
}

/**
 * The environment fragment that confines an agent's OpenCode invocations to its own
 * database: `{ OPENCODE_DB: <state>/antonina/opencode/<key>.db }`, or an empty object
 * for a record that has no dedicated database and therefore keeps the shared one.
 *
 * Callers must spread this *after* their own environment, so the value is decided
 * here rather than inherited: an ambient `OPENCODE_DB` must not silently decide
 * which database a managed front writes to. That is also why the unkeyed case
 * returns an explicit `undefined` rather than an empty fragment -- `undefined`
 * removes the variable from the child's environment (Node's child_process drops
 * undefined-valued env pairs for both `spawn` and `spawnSync`), whereas `{}`
 * would leave an ambient `OPENCODE_DB` in place and hand the operator's shell a
 * say in which database a managed front writes to.
 */
export function opencodeBackendEnv(
  meta: AgentMetadata,
  options: StatePathsOptions = {},
): Record<string, string | undefined> {
  const key = persistedOpencodeDbKey(meta);
  if (key === null) return { OPENCODE_DB: undefined };
  ensureOpencodeDbDir(options);
  return { OPENCODE_DB: opencodeDbPath(key, options) };
}

/**
 * The answer to "is this OpenCode database key still named by some OTHER agent
 * record?", together with whether that answer could be established at all.
 *
 * `complete` is the part that matters. A key set that could not be read is not
 * evidence of absence; it is the absence of evidence, and this path uses it to
 * decide whether to unlink a conversation.
 */
export interface OpencodeDbInventory {
  /** Keys named by a record that was actually read. */
  keys: Set<string>;
  /**
   * Whether every agent record that could name a key was actually read.
   *
   * `false` when the agents state root could not be enumerated for any reason
   * other than its absence, or when any record in it could not be read. When it
   * is `false`, `keys` is a lower bound: the true set is a superset of it.
   */
  complete: boolean;
}

/**
 * Board 198 R3. The keys of dedicated databases still named by an agent record
 * other than `exceptAgentId`, and whether that inventory was successfully read.
 *
 * Used to decide whether deleting one record may delete a database file. A fork
 * pair shares one database on purpose (see `opencodeDbDir`), and deleting the
 * source must not take the conversation out from under the clone that is still
 * continuing it. This is therefore a *destructive* query: the answer licenses an
 * unlink, so the only safe answer to "I could not read" is "keep the file".
 *
 * THE PREDICATE, stated once:
 *
 *   a key is in use iff some record other than `exceptAgentId`, whose directory
 *   was enumerated and whose `meta.json` was read without error, names it -- and
 *   the inventory is complete iff the root was either absent or enumerated in
 *   full and every well-formed agent record under it was read without error.
 *
 * `removeOpencodeDatabase` unlinks only when `complete` is true *and* the key is
 * absent from `keys`. Each half is load-bearing:
 *
 *   - The root could not be enumerated (`EACCES`, `ENOTDIR`, `EIO`, ...): not
 *     complete. The key might be named by a record nobody managed to list.
 *   - A record's `meta.json` could not be read, is missing, or does not
 *     validate: not complete. It might name this key. Note this is the whole
 *     point -- `readMeta` refuses a record it cannot fully validate rather than
 *     guessing, and this function must not turn that refusal into permission to
 *     delete. The a518fb86 per-record isolation is *reporting* isolation for the
 *     inventory commands; here the same record has to be a reason to stop, not a
 *     reason to proceed.
 *   - The root is absent (`ENOENT`): complete, and empty. Absence is the one
 *     shape in which no record exists that could name the key, so it is the one
 *     unreadable-looking state that still permits deletion. It is deliberately
 *     NOT collapsed with the denied case above: "this machine has no agents
 *     directory" and "this machine will not let me read its agents directory"
 *     are different facts and the previous code answered both as "keep nothing".
 *   - A readable record that names a different key, or names none at all: it
 *     does not block deletion, and it does not spoil completeness.
 *   - A directory whose name is not a well-formed agent id: skipped, and
 *     completeness is unaffected. Such a directory cannot be a record -- ids are
 *     canonical hex by `persistedAgentId`, and `writeMeta` cannot have produced
 *     anything else -- so it cannot name a key, and treating it as an
 *     unreadable record would make a stray `agents/scratch/` keep every database
 *     on the machine forever.
 *
 * THE ACCEPTED COST, honestly: a machine whose agents root has been removed out
 * of band (or that has never had one) is reported as an empty inventory, so a
 * database file left behind by that removal is still deleted on the next
 * `delete`. That is the residual of permitting deletion without a successful
 * enumeration, and it is the cost that makes a never-used installation work at
 * all. Everything that is present-but-unreadable -- which is the case that
 * actually loses a conversation -- keeps the file. The other cost is a
 * permanently stuck database: one unreadable sibling record anywhere in the root
 * keeps *every* database alive, with no command that clears it, because the
 * fix for that is an operator repairing their own state, not Antonina
 * deleting on a weaker question.
 *
 * Read through the real filesystem, like `logSize` and the other opencode-db
 * helpers: this enumerates the operator's durable state root, and the injected
 * `StoreFs` seam covers only the per-record read/write path.
 */
export function opencodeDbKeysInUse(
  exceptAgentId: string,
  options: StatePathsOptions = {},
): OpencodeDbInventory {
  const keys = new Set<string>();
  let entries: string[];
  try {
    entries = nodeFs.readdirSync(agentsDir(options), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    // Absent means empty -- nothing exists that could name a key. Any other
    // refusal means the enumeration itself failed, and the key set below would
    // be a guess. ENOENT is the only code that licenses an empty answer.
    return { keys, complete: hasCode(error, 'ENOENT') };
  }
  let complete = true;
  for (const agentId of entries) {
    if (agentId === exceptAgentId || persistedAgentId(agentId) !== agentId) continue;
    let meta: AgentMetadata | null;
    try {
      meta = readMeta(agentId, options);
    } catch {
      // This record might name the key. Refusing to know must not read as
      // permission to delete; it only stops the inventory from being complete.
      complete = false;
      continue;
    }
    if (meta === null) {
      // The directory vanished between the enumeration and the read. There is
      // no record left to name the key, but the run did not observe that.
      complete = false;
      continue;
    }
    const key = persistedOpencodeDbKey(meta);
    if (key !== null) keys.add(key);
  }
  return { keys, complete };
}

/**
 * Removes a dedicated OpenCode database and its WAL/SHM siblings, but only when
 * the inventory of records naming that key was read successfully AND it does not
 * name the key. Best effort by construction: an operator's `delete` must not
 * fail because a backend's database file is unremovable, and a leftover file is
 * inert garbage, not a correctness problem.
 *
 * Board 198 R3: "the inventory could not be read" and "the inventory was read and
 * does not name this key" are now different answers, and only the second one
 * unlinks. The previous `opencodeDbKeysInUse('').has(key)` guard was false
 * whenever the agents root could not be enumerated or a sibling record could not
 * be read -- an unreadable inventory reading as an empty one -- so a fork pair's
 * shared conversation was destroyed by a `delete` that was told nothing about
 * the clone still continuing it. A refused inventory now leaves the file in
 * place, silently, exactly as an in-use key already did: the leftover is the
 * report, and the operator finds an unreadable record through `agent list`,
 * which names it (see `opencodeDbKeysInUse` for the full predicate and its
 * accepted costs).
 *
 * What the inventory read does NOT establish, and must not be described as
 * establishing: no record names this key at the end of the unlink. The read and
 * the `rmSync` below are two acts, no lock is held across them, and a record
 * published inside that interval naming this key is not seen. POSIX offers no
 * compare-and-unlink, so the interval is not closable with ordinary Node/POSIX;
 * it is stated in docs/intent-records/agent.md ("Collecting a shared
 * conversation database reads then unlinks, and the interval is stated") rather
 * than traded for a longer unstated one, the same standard hosts.md applies to
 * the stale-lock reclaim window.
 */
export function removeOpencodeDatabase(key: string, options: StatePathsOptions = {}): void {
  if (persistedAgentId(key) !== key) return;
  const inventory = opencodeDbKeysInUse('', options);
  if (!inventory.complete || inventory.keys.has(key)) return;
  const path = opencodeDbPath(key, options);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      nodeFs.rmSync(`${path}${suffix}`, { force: true, maxRetries: 5, retryDelay: 20 });
    } catch {}
  }
}

/**
 * How many bytes of `output.log` already exist, which is the byte offset the
 * next append-only write to it starts at. An absent log is zero bytes, not an
 * error: a front that has never produced output has a log cursor of zero and a
 * log that is created at that offset by its first write.
 *
 * This reads the real filesystem rather than the injected `StoreFs`, because the
 * log is written by the backend process itself, never through the store, and no
 * test-owned `fs` seam owns those bytes. That also means the value can be stale
 * the instant it is returned; a caller uses it as a lower bound describing
 * history, never as a claim that it has read anything.
 */
export function logSize(agentId: string, options: StatePathsOptions = {}): number {
  try {
    return nodeFs.statSync(logPath(agentId, options)).size;
  } catch {
    return 0;
  }
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
  let created = false;
  try {
    // The directory must already exist. Never recreate it here: a missing
    // directory means deletion won the race and durable authority is gone.
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
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
    // Only remove the temporary path if this call created it. The exclusive
    // create refuses to adopt a path that already exists, and a path we did not
    // create is somebody else's file, not our authority to delete.
    if (created) {
      try { fs.unlinkSync(temporary); } catch {}
    }
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
  } catch (error) {
    // Only ESRCH proves the owner is gone. Any other failure (EPERM for a live
    // owner under a different uid, EINTR, an injected error) has not established
    // death, and treating it as death would let this process unlink a live
    // owner's lock and enter the critical section alongside it.
    if (hasCode(error, 'ESRCH')) return false;
    return true;
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
  // Read the record BEFORE the removal below: once the directory is gone the key
  // is undiscoverable, so reading after would answer `null` and silently leave
  // every database this change introduces behind as garbage.
  let doomedKey: string | null = null;
  try {
    const doomed = readMeta(agentId, options);
    if (doomed !== null) doomedKey = persistedOpencodeDbKey(doomed);
  } catch {}
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
  // The record is gone, so its key is no longer discoverable and the database it
  // named is now unreferenced garbage under the state root. The key was captured
  // above; the file is removed here, so the "is another record still using this
  // key" question is asked about the records that actually remain.
  //
  // This lives here rather than at each deletion call site so that `cmdDelete`,
  // the retention sweep and the rollback of a failed `new`/`fork` cannot each
  // decide differently. `removeOpencodeDatabase` re-reads every remaining
  // record and declines when one of them names the same key at the instant of
  // that read; it does not claim no record names it, because the unlink that
  // follows the read is a separate act and a clone published between the two is
  // not observed. That residual interval is a property of the primitives rather
  // than of this code -- POSIX offers no compare-and-unlink and no lock is held
  // across the read -- and it is stated rather than traded for a longer unstated
  // one, in the same register as the stale-lock reclaim window in
  // docs/intent-records/hosts.md and in the collection-window record in
  // docs/intent-records/agent.md. Separately, this is best effort: a leftover
  // file is inert, and an operator's `delete` must not fail over it.
  if (doomedKey !== null) {
    try {
      removeOpencodeDatabase(doomedKey, options);
    } catch {}
  }
}
