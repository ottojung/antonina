import { createHash } from 'node:crypto';
import { homedir, hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';

import { canonicalTargetId } from '../../core/src/model.js';
import type { DaemonConfig } from './config.js';
import { DEFAULT_DAEMON_FS, hasCode, type DaemonFs } from './fs.js';

/**
 * Host identity: the stable name a host answers to across daemon restarts.
 *
 * It is derived, in this order, and each step is a fact about the machine rather
 * than a fact about a running process:
 *
 *  1. `hostId` in `daemon.json` -- the operator's explicit override.
 *  2. The durable identity this host recorded on its first run.
 *  3. The system machine id (`/etc/machine-id`, else `/var/lib/dbus/machine-id`).
 *  4. The system hostname.
 *
 * A process name never appears in that list, and neither does a pid: a name is
 * chosen by whatever started the program, and a pid is reused, so neither is a
 * fact about a host. Step 2 is what makes the identity stable *and* stable
 * across an operator renaming the machine: once recorded, the id is the host's
 * Antonina name, and a machine-id or hostname that later changes does not
 * rename it out from under the resources registered against it.
 *
 * If no step produces an identity the daemon refuses to start rather than
 * inventing one. A fabricated identity would be a plausible-looking host that
 * no board target can ever relate to.
 */

export type HostIdSource = 'configured' | 'durable-state' | 'machine-id' | 'dbus-machine-id' | 'hostname';

export const HOST_ID_SOURCES: readonly HostIdSource[] = [
  'configured', 'durable-state', 'machine-id', 'dbus-machine-id', 'hostname',
];

export interface HostIdentity {
  /** A lowercase target-id slug, so it can be compared with the execution catalog. */
  readonly hostId: string;
  readonly source: HostIdSource;
}

export interface DurableHostIdentity extends HostIdentity {
  readonly recordedAt: string;
}

export class HostIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HostIdentityError';
  }
}

/** Read in order; the first one that is present and well formed wins. */
export const MACHINE_ID_FILES: readonly string[] = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

const MACHINE_ID = /^[0-9a-f]{32}$/i;
const MAX_SLUG_LENGTH = 64;

/**
 * A hostname reduced to a slug, deterministically.
 *
 * Two hosts in one fleet may share a hostname, which is a property of DNS
 * rather than of hardware; a name too long for the slug is suffixed with a
 * digest of the whole hostname rather than truncated, so two different
 * long hostnames cannot collide by sharing a prefix. This is still a machine
 * fact, and it is the last resort before refusing.
 */
export function hostIdFromHostname(hostname: string): string | null {
  const lowered = hostname.trim().toLowerCase();
  const slug = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length === 0) return null;
  if (slug.length <= MAX_SLUG_LENGTH) return canonicalTargetId(slug);
  const digest = createHash('sha256').update(lowered).digest('hex').slice(0, 8);
  return canonicalTargetId(slug.slice(0, MAX_SLUG_LENGTH - 9).replace(/-+$/g, '') + '-' + digest);
}

/** The slug a machine id yields, or `null` when the file held something else. */
export function hostIdFromMachineId(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!MACHINE_ID.test(value)) return null;
  return canonicalTargetId('host-' + value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The identity this host already recorded, or `null` when it has never run.
 *
 * A file that is present and unreadable is refused rather than ignored. Deriving
 * a fresh identity from a damaged record would register what looks like a
 * second host and leave the first one permanently unreported, so the operator
 * is asked to look at the file instead.
 */
export function readDurableHostIdentity(
  path: string,
  fs: DaemonFs,
): DurableHostIdentity | null {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw new HostIdentityError('could not read the recorded host identity at ' + path, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new HostIdentityError('the recorded host identity at ' + path + ' is not valid JSON', { cause: error });
  }
  if (!isRecord(value)
      || typeof value.hostId !== 'string'
      || !HOST_ID_SOURCES.includes(value.source as HostIdSource)
      || typeof value.recordedAt !== 'string'
      || !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new HostIdentityError('the recorded host identity at ' + path + ' is not a host identity Antonina wrote');
  }
  let hostId: string;
  try {
    hostId = canonicalTargetId(value.hostId);
  } catch (error) {
    throw new HostIdentityError('the recorded host id at ' + path + ' is not a target-id slug', { cause: error });
  }
  return { hostId, source: value.source as HostIdSource, recordedAt: value.recordedAt };
}

/**
 * The identity this host goes by, without writing anything.
 *
 * A configured `hostId` always wins and is never recorded, because a value the
 * operator pinned is read from the one place they can see and change it.
 */
export function resolveHostIdentity(options: {
  config: DaemonConfig;
  identityPath: string;
  fs?: DaemonFs;
  hostname?: string;
  machineIdFiles?: readonly string[];
}): HostIdentity {
  const fs = options.fs ?? DEFAULT_DAEMON_FS;
  if (options.config.hostId !== null) {
    return { hostId: options.config.hostId, source: 'configured' };
  }
  const durable = readDurableHostIdentity(options.identityPath, fs);
  if (durable !== null) return { hostId: durable.hostId, source: 'durable-state' };
  const files = options.machineIdFiles ?? MACHINE_ID_FILES;
  for (const [index, path] of files.entries()) {
    let raw: string;
    try {
      raw = fs.readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const derived = hostIdFromMachineId(raw);
    if (derived === null) continue;
    return { hostId: derived, source: index === 0 ? 'machine-id' : 'dbus-machine-id' };
  }
  const hostname = options.hostname ?? hostnameFact();
  const fromHostname = hostname === null ? null : hostIdFromHostname(hostname);
  if (fromHostname === null) {
    throw new HostIdentityError(
      'this host has no stable identity Antonina can derive: no machine id was readable and the hostname is not a usable name. '
        + 'Set "hostId" in daemon.json to name this host explicitly',
    );
  }
  return { hostId: fromHostname, source: 'hostname' };
}

function hostnameFact(): string | null {
  try {
    return osHostname();
  } catch {
    return null;
  }
}

export interface DaemonStatePathsOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  fs?: DaemonFs;
}

/** The resolved `$XDG_STATE_HOME/antonina` (or `$HOME/.local/state/antonina`). */
export function daemonStateRoot(options: DaemonStatePathsOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const base = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(base, 'antonina');
}

/** Everything this host's daemon owns lives in one directory, apart from the lock. */
export function daemonStateDir(options: DaemonStatePathsOptions = {}): string {
  return join(daemonStateRoot(options), 'daemon');
}

export const HOST_IDENTITY_FILE = 'identity.json';
export const HOST_REPORT_FILE = 'host.json';
export const DAEMON_LOCK_FILE = 'daemon.lock';

export interface DaemonPaths {
  readonly dir: string;
  readonly identity: string;
  readonly report: string;
  readonly lock: string;
}

export function daemonPaths(options: DaemonStatePathsOptions = {}): DaemonPaths {
  const dir = daemonStateDir(options);
  return {
    dir,
    identity: join(dir, HOST_IDENTITY_FILE),
    report: join(dir, HOST_REPORT_FILE),
    lock: join(dir, DAEMON_LOCK_FILE),
  };
}

/**
 * The identity, recorded durably the first time it is derived.
 *
 * Recording is what makes a derived identity survive a later change to the
 * machine id or the hostname. It is written through a temporary file and
 * renamed, so a crash mid-write leaves either the old record or the new one and
 * never a half-written identity.
 */
export function ensureHostIdentity(options: {
  config: DaemonConfig;
  paths: DaemonPaths;
  nowMs: number;
  fs?: DaemonFs;
  hostname?: string;
  machineIdFiles?: readonly string[];
}): HostIdentity {
  const fs = options.fs ?? DEFAULT_DAEMON_FS;
  const identity = resolveHostIdentity({
    config: options.config,
    identityPath: options.paths.identity,
    fs,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.machineIdFiles === undefined ? {} : { machineIdFiles: options.machineIdFiles }),
  });
  if (identity.source !== 'configured' && readDurableHostIdentity(options.paths.identity, fs) === null) {
    fs.mkdirSync(dirname(options.paths.identity), { recursive: true });
    const temporary = options.paths.identity + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({
      hostId: identity.hostId,
      source: identity.source,
      recordedAt: new Date(options.nowMs).toISOString(),
    }, null, 2) + '\n');
    fs.renameSync(temporary, options.paths.identity);
  }
  return identity;
}
