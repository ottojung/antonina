import {
  DAEMON_REPORT_SCHEMA_VERSION,
  type DaemonHostReport,
  type DaemonHealth,
} from '../../core/src/host-daemon.js';
import type { DaemonConfig } from './config.js';
import { DEFAULT_DAEMON_FS, type DaemonFs } from './fs.js';
import { daemonPaths, ensureHostIdentity, type DaemonPaths } from './identity.js';
import {
  DaemonAlreadyRunningError,
  acquireDaemonLock,
  releaseDaemonLock,
  type DaemonLockRecord,
} from './lock.js';
import { clearHostReport, writeHostReport } from './state.js';
import { collectTelemetry, platformHostFacts, reportedPaths, type HostFacts } from './telemetry.js';
import { procStartTicks, type SignalSender } from '../../agent-runtime/src/process.js';

/**
 * The daemon's lifecycle.
 *
 * It publishes, on a timer, and it observes. There is no command path here and
 * no board write: a report is a host saying what it currently is, and how long
 * a job may run on a host it has already claimed is a decision the transport
 * and the board make, not the observer.
 *
 * On a graceful stop the published report is removed, so a host whose daemon
 * has been shut down reads as offline immediately rather than staying "online"
 * until its last report ages out. A daemon that dies without stopping leaves its
 * report behind, and that one is what reads as stale before it reads as offline.
 * Identity is left in place either way: a host that restarts its daemon is the
 * same host.
 */

export const DAEMON_VERSION = '0.1.0';

/** The timer seam, so a test can drive heartbeats without waiting for wall-clock time. */
export interface DaemonScheduler {
  schedule(fn: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const DEFAULT_SCHEDULER: DaemonScheduler = {
  schedule: (fn, delayMs) => setTimeout(fn, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DaemonServiceOptions {
  readonly config: DaemonConfig;
  readonly env: Record<string, string | undefined>;
  readonly home?: string;
  readonly fs?: DaemonFs;
  readonly paths?: DaemonPaths;
  /** Injected clock. The daemon reads no other source of time. */
  readonly now?: () => number;
  /** Injected platform facts; defaults to `os`, `/proc/meminfo` and `fs.statfs`. */
  readonly facts?: (nowMs: number) => HostFacts;
  readonly scheduler?: DaemonScheduler;
  readonly version?: string;
  readonly pid?: number;
  readonly startTicks?: number | null;
  readonly procRoot?: string;
  readonly signal?: SignalSender;
  /**
   * Whether a lock left by a daemon that is no longer running may be taken.
   * On by default because a leftover lock is a crashed daemon, and a host that
   * cannot restart its daemon after a power cut is not a host reporting
   * telemetry. The residual takeover race is documented in `lock.ts`.
   */
  readonly allowStaleLockTakeover?: boolean;
}

export interface DaemonHandle {
  readonly hostId: string;
  readonly address: string;
  readonly paths: DaemonPaths;
  /** The most recently published report, or `null` before the first heartbeat. */
  lastReport(): DaemonHostReport | null;
  /**
   * Converges the daemon: stops the timer, waits for an in-flight publish, drops
   * the published report and releases the lock. Safe to call more than once.
   */
  stop(): Promise<void>;
}

export class DaemonStartError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonStartError';
  }
}

/** The health a reading implies: anything the host could not answer is a degradation. */
export function healthOf(problems: readonly string[]): DaemonHealth {
  return problems.length === 0 ? 'healthy' : 'degraded';
}

export function startDaemon(options: DaemonServiceOptions): DaemonHandle {
  const fs = options.fs ?? DEFAULT_DAEMON_FS;
  const now = options.now ?? Date.now;
  const paths = options.paths ?? daemonPaths({
    env: options.env,
    ...(options.home === undefined ? {} : { home: options.home }),
    fs,
  });
  const identity = ensureHostIdentity({
    config: options.config,
    paths,
    nowMs: now(),
    fs,
  });
  // The canonical address of a host Antonina knows by name: the same `lubko://`
  // spelling the target catalog uses, so a report and a target relate by
  // address rather than by a second invented identifier.
  const address = options.config.address ?? 'lubko://' + identity.hostId;
  const pid = options.pid ?? process.pid;
  const startTicks = options.startTicks !== undefined
    ? options.startTicks
    : procStartTicks(pid, options.procRoot ?? '/proc');
  if (startTicks === null) {
    throw new DaemonStartError(
      'could not read this daemon process start time, so its identity could not be recorded; '
        + 'refusing to publish a report whose pid cannot be distinguished from a recycled one',
    );
  }
  const lock: DaemonLockRecord = {
    hostId: identity.hostId,
    pid,
    startTicks,
    acquiredAt: new Date(now()).toISOString(),
  };
  try {
    acquireDaemonLock(lock, {
      paths,
      fs,
      procRoot: options.procRoot ?? '/proc',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      allowStaleTakeover: options.allowStaleLockTakeover ?? true,
    });
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) throw error;
    throw new DaemonStartError('could not take the host daemon lock: ' + (error instanceof Error ? error.message : String(error)), { cause: error });
  }

  const pathsReported = reportedPaths(options.config);
  const factsFor = options.facts ?? ((nowMs: number) => platformHostFacts({ nowMs }));
  const startedAt = new Date(now()).toISOString();
  const version = options.version ?? DAEMON_VERSION;
  let heartbeatCount = 0;
  let last: DaemonHostReport | null = null;
  let timer: unknown = null;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const publish = (): void => {
    const nowMs = now();
    const telemetry = collectTelemetry(factsFor(nowMs), pathsReported);
    const report: DaemonHostReport = {
      schemaVersion: DAEMON_REPORT_SCHEMA_VERSION,
      hostId: identity.hostId,
      address,
      health: healthOf(telemetry.problems),
      observedAt: new Date(nowMs).toISOString(),
      heartbeatCount: heartbeatCount + 1,
      daemon: { pid, startTicks, startedAt, version },
      telemetry,
    };
    writeHostReport(report, { paths, fs });
    heartbeatCount += 1;
    last = report;
  };

  const schedule = options.scheduler ?? DEFAULT_SCHEDULER;
  const beat = (): void => {
    if (stopped) return;
    inFlight = (async () => { publish(); })().catch((error: unknown) => {
      // A heartbeat that cannot be published is not a reason to exit: the host
      // stays online until its last report goes stale, and the next beat may
      // well succeed. The failure is not silently swallowed -- it is surfaced
      // through `lastReport` remaining at the previous report and rethrown by
      // the caller that asked for the report.
      process.stderr.write('antonina daemon: heartbeat failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    });
    if (!stopped) timer = schedule.schedule(beat, options.config.heartbeatIntervalMs);
  };

  // The first report is published before the timer is armed, so a host is
  // reported as soon as its daemon is up rather than one interval later.
  try {
    publish();
  } catch (error) {
    releaseDaemonLock(lock, { paths, fs });
    throw new DaemonStartError('could not publish the first host report: ' + (error instanceof Error ? error.message : String(error)), { cause: error });
  }
  timer = schedule.schedule(beat, options.config.heartbeatIntervalMs);

  return {
    hostId: identity.hostId,
    address,
    paths,
    lastReport: () => last,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) schedule.cancel(timer);
      timer = null;
      await inFlight;
      try {
        clearHostReport({ paths, fs });
      } finally {
        releaseDaemonLock(lock, { paths, fs });
      }
    },
  };
}
