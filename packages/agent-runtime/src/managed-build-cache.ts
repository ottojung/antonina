/**
 * Explicitly registered, agent-owned disposable build cache.
 *
 * There is no workspace scan here. An agent that wants a rebuildable target
 * directory opts in through the `antonina agent cache` helper; Antonina creates
 * one dedicated directory at `<state root>/build-cache/<agent id>/target` and
 * writes a marker beside it. Only that exact registered path can ever be
 * retired, and only after the agent record is terminal and unowned, the marker
 * still identifies the same directory inode, no other agent claims it, and a
 * freshly taken process/mount probe finds no live reference.
 *
 * Unique binaries, receipts, source and evidence must live outside this root;
 * the managed directory holds only regenerable compiler output.
 *
 * This is not a capacity policy. It never scans a declared `cwd`, never forces
 * `CARGO_TARGET_DIR` on any project, never refuses or delays a launch, and
 * never infers ownership from a directory name. See docs/intent-records/agent.md.
 */

import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

import {
  activeRunnerFlag,
  deletePendingFlag,
  pendingPrompt,
  TERMINAL_STATES,
  type AgentMetadata,
} from './metadata.js';
import { deriveState, invocationAlive, reservationInFlight } from './lifecycle.js';
import { persistedAgentId } from './process.js';

export const MANAGED_CACHE_SCHEMA = 'antonina.managed-build-cache.v1';
export const MANAGED_CACHE_LEAF = 'target';
export const MANAGED_CACHE_MARKER = 'managed-cache.json';

export class ManagedCacheEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedCacheEvidenceError';
  }
}

export interface ManagedCacheStat {
  readonly dev: number;
  readonly ino: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * Injected filesystem. `lstat` returns null only for a missing path and MUST
 * throw for any other failure; swallowing an EACCES would turn unreadable
 * evidence into a false "nothing there".
 */
export interface ManagedCacheFs {
  mkdir(path: string, mode: number): void;
  lstat(path: string): ManagedCacheStat | null;
  readFile(path: string): string;
  writeFileExclusive(path: string, data: string): void;
  readdir(path: string): string[];
  removeTree(path: string): void;
  /** Remove a plain file or symlink. Missing path may throw. */
  removeFile(path: string): void;
  /** Remove an empty directory. Missing path may throw. */
  rmdir(path: string): void;
  allocatedBytes?(path: string): number;
}

export interface ManagedCacheMarker {
  readonly schema: typeof MANAGED_CACHE_SCHEMA;
  readonly agent_id: string;
  readonly path: string;
  readonly nonce: string;
  readonly created_at: number;
  readonly dev: number;
  readonly ino: number;
}

export interface LiveReferenceResult {
  /** false means the probe itself could not read the evidence: fail closed. */
  readonly ok: boolean;
  readonly reason?: string;
  /** Process cwd/fd targets and mount points, freshly read at deletion time. */
  readonly references: readonly string[];
  /** Processes whose references could not be fully established. */
  readonly unknownProcesses: readonly string[];
}

export interface CacheClaim {
  readonly agentId: string;
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

export interface ClaimsResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly claims: readonly CacheClaim[];
}

export interface RetireManagedCacheResult {
  readonly removed: boolean;
  readonly reason?: string;
  readonly record?: {
    readonly schema: typeof MANAGED_CACHE_SCHEMA;
    readonly status: 'intent' | 'retired';
    readonly agent_id: string;
    readonly path: string;
    readonly nonce: string;
    readonly dev: number;
    readonly ino: number;
    readonly allocated_bytes: number | null;
    readonly utc: string;
  };
}

export interface RetireManagedCacheOptions {
  readonly root: string;
  readonly agentId: string;
  readonly fs: ManagedCacheFs;
  /** The freshly read record, obtained while holding the metadata/ownership lock. */
  readonly meta: AgentMetadata;
  /** Invoked AT deletion time, never captured as a snapshot before the sweep. */
  readonly probeLiveReferences: () => LiveReferenceResult;
  /** Defaults to a fresh listing of the dedicated managed root. */
  readonly listClaims?: () => ClaimsResult;
  /**
   * MUST durably fsync the line before returning. Called once with `intent`
   * before removal, then once with `retired` after successful removal.
   */
  readonly writeManifestLine?: (line: string, phase: 'intent' | 'retired') => void;
  readonly now?: () => number;
}

/** The one dedicated root Antonina owns. Not derived from any agent's cwd. */
export function managedCacheRoot(stateRootPath: string): string {
  return join(stateRootPath, 'build-cache');
}

export function managedCacheDir(root: string, agentId: string): string {
  return join(root, agentIdRequired(agentId));
}

export function managedCachePath(root: string, agentId: string): string {
  return join(managedCacheDir(root, agentId), MANAGED_CACHE_LEAF);
}

export function managedCacheMarkerPath(root: string, agentId: string): string {
  return join(managedCacheDir(root, agentId), MANAGED_CACHE_MARKER);
}

function agentIdRequired(agentId: string): string {
  if (persistedAgentId(agentId) !== agentId) {
    throw new ManagedCacheEvidenceError('managed build cache agent id is malformed');
  }
  return agentId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameMarker(a: ManagedCacheMarker, b: ManagedCacheMarker): boolean {
  return a.schema === b.schema
    && a.agent_id === b.agent_id
    && a.path === b.path
    && a.nonce === b.nonce
    && a.created_at === b.created_at
    && a.dev === b.dev
    && a.ino === b.ino;
}

function parseMarker(raw: string, expectedPath: string, expectedAgent: string): ManagedCacheMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ManagedCacheEvidenceError('managed cache marker is not valid JSON', { cause: error });
  }
  if (!isRecord(value)
    || value.schema !== MANAGED_CACHE_SCHEMA
    || value.agent_id !== expectedAgent
    || value.path !== expectedPath
    || typeof value.nonce !== 'string'
    || value.nonce.length === 0
    || !Number.isSafeInteger(value.created_at)
    || !Number.isSafeInteger(value.dev)
    || !Number.isSafeInteger(value.ino)) {
    throw new ManagedCacheEvidenceError('managed cache marker does not match its registered agent and path');
  }
  return value as unknown as ManagedCacheMarker;
}

function assertPlainDirectory(stat: ManagedCacheStat | null, path: string): asserts stat is ManagedCacheStat {
  if (stat === null || !stat.isDirectory || stat.isSymbolicLink || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) {
    throw new ManagedCacheEvidenceError(`managed cache path is missing, not a plain directory, or has unreadable identity: ${path}`);
  }
}

function assertOwnedDirectory(fs: ManagedCacheFs, path: string): ManagedCacheStat {
  const stat = fs.lstat(path);
  assertPlainDirectory(stat, path);
  return stat;
}

/**
 * Verify every ancestor component is a plain directory. `lstat` on the final
 * path alone is not enough: an intermediate symlink would be followed by any
 * lookup below it, which could redirect the managed root (or a cleanup) into a
 * directory Antonina does not own.
 */
function assertPlainAncestorChain(fs: ManagedCacheFs, path: string): void {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter((part) => part.length > 0);
  let current = absolute.startsWith(sep) ? sep : '';
  for (const part of parts) {
    current = current === sep ? sep + part : (current.length > 0 ? current + sep + part : part);
    assertPlainDirectory(fs.lstat(current), current);
  }
}

/**
 * Opt-in creation of the dedicated cache directory plus its identity marker.
 * Idempotent for the identical marker; any mismatch is an error rather than an
 * overwrite, so a stale or foreign directory can never be adopted silently.
 * A preexisting unmarked target is never adopted - its owner is unknown.
 */
export function initializeManagedCache(
  root: string,
  agentId: string,
  fs: ManagedCacheFs,
  now: () => number = Date.now,
): { path: string; marker: ManagedCacheMarker } {
  const id = agentIdRequired(agentId);
  const dir = managedCacheDir(root, id);
  const path = managedCachePath(root, id);
  const markerPath = managedCacheMarkerPath(root, id);

  // Validate ancestors BEFORE mkdir: a recursive mkdir would happily follow a
  // symlinked ancestor. Then re-validate the whole chain including the new root.
  assertPlainAncestorChain(fs, dirname(root));
  fs.mkdir(root, 0o700);
  assertPlainAncestorChain(fs, root);

  // Refuse symlinked agent dir before creating anything inside it.
  const preDir = fs.lstat(dir);
  if (preDir !== null && (preDir.isSymbolicLink || !preDir.isDirectory)) {
    throw new ManagedCacheEvidenceError('managed cache agent directory is not a plain directory');
  }
  fs.mkdir(dir, 0o700);
  assertOwnedDirectory(fs, dir);

  const preTarget = fs.lstat(path);
  const preMarker = fs.lstat(markerPath);

  // Never adopt a preexisting unmarked target: we cannot prove it was created
  // by this registration and it may contain non-disposable data.
  if (preMarker === null && preTarget !== null) {
    throw new ManagedCacheEvidenceError('preexisting unmarked managed cache target cannot be adopted');
  }

  if (preTarget !== null && (preTarget.isSymbolicLink || !preTarget.isDirectory)) {
    throw new ManagedCacheEvidenceError('managed cache target is not a plain directory');
  }
  if (preTarget === null) fs.mkdir(path, 0o700);
  const targetStat = assertOwnedDirectory(fs, path);

  const existing = fs.lstat(markerPath);
  if (existing !== null) {
    if (!existing.isFile || existing.isSymbolicLink) {
      throw new ManagedCacheEvidenceError('managed cache marker is not a plain file');
    }
    const marker = parseMarker(fs.readFile(markerPath), path, id);
    if (marker.dev !== targetStat.dev || marker.ino !== targetStat.ino) {
      // If the target did not exist before this call, we just created a fresh
      // directory and found a stale marker from a prior retired cache. The old
      // inode is gone; remove the stale marker so a later init can proceed.
      // If the target pre-existed, this is an inode mismatch - fail closed.
      if (preTarget !== null) {
        throw new ManagedCacheEvidenceError('managed cache marker identity does not match its directory inode');
      }
      fs.removeFile(markerPath);
      // Fall through to write a fresh marker for the newly created target.
    } else {
      return { path, marker };
    }
  }

  // Marker missing (or just removed as stale). Target is the directory we own:
  // either it pre-existed with a matching marker (handled above) or it was just
  // created by us in this call.
  const marker: ManagedCacheMarker = {
    schema: MANAGED_CACHE_SCHEMA,
    agent_id: id,
    path,
    nonce: randomUUID(),
    created_at: now(),
    dev: targetStat.dev,
    ino: targetStat.ino,
  };
  try {
    fs.writeFileExclusive(markerPath, JSON.stringify(marker));
  } catch (error) {
    const raced = fs.lstat(markerPath);
    if (raced === null || !raced.isFile || raced.isSymbolicLink) throw error;
    const winner = parseMarker(fs.readFile(markerPath), path, id);
    if (winner.dev !== targetStat.dev || winner.ino !== targetStat.ino) {
      throw new ManagedCacheEvidenceError('managed cache marker identity does not match its directory inode', { cause: error });
    }
    if (!sameMarker(winner, marker)) {
      throw new ManagedCacheEvidenceError('managed cache marker changed during initialization', { cause: error });
    }
  }
  const confirmed = parseMarker(fs.readFile(markerPath), path, id);
  if (confirmed.dev !== targetStat.dev || confirmed.ino !== targetStat.ino) {
    throw new ManagedCacheEvidenceError('managed cache marker identity does not match its directory inode');
  }
  return { path, marker: confirmed };
}

/** Re-read and fully validate the registration. Any unreadable piece throws. */
export function readManagedCache(
  root: string,
  agentId: string,
  fs: ManagedCacheFs,
): { path: string; marker: ManagedCacheMarker; stat: ManagedCacheStat } {
  const id = agentIdRequired(agentId);
  assertPlainAncestorChain(fs, root);
  const dir = managedCacheDir(root, id);
  const dirStat = fs.lstat(dir);
  assertPlainDirectory(dirStat, dir);
  const path = managedCachePath(root, id);
  const markerPath = managedCacheMarkerPath(root, id);
  const markerStat = fs.lstat(markerPath);
  if (markerStat === null || !markerStat.isFile || markerStat.isSymbolicLink) {
    throw new ManagedCacheEvidenceError(`managed cache marker is missing or not a plain file: ${markerPath}`);
  }
  const marker = parseMarker(fs.readFile(markerPath), path, id);
  const stat = fs.lstat(path);
  assertPlainDirectory(stat, path);
  if (stat.dev !== marker.dev || stat.ino !== marker.ino) {
    throw new ManagedCacheEvidenceError('managed cache directory inode changed since registration');
  }
  return { path, marker, stat };
}

function staleRetiredMarker(root: string, agentId: string, fs: ManagedCacheFs): ManagedCacheMarker | null {
  const id = agentIdRequired(agentId);
  // This fallback runs after readManagedCache rejected evidence. It must not
  // follow a symlinked root/ancestor to "clean up" a foreign directory.
  assertPlainAncestorChain(fs, root);
  const dir = managedCacheDir(root, id);
  const dirStat = fs.lstat(dir);
  if (dirStat === null) return null;
  if (dirStat.isSymbolicLink || !dirStat.isDirectory) return null;
  const markerPath = managedCacheMarkerPath(root, id);
  const markerStat = fs.lstat(markerPath);
  if (markerStat === null || !markerStat.isFile || markerStat.isSymbolicLink) return null;
  let marker: ManagedCacheMarker;
  try {
    marker = parseMarker(fs.readFile(markerPath), managedCachePath(root, id), id);
  } catch {
    return null;
  }
  const targetStat = fs.lstat(managedCachePath(root, id));
  if (targetStat !== null) return null; // target exists - not a stale-retired residue
  return marker;
}

function cleanupStaleMarker(root: string, agentId: string, fs: ManagedCacheFs, marker: ManagedCacheMarker): void {
  const markerPath = managedCacheMarkerPath(root, agentId);
  const dir = managedCacheDir(root, agentId);
  try {
    const markerStat = fs.lstat(markerPath);
    if (markerStat !== null && markerStat.isFile && !markerStat.isSymbolicLink) {
      const current = parseMarker(fs.readFile(markerPath), marker.path, agentId);
      if (sameMarker(current, marker)) fs.removeFile(markerPath);
    }
  } catch {
    // Best-effort: listing already tolerates missing-target stale markers.
  }
  try {
    const remaining = fs.readdir(dir);
    if (remaining.length === 0) fs.rmdir(dir);
  } catch {
    // Best-effort.
  }
}

/** Best-effort cleanup of a valid marker left behind after prior retirement. */
export function cleanupStaleManagedCache(root: string, agentId: string, fs: ManagedCacheFs): boolean {
  try {
    const stale = staleRetiredMarker(root, agentId, fs);
    if (stale === null) return false;
    cleanupStaleMarker(root, agentId, fs, stale);
    return true;
  } catch {
    return false;
  }
}

export interface ManagedCacheRegistrationStatus {
  readonly registered: boolean;
  /** A valid marker for an already-gone target; cleanup was attempted. */
  readonly stale?: boolean;
  /** Present but unreadable evidence: the owner must be preserved, fail closed. */
  readonly ambiguous?: boolean;
  readonly reason?: string;
}

/**
 * Answer whether an agent still has a registered (or ambiguous) managed cache.
 * Used before an owner record is deleted so `clean`/`delete` can never orphan
 * retryable cache state. Any unreadable or non-plain evidence is ambiguous and
 * keeps the owner record.
 */
export function hasManagedCacheRegistration(
  root: string,
  agentId: string,
  fs: ManagedCacheFs,
): ManagedCacheRegistrationStatus {
  try {
    readManagedCache(root, agentId, fs);
    return { registered: true };
  } catch {
    if (cleanupStaleManagedCache(root, agentId, fs)) return { registered: false, stale: true };
    try {
      assertPlainAncestorChain(fs, dirname(root));
      const rootStat = fs.lstat(root);
      if (rootStat === null) return { registered: false };
      if (rootStat.isSymbolicLink || !rootStat.isDirectory) {
        return { registered: false, ambiguous: true, reason: 'managed cache root is not a plain directory' };
      }
      const dir = managedCacheDir(root, agentId);
      const dirStat = fs.lstat(dir);
      if (dirStat === null) return { registered: false };
      if (dirStat.isSymbolicLink || !dirStat.isDirectory) {
        return { registered: false, ambiguous: true, reason: 'managed cache agent directory is not a plain directory' };
      }
      const markerPath = managedCacheMarkerPath(root, agentId);
      const markerStat = fs.lstat(markerPath);
      if (markerStat !== null) {
        if (!markerStat.isFile || markerStat.isSymbolicLink) {
          return { registered: false, ambiguous: true, reason: 'managed cache marker is not a plain file' };
        }
        return { registered: false, ambiguous: true, reason: 'managed cache marker is unreadable' };
      }
      if (fs.lstat(managedCachePath(root, agentId)) !== null) {
        return { registered: false, ambiguous: true, reason: 'unmarked managed cache target present' };
      }
      return { registered: false };
    } catch (error) {
      return {
        registered: false,
        ambiguous: true,
        reason: 'managed cache evidence unreadable: ' + (error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

/** List registrations under the dedicated root only. No cwd is ever consulted. */
export function listManagedCacheClaims(root: string, fs: ManagedCacheFs): ClaimsResult {
  try {
    assertPlainAncestorChain(fs, dirname(root));
  } catch (error) {
    return { ok: false, reason: 'managed cache ancestor unreadable or not a plain directory: ' + (error instanceof Error ? error.message : String(error)), claims: [] };
  }
  const rootStat = fs.lstat(root);
  if (rootStat === null) return { ok: true, claims: [] };
  if (rootStat.isSymbolicLink || !rootStat.isDirectory) {
    return { ok: false, reason: 'managed cache root is not a plain directory: ' + root, claims: [] };
  }
  const claims: CacheClaim[] = [];
  let entries: string[];
  try {
    entries = fs.readdir(root);
  } catch (error) {
    return { ok: false, reason: 'managed cache root unreadable: ' + (error instanceof Error ? error.message : String(error)), claims: [] };
  }
  for (const entry of entries) {
    if (persistedAgentId(entry) !== entry) continue;
    const dir = managedCacheDir(root, entry);
    let dirStat: ManagedCacheStat | null;
    try {
      dirStat = fs.lstat(dir);
    } catch {
      return { ok: false, reason: 'managed cache agent directory unreadable: ' + dir, claims: [] };
    }
    if (dirStat === null) continue;
    if (dirStat.isSymbolicLink || !dirStat.isDirectory) {
      return { ok: false, reason: 'managed cache agent directory is not a plain directory: ' + dir, claims: [] };
    }
    const markerPath = managedCacheMarkerPath(root, entry);
    let markerStat: ManagedCacheStat | null;
    try {
      markerStat = fs.lstat(markerPath);
    } catch {
      return { ok: false, reason: 'managed cache marker unreadable: ' + markerPath, claims: [] };
    }
    if (markerStat === null) continue;
    let marker: ManagedCacheMarker;
    try {
      marker = parseMarker(fs.readFile(markerPath), managedCachePath(root, entry), entry);
    } catch (error) {
      return { ok: false, reason: 'managed cache evidence unreadable for ' + entry + ': ' + (error instanceof Error ? error.message : String(error)), claims: [] };
    }
    let stat: ManagedCacheStat | null;
    try {
      stat = fs.lstat(managedCachePath(root, entry));
    } catch (error) {
      return { ok: false, reason: 'managed cache target unreadable for ' + entry + ': ' + (error instanceof Error ? error.message : String(error)), claims: [] };
    }
    if (stat === null) {
      // Stale marker left behind after a successful target removal. It names no
      // live target, so it cannot claim the cache; ignore it so later claims and
      // retirements are not blocked.
      continue;
    }
    try {
      assertPlainDirectory(stat, managedCachePath(root, entry));
    } catch (error) {
      return { ok: false, reason: 'managed cache evidence unreadable for ' + entry + ': ' + (error instanceof Error ? error.message : String(error)), claims: [] };
    }
    if (stat.dev !== marker.dev || stat.ino !== marker.ino) {
      return { ok: false, reason: 'managed cache marker inode mismatch for ' + entry, claims: [] };
    }
    claims.push({ agentId: entry, path: marker.path, dev: marker.dev, ino: marker.ino });
  }
  return { ok: true, claims };
}

/** Return a reason when a freshly probed reference touches the cache path. */
export function liveReferenceReason(path: string, probe: LiveReferenceResult): string | null {
  if (!probe.ok) return probe.reason ?? 'live-reference probe unreadable';
  if (probe.unknownProcesses.length > 0) {
    return 'unknown process reference: ' + probe.unknownProcesses.join(', ');
  }
  const touched = probe.references.filter((reference) => reference === path || reference.startsWith(path + '/'));
  return touched.length > 0 ? 'live process or mount reference: ' + touched[0] : null;
}

/** Re-check the terminal/ownership verdict from the actual record under lock. */
function ownerVerdict(meta: AgentMetadata): string | null {
  if (!(TERMINAL_STATES as readonly string[]).includes(deriveState(meta))) return 'owner is not terminal';
  try {
    if (pendingPrompt(meta) !== null) return 'owner still has an accepted prompt';
  } catch {
    return 'owner prompt state unreadable';
  }
  if (invocationAlive(meta)) return 'owner invocation is alive';
  if (activeRunnerFlag(meta) !== false) return 'owner runner is active or unknown';
  if (reservationInFlight(meta)) return 'owner runner reservation is in flight';
  if (deletePendingFlag(meta) !== false) return 'owner deletion is pending or unknown';
  return null;
}

function refuse(reason: string): RetireManagedCacheResult {
  return { removed: false, reason };
}

/**
 * Retire the one registered cache for a terminal, unowned agent. Every piece of
 * evidence is re-read at deletion time: owner record, marker/inode, claims, and
 * live references. Any unreadable or unknown datum blocks removal.
 */
export function retireManagedCache(options: RetireManagedCacheOptions): RetireManagedCacheResult {
  try {
    agentIdRequired(options.agentId);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  if (options.meta.id !== options.agentId) return refuse('record does not belong to this cache owner');

  const ownerIssue = ownerVerdict(options.meta);
  if (ownerIssue !== null) return refuse('owner guard: ' + ownerIssue);

  let registration: ReturnType<typeof readManagedCache>;
  try {
    registration = readManagedCache(options.root, options.agentId, options.fs);
  } catch (error) {
    // A stale marker whose target is already gone is a post-retirement residue.
    // Clean it up so later claims are not blocked.
    try {
      const stale = staleRetiredMarker(options.root, options.agentId, options.fs);
      if (stale !== null) {
        cleanupStaleMarker(options.root, options.agentId, options.fs, stale);
        return { removed: true, reason: 'stale marker cleaned after prior retirement' };
      }
    } catch {
      // Fall through to refuse with the original evidence error.
    }
    return refuse('cache evidence unreadable: ' + (error instanceof Error ? error.message : String(error)));
  }

  const claims = options.listClaims ? options.listClaims() : listManagedCacheClaims(options.root, options.fs);
  if (!claims.ok) return refuse('shared-cache evidence unreadable: ' + (claims.reason ?? 'unknown'));
  const shared = claims.claims.find((claim) =>
    claim.agentId !== options.agentId
    && (claim.path === registration.path || (claim.dev === registration.stat.dev && claim.ino === registration.stat.ino)));
  if (shared !== undefined) return refuse('cache also claimed by agent ' + shared.agentId);

  // Fresh at this point in time: never a snapshot taken during enumeration.
  const referenceIssue = liveReferenceReason(registration.path, options.probeLiveReferences());
  if (referenceIssue !== null) return refuse(referenceIssue);

  // Account for the bytes before removal; after removal the path is gone. The
  // scan walks the tree, so identity and live references are re-checked right
  // after it, immediately before deletion.
  let allocatedBytes: number | null;
  try {
    allocatedBytes = options.fs.allocatedBytes?.(registration.path) ?? null;
  } catch (error) {
    return refuse('allocated scan failed: ' + (error instanceof Error ? error.message : String(error)));
  }

  let beforeRemoval: ReturnType<typeof readManagedCache>;
  try {
    beforeRemoval = readManagedCache(options.root, options.agentId, options.fs);
  } catch (error) {
    return refuse('cache changed before deletion: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (!sameMarker(beforeRemoval.marker, registration.marker)) {
    return refuse('marker changed between verification and deletion');
  }
  const finalReferenceIssue = liveReferenceReason(registration.path, options.probeLiveReferences());
  if (finalReferenceIssue !== null) return refuse(finalReferenceIssue + ' (final check)');

  const baseRecord = {
    schema: MANAGED_CACHE_SCHEMA,
    agent_id: options.agentId,
    path: registration.path,
    nonce: registration.marker.nonce,
    dev: registration.stat.dev,
    ino: registration.stat.ino,
    allocated_bytes: allocatedBytes,
    utc: new Date((options.now ?? Date.now)()).toISOString(),
  } as const;
  const intentRecord: RetireManagedCacheResult['record'] = { ...baseRecord, status: 'intent' };
  // Durable pre-removal manifest: the callback MUST fsync before returning, so
  // a crash or removal failure leaves evidence and retryable target+marker.
  try {
    options.writeManifestLine?.(JSON.stringify(intentRecord), 'intent');
  } catch (error) {
    return refuse('manifest write failed: ' + (error instanceof Error ? error.message : String(error)));
  }

  try {
    options.fs.removeTree(registration.path);
  } catch (error) {
    return refuse('removal failed: ' + (error instanceof Error ? error.message : String(error)));
  }

  // Distinct completion record, also fsynced, so an intent line is not mistaken
  // for a completed retirement after a crash.
  const completionRecord: RetireManagedCacheResult['record'] = { ...baseRecord, status: 'retired' };
  let completionError: string | null = null;
  try {
    options.writeManifestLine?.(JSON.stringify(completionRecord), 'retired');
  } catch (error) {
    completionError = 'completion manifest write failed: ' + (error instanceof Error ? error.message : String(error));
  }

  // Clean up marker and empty agent dir so stale markers cannot block later
  // claims or retirements. The target is already gone and the manifest records it;
  // marker cleanup failure is reported but the cache itself is retired.
  const markerPath = managedCacheMarkerPath(options.root, options.agentId);
  const dir = managedCacheDir(options.root, options.agentId);
  try {
    const markerStat = options.fs.lstat(markerPath);
    if (markerStat !== null && markerStat.isFile && !markerStat.isSymbolicLink) {
      const current = parseMarker(options.fs.readFile(markerPath), registration.path, options.agentId);
      if (sameMarker(current, registration.marker)) options.fs.removeFile(markerPath);
    }
  } catch (error) {
    return {
      removed: true,
      record: completionRecord,
      reason: 'cache removed but marker cleanup failed: ' + (error instanceof Error ? error.message : String(error)),
    };
  }
  try {
    const remaining = options.fs.readdir(dir);
    if (remaining.length === 0) options.fs.rmdir(dir);
  } catch {
    // Best-effort: empty dir cleanup is not required for correctness.
  }

  return { removed: true, record: completionRecord, ...(completionError === null ? {} : { reason: completionError }) };
}
