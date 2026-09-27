import { procStartTicks, type SignalSender } from '../../agent-runtime/src/process.js';
import { DEFAULT_DAEMON_FS, hasCode, type DaemonFs } from './fs.js';
import type { DaemonPaths } from './identity.js';

/**
 * One daemon per host.
 *
 * Two daemons publishing into one report file would alternate heartbeats and
 * make a live host read as unreliable, so a daemon takes an exclusive lock and
 * refuses to start while a live one holds it.
 *
 * Ownership is judged the way every other process judgment in Antonina is judged:
 * by pid *and* the process's start time, followed by a signal-0 liveness check.
 * A process name is never consulted, because a name is chosen by whatever
 * started the program and a recycled pid can carry any name at all. The start
 * time is what makes the pid mean something: a pid alone is a claim about a
 * process that may not exist, and a pid plus its start time names one.
 *
 * The residual race is stated rather than hidden: between re-reading the lock
 * and unlinking it, another starter can in principle install its own live lock.
 * POSIX has no compare-and-unlink, so the window is narrowed and re-checked but
 * not closed -- the same honest boundary the stale-lock reclaim in
 * `docs/intent-records/hosts.md` records.
 */

export interface DaemonLockRecord {
  readonly hostId: string;
  readonly pid: number;
  readonly startTicks: number;
  readonly acquiredAt: string;
}

export type LockHoldVerdict =
  | { readonly heldBy: DaemonLockRecord; readonly reason: string }
  | { readonly heldBy: null; readonly reason: string };

export interface DaemonLockFsOptions {
  paths: DaemonPaths;
  fs?: DaemonFs;
}

export interface LockProbeOptions extends DaemonLockFsOptions {
  procRoot?: string;
  signal?: SignalSender;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDaemonLockRecord(value: unknown): DaemonLockRecord | null {
  if (!isRecord(value)) return null;
  const { hostId, pid, startTicks, acquiredAt } = value;
  if (typeof hostId !== 'string' || hostId.length === 0) return null;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  if (!Number.isSafeInteger(startTicks) || (startTicks as number) <= 0) return null;
  if (typeof acquiredAt !== 'string' || !Number.isFinite(Date.parse(acquiredAt))) return null;
  return { hostId, pid: pid as number, startTicks: startTicks as number, acquiredAt };
}

function filesystem(options: { fs?: DaemonFs }): DaemonFs {
  // A test that injects a filesystem never reaches the operator's state directory.
  return options.fs ?? DEFAULT_DAEMON_FS;
}

/** The lock currently on disk, or `null` when there is none or it is unreadable garbage. */
export function readDaemonLock(options: DaemonLockFsOptions): DaemonLockRecord | null {
  const fs = filesystem(options);
  let text: string;
  try {
    text = fs.readFileSync(options.paths.lock, 'utf8');
  } catch {
    // A lock that cannot even be read cannot name a live owner, so it is treated
    // as absent and the exclusive create below re-establishes the truth.
    return null;
  }
  try {
    return parseDaemonLockRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Whether the recorded lock is still held by a live daemon.
 *
 * A lock file with no readable owner record cannot identify a live process, so
 * it is reclaimable: the file is created exclusively, so a complete record is
 * written by the holder, and an incomplete one can only be a leftover.
 */
export function daemonLockVerdict(record: DaemonLockRecord | null, options: LockProbeOptions): LockHoldVerdict {
  if (record === null) {
    return { heldBy: null, reason: 'no daemon lock is present' };
  }
  const procRoot = options.procRoot ?? '/proc';
  if (procStartTicks(record.pid, procRoot) !== record.startTicks) {
    return { heldBy: null, reason: `the recorded daemon pid ${record.pid} is not running with start time ${record.startTicks}` };
  }
  const sender = options.signal ?? process.kill;
  let alive: boolean;
  try {
    alive = sender(record.pid, 0) === true;
  } catch {
    alive = false;
  }
  if (!alive) {
    return { heldBy: null, reason: `pid ${record.pid} could not be signalled, so it is gone` };
  }
  return { heldBy: record, reason: `pid ${record.pid} is this host's running Antonina daemon` };
}

export class DaemonAlreadyRunningError extends Error {
  readonly record: DaemonLockRecord;
  constructor(record: DaemonLockRecord, reason: string) {
    super('An Antonina daemon is already running for this host: ' + reason);
    this.name = 'DaemonAlreadyRunningError';
    this.record = record;
  }
}

export class DaemonLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonLockError';
  }
}

/**
 * Takes the lock, or refuses because a live daemon holds it.
 *
 * The file is created with `wx`, so creation itself is the mutual exclusion: two
 * daemons racing to create it cannot both succeed, and neither needs to trust a
 * check-then-write. A stale lock is reclaimed only after being re-read and
 * judged dead, and the reclaim is refused if the record changed in between.
 */
export function acquireDaemonLock(
  record: DaemonLockRecord,
  options: LockProbeOptions & { allowStaleTakeover?: boolean },
): void {
  const fs = filesystem(options);
  fs.mkdirSync(options.paths.dir, { recursive: true });
  const payload = JSON.stringify(record, null, 2) + '\n';
  try {
    const handle = fs.openSync(options.paths.lock, 'wx');
    try {
      fs.writeFileSync(handle, payload);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return;
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw new DaemonLockError('could not create the daemon lock at ' + options.paths.lock, { cause: error });
    }
  }
  const existing = readDaemonLock(options);
  const verdict = daemonLockVerdict(existing, options);
  if (verdict.heldBy !== null) throw new DaemonAlreadyRunningError(verdict.heldBy, verdict.reason);
  if (options.allowStaleTakeover !== true) {
    throw new DaemonLockError(
      'a daemon lock is present but its owner is gone (' + verdict.reason + '); refusing to take it over implicitly',
    );
  }
  // The re-read is the narrowing of the takeover window: the record that was
  // judged dead is compared against the record that is on disk now, and a
  // change in between -- another starter having installed its own live lock --
  // stops the reclaim instead of unlinking a lock nobody judged.
  const rereadText = readDaemonLockText(fs, options.paths.lock);
  let reRead: DaemonLockRecord | null = null;
  try {
    reRead = parseDaemonLockRecord(JSON.parse(rereadText));
  } catch {
    reRead = null;
  }
  const before = existing === null ? null : JSON.stringify(existing);
  const after = reRead === null ? null : JSON.stringify(reRead);
  if (before !== after) {
    throw new DaemonLockError('the daemon lock changed while it was being reclaimed; refusing to remove it');
  }
  try {
    fs.unlinkSync(options.paths.lock);
  } catch (error) {
    throw new DaemonLockError('could not remove the stale daemon lock at ' + options.paths.lock, { cause: error });
  }
  const handle = fs.openSync(options.paths.lock, 'wx');
  try {
    fs.writeFileSync(handle, payload);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function readDaemonLockText(fs: DaemonFs, path: string): string {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Releases the lock this daemon owns.
 *
 * The record is re-read first and only removed when it still names this
 * daemon's own pid and start time, so a shutdown that arrives after another
 * daemon has already taken over cannot unlink the new owner's lock.
 */
export function releaseDaemonLock(
  record: DaemonLockRecord,
  options: DaemonLockFsOptions,
): void {
  const fs = filesystem(options);
  const existing = readDaemonLock(options);
  if (existing === null) return;
  if (existing.pid !== record.pid || existing.startTicks !== record.startTicks || existing.hostId !== record.hostId) return;
  try {
    fs.unlinkSync(options.paths.lock);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw new DaemonLockError('could not remove the daemon lock at ' + options.paths.lock, { cause: error });
  }
}
