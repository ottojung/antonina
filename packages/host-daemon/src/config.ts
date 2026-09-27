import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALE_AFTER_MS,
} from '../../core/src/host-daemon.js';
import { canonicalHost, canonicalPath, canonicalTargetId, pathFormDefect } from '../../core/src/model.js';

/**
 * Daemon configuration: what this host is told to report about itself.
 *
 * It is an operator concern and it lives beside `trust.json` and
 * `credential.json` in `$XDG_CONFIG_HOME/antonina`, as `daemon.json`. Those
 * files are the only source for anything in that directory, and the same rule
 * holds here: there is no environment override, because a value that can arrive
 * two ways is a value whose provenance an operator can no longer state.
 */

export const DAEMON_CONFIG_FILE = 'daemon.json';

const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
const MAX_HEARTBEAT_INTERVAL_MS = 3_600_000;

export class DaemonConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonConfigError';
  }
}

export interface DaemonConfigFs {
  readFileSync: typeof readFileSync;
}

const DEFAULT_FS: DaemonConfigFs = { readFileSync };

export interface DaemonConfig {
  /**
   * The host identity the operator pinned, or `null` to let the daemon derive
   * one from a stable machine fact. An explicit value is the override: it is
   * how a host whose machine-id is not readable, or which is cloned, is named.
   */
  readonly hostId: string | null;
  /** The canonical `lubko://` address this host is known by, or `null` to derive `lubko://<hostId>`. */
  readonly address: string | null;
  /** Absolute paths whose filesystems are always reported. */
  readonly filesystems: readonly string[];
  /** Absolute workspace paths reported alongside the filesystems above. */
  readonly workspaces: readonly string[];
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  hostId: null,
  address: null,
  filesystems: ['/'],
  workspaces: [],
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new DaemonConfigError(field + ' must be a list of absolute paths');
  }
  const paths = value as string[];
  for (const path of paths) {
    const defect = pathFormDefect(path);
    if (defect !== null) {
      throw new DaemonConfigError(field + ' must hold canonical absolute paths, but ' + JSON.stringify(path) + ' is ' + defect);
    }
  }
  return [...new Set(paths)].sort();
}

function parseInterval(value: unknown, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DaemonConfigError(field + ' must be an integer number of milliseconds between ' + minimum + ' and ' + maximum);
  }
  return value as number;
}

/**
 * The daemon configuration, from a parsed JSON value.
 *
 * An unknown key is refused rather than ignored: a typo in a key an operator
 * wrote is a configuration that silently does something other than what it
 * says, and a daemon that quietly reports less than asked for is exactly the
 * failure this is here to prevent.
 */
export function parseDaemonConfig(value: unknown): DaemonConfig {
  if (!isRecord(value)) throw new DaemonConfigError('daemon configuration must be a JSON object');
  const known = ['hostId', 'address', 'filesystems', 'workspaces', 'heartbeatIntervalMs', 'staleAfterMs'];
  const unknownKeys = Object.keys(value).filter((key) => !known.includes(key));
  if (unknownKeys.length > 0) {
    throw new DaemonConfigError('daemon configuration has unknown keys: ' + unknownKeys.sort().join(', '));
  }
  const hostId = value.hostId === undefined || value.hostId === null
    ? null
    : canonicalTargetId(String(value.hostId));
  const address = value.address === undefined || value.address === null
    ? null
    : canonicalHost(String(value.address));
  const heartbeatIntervalMs = parseInterval(
    value.heartbeatIntervalMs,
    'heartbeatIntervalMs',
    DEFAULT_DAEMON_CONFIG.heartbeatIntervalMs,
    MIN_HEARTBEAT_INTERVAL_MS,
    MAX_HEARTBEAT_INTERVAL_MS,
  );
  const staleAfterMs = parseInterval(
    value.staleAfterMs,
    'staleAfterMs',
    heartbeatIntervalMs * 3,
    MIN_HEARTBEAT_INTERVAL_MS,
    MAX_HEARTBEAT_INTERVAL_MS,
  );
  if (staleAfterMs <= heartbeatIntervalMs) {
    throw new DaemonConfigError('staleAfterMs must be greater than heartbeatIntervalMs, or every host reads as stale between beats');
  }
  return {
    hostId,
    address,
    filesystems: value.filesystems === undefined
      ? [...DEFAULT_DAEMON_CONFIG.filesystems]
      : parsePaths(value.filesystems, 'filesystems'),
    workspaces: value.workspaces === undefined ? [] : parsePaths(value.workspaces, 'workspaces'),
    heartbeatIntervalMs,
    staleAfterMs,
  };
}

export interface DaemonConfigOptions {
  env: Record<string, string | undefined>;
  home?: string;
  fs?: DaemonConfigFs;
}

/** The resolved `$XDG_CONFIG_HOME/antonina` (or `$HOME/.config/antonina`). */
export function daemonConfigDir(options: DaemonConfigOptions): string {
  const home = options.home ?? options.env.HOME ?? homedir();
  const base = options.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'antonina');
}

/**
 * The configured daemon, or the defaults when the operator has configured
 * nothing. An absent file is the normal state of a host that has not been set
 * up yet; a file that is present and cannot be understood is refused by path,
 * because the operator wrote it and it is wrong.
 */
export function loadDaemonConfig(options: DaemonConfigOptions): DaemonConfig {
  const fs = options.fs ?? DEFAULT_FS;
  const path = join(daemonConfigDir(options), DAEMON_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_DAEMON_CONFIG;
    throw new DaemonConfigError('could not read ' + path, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DaemonConfigError(path + ' must contain valid JSON', { cause: error });
  }
  try {
    return parseDaemonConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DaemonConfigError(path + ': ' + message, { cause: error });
  }
}
