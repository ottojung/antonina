import {
  canonicalHost,
  canonicalTargetId,
  targetIdForHost,
  type Board,
  type BoardExecutionTarget,
} from './model.js';

/**
 * The host-local Antonina daemon, described as shared vocabulary.
 *
 * Everything in this file is the *model* of what a persistent hardware host
 * reports about itself: the shape of a telemetry report, how a report is judged
 * malformed, when a host reads as online, stale or offline, and how a report is
 * related to the execution-target catalog. It is deliberately free of I/O so
 * that the CLI, the daemon process and any board view all read one definition
 * rather than three.
 *
 * Two boundaries are load-bearing here and are not negotiable by a caller:
 *
 *  - A daemon report is host-local observation. It is not a board mutation, it
 *    is never appended to the signed board log, and reading it requires no board
 *    credential. The catalog of execution targets stays a registration; the
 *    report is the freshness of one host behind that registration.
 *  - A report describes capacity. It carries no command-execution surface, so a
 *    daemon can never become a second transport to a host. Lubko remains the
 *    transport for a Lubko-managed host.
 */

export const DAEMON_REPORT_SCHEMA_VERSION = 1 as const;

/** How the daemon itself is doing, which is not the same as how much is free. */
export const DAEMON_HEALTHS = ['healthy', 'degraded'] as const;
export type DaemonHealth = (typeof DAEMON_HEALTHS)[number];

/**
 * Why a single number is absent. A missing measurement always carries one of
 * these instead of a silent `null`, so a reader can tell "this host does not
 * report that" from "this host reported zero".
 */
export const HOST_MEASUREMENT_REASONS = [
  /** The operator did not configure this path, so it was never asked for. */
  'not-configured',
  /** The path or platform file exists but could not be read. */
  'unreadable',
  /** Something was read and it did not have the shape of a measurement. */
  'malformed',
  /** The platform does not expose this measurement at all. */
  'unsupported',
] as const;
export type HostMeasurementReason = (typeof HOST_MEASUREMENT_REASONS)[number];

/** A byte count that was actually observed, and the fact it was observed from. */
export interface HostBytes {
  readonly ok: true;
  readonly bytes: number;
  /** Which platform fact produced it, e.g. `os.totalmem`, `statfs`. */
  readonly source: string;
}

/** A byte count that is absent, and why it is absent. */
export interface HostBytesUnavailable {
  readonly ok: false;
  readonly reason: HostMeasurementReason;
  /** Operator-facing detail; never interpreted by the model. */
  readonly detail: string;
}

export type HostBytesMeasurement = HostBytes | HostBytesUnavailable;

export function hostBytes(bytes: number, source: string): HostBytes {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('A host byte measurement must be a non-negative safe integer');
  }
  if (source.length === 0) throw new Error('A host byte measurement must name its source');
  return { ok: true, bytes, source };
}

export function unavailableHostBytes(reason: HostMeasurementReason, detail: string): HostBytesUnavailable {
  return { ok: false, reason, detail };
}

/** One filesystem, as capacity rather than as a path that may be acted upon. */
export interface HostFilesystem {
  readonly path: string;
  readonly total: HostBytesMeasurement;
  readonly available: HostBytesMeasurement;
}

export interface HostCpu {
  /** `os.cpus().length`, or `null` when the platform does not report cores. */
  readonly logicalCores: number | null;
  /** The CPU model string, or `null` when the platform does not report one. */
  readonly model: string | null;
  /** `[1m, 5m, 15m]`, or `null` where the platform has no load average. */
  readonly loadAverage: readonly [number, number, number] | null;
}

export interface HostMemory {
  readonly total: HostBytesMeasurement;
  readonly available: HostBytesMeasurement;
}

export interface HostTelemetry {
  readonly uptimeSeconds: number | null;
  readonly memory: HostMemory;
  readonly filesystems: readonly HostFilesystem[];
  readonly cpu: HostCpu;
  /**
   * Every measurement that came back absent, named once, sorted. A report with
   * problems is not a broken report: a host that cannot stat a configured
   * workspace still reports everything else, and says which part it lost.
   */
  readonly problems: readonly string[];
}

/** The daemon process behind a report. Identity is pid plus start time, never a process name. */
export interface DaemonProcessIdentity {
  readonly pid: number;
  readonly startTicks: number;
  readonly startedAt: string;
  readonly version: string;
}

export interface DaemonHostReport {
  readonly schemaVersion: typeof DAEMON_REPORT_SCHEMA_VERSION;
  /** The stable host identity, a target-id slug so it can be compared with the catalog. */
  readonly hostId: string;
  /** The canonical `lubko://` address this host is known by, or `null` when it has none. */
  readonly address: string | null;
  readonly health: DaemonHealth;
  /** When this report's telemetry was collected. */
  readonly observedAt: string;
  /** Heartbeats this daemon process has published, so a restarted daemon is visible as one. */
  readonly heartbeatCount: number;
  readonly daemon: DaemonProcessIdentity;
  readonly telemetry: HostTelemetry;
}

export class MalformedDaemonHostReportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super('Antonina daemon host report is malformed: ' + message, options);
    this.name = 'MalformedDaemonHostReportError';
  }
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long after its last heartbeat a host stops reading as online. Three
 * missed beats at the default interval: long enough that a slow telemetry
 * collection is not reported as a dead host, short enough that an orchestrator
 * does not dispatch onto a host that is gone.
 */
export const DEFAULT_STALE_AFTER_MS = 3 * DEFAULT_HEARTBEAT_INTERVAL_MS;

export const HOST_LIVENESSES = ['online', 'stale', 'offline'] as const;
export type HostLivenessStatus = (typeof HOST_LIVENESSES)[number];

export interface HostLiveness {
  readonly status: HostLivenessStatus;
  /** Milliseconds since the last heartbeat, or `null` when nothing was ever reported. */
  readonly ageMs: number | null;
  /** The rule that decided this, stated so a reader need not re-derive it. */
  readonly reason: string;
}

export interface HostLivenessOptions {
  /** Injected clock: the model never reads the wall clock itself. */
  readonly nowMs: number;
  readonly staleAfterMs?: number;
}

/**
 * Whether a host is answering right now.
 *
 * Liveness is a property of how old the last report is, and of nothing else. It
 * is never inferred from a process name, from a pid alone, or from a catalog
 * status: `unavailable` on a target is a registration an operator set, while
 * this is what the host last said about itself.
 */
export function hostLiveness(
  report: DaemonHostReport | null,
  options: HostLivenessOptions,
): HostLiveness {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(options.nowMs)) throw new Error('Host liveness requires a finite current time');
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error('The stale-after threshold must be a positive safe integer of milliseconds');
  }
  if (report === null) {
    return { status: 'offline', ageMs: null, reason: 'the host has never published a daemon report' };
  }
  const observedMs = Date.parse(report.observedAt);
  if (!Number.isFinite(observedMs)) {
    // An unparseable timestamp is treated as no information at all rather than
    // as "now", so a corrupt file can never make a dead host look healthy.
    return { status: 'offline', ageMs: null, reason: 'the last report carries an unusable observation time' };
  }
  const ageMs = options.nowMs - observedMs;
  if (ageMs > staleAfterMs) {
    return {
      status: 'stale',
      ageMs,
      reason: `the last report is ${ageMs}ms old, past the ${staleAfterMs}ms stale threshold`,
    };
  }
  if (ageMs < -staleAfterMs) {
    return {
      status: 'stale',
      ageMs,
      reason: `the last report is dated ${-ageMs}ms in the future, past the ${staleAfterMs}ms stale threshold`,
    };
  }
  return { status: 'online', ageMs, reason: 'the host published a report inside the stale threshold' };
}

/** One host as a scheduler sees it: identity, freshness, and the last telemetry it sent. */
export interface DaemonHostView {
  readonly hostId: string;
  readonly address: string | null;
  /** The catalogued target this host is, or `null` when the catalog claims no such address. */
  readonly targetId: string | null;
  readonly liveness: HostLiveness;
  /** The daemon's own health at the last heartbeat, or `null` when nothing was reported. */
  readonly health: DaemonHealth | null;
  /** The last telemetry, or `null` when nothing was reported. Absent telemetry is never invented. */
  readonly telemetry: HostTelemetry | null;
  readonly observedAt: string | null;
  readonly heartbeatCount: number;
}

export interface DaemonHostViewOptions extends HostLivenessOptions {
  /** The board whose target catalog the view is related to. */
  readonly board?: Board | null;
}

/**
 * The publishing surface: host reports joined against the execution-target
 * catalog, read-only, and in a deterministic order.
 *
 * A host Antonina has no target for is reported with `targetId: null` rather
 * than attached to the nearest one, for the same reason a resource on an
 * uncatalogued host is: the catalog, not this function, decides what is a target.
 */
export function daemonHostViews(
  reports: readonly DaemonHostReport[],
  options: DaemonHostViewOptions,
): DaemonHostView[] {
  const byHost = new Map<string, DaemonHostReport>();
  for (const report of reports) byHost.set(report.hostId, report);
  return [...byHost.values()]
    .sort((left, right) => (left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0))
    .map((report) => {
      const targetId = options.board === undefined || options.board === null || report.address === null
        ? null
        : targetIdForHost(options.board, report.address);
      return {
        hostId: report.hostId,
        address: report.address,
        targetId,
        liveness: hostLiveness(report, options),
        health: report.health,
        telemetry: report.telemetry,
        observedAt: report.observedAt,
        heartbeatCount: report.heartbeatCount,
      };
    });
}

/**
 * The one host view that reports about this target, or `undefined` when none
 * does.
 *
 * A report is related to a target by address, which is what
 * {@link daemonHostViews} already resolved into `targetId`; a view whose
 * `targetId` is `null` belongs to a host the catalog does not claim, and is
 * never attached to the nearest target. This is the single place that relation
 * is decided, so a board view and a CLI command cannot disagree about which
 * report belongs to which target.
 */
export function hostViewForTarget(
  target: Pick<BoardExecutionTarget, 'id' | 'address'>,
  hosts: readonly DaemonHostView[],
): DaemonHostView | undefined {
  return hosts.find((host) => host.targetId === target.id
    || (target.address !== null && host.address === target.address));
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * A byte count at the scale a person reads, for every surface that prints one.
 *
 * It is deliberately the shortest honest spelling of the number: the exact count
 * is never invented and never rounded away silently, because a surface that
 * wants it can print `bytes` beside this string rather than recovering it.
 */
export function formatHostBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
  return (unit === 0 ? String(value) : value.toFixed(1)) + ' ' + BYTE_UNITS[unit];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isText(value) && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isReason(value: unknown): value is HostMeasurementReason {
  return typeof value === 'string' && (HOST_MEASUREMENT_REASONS as readonly string[]).includes(value);
}

/** What a persisted report is wrong about, or `null` when it is well formed. */
export function measurementDefect(value: unknown): string | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'ok')) return 'a byte measurement must record whether it was observed';
  if (value.ok === true) {
    if (!hasExactKeys(value, ['ok', 'bytes', 'source'])) return 'an observed measurement needs its bytes and its source';
    if (!isCount(value.bytes)) return 'observed bytes must be a non-negative safe integer';
    if (!isText(value.source)) return 'an observed measurement must name the platform fact it came from';
    return null;
  }
  if (value.ok === false) {
    if (!hasExactKeys(value, ['ok', 'reason', 'detail'])) return 'an absent measurement needs a reason';
    if (!isReason(value.reason)) return 'an absent measurement must name a known reason';
    if (typeof value.detail !== 'string') return 'an absent measurement must carry a detail string';
    return null;
  }
  return 'a byte measurement must record whether it was observed';
}

function parseMeasurement(value: unknown, label: string): HostBytesMeasurement {
  const defect = measurementDefect(value);
  if (defect !== null) throw new MalformedDaemonHostReportError(`${label}: ${defect}`);
  const measurement = value as HostBytesMeasurement;
  if (measurement.ok) return { ok: true, bytes: measurement.bytes, source: measurement.source };
  return { ok: false, reason: measurement.reason, detail: measurement.detail };
}

function parseFilesystem(value: unknown, index: number): HostFilesystem {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'total', 'available'])) {
    throw new MalformedDaemonHostReportError(`filesystems[${index}] must record a path with total and available bytes`);
  }
  if (!isText(value.path) || !value.path.startsWith('/')) {
    throw new MalformedDaemonHostReportError(`filesystems[${index}].path must be an absolute path`);
  }
  return {
    path: value.path,
    total: parseMeasurement(value.total, `filesystems[${index}].total`),
    available: parseMeasurement(value.available, `filesystems[${index}].available`),
  };
}

function parseLoadAverage(value: unknown): readonly [number, number, number] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 3) {
    throw new MalformedDaemonHostReportError('telemetry.cpu.loadAverage must be null or three numbers');
  }
  const numbers = value.map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new MalformedDaemonHostReportError('telemetry.cpu.loadAverage must hold finite numbers');
    }
    return entry;
  });
  return [numbers[0]!, numbers[1]!, numbers[2]!];
}

function parseTelemetry(value: unknown): HostTelemetry {
  if (!isRecord(value) || !hasExactKeys(value, ['uptimeSeconds', 'memory', 'filesystems', 'cpu', 'problems'])) {
    throw new MalformedDaemonHostReportError('telemetry must record uptime, memory, filesystems, cpu and problems');
  }
  if (value.uptimeSeconds !== null && (typeof value.uptimeSeconds !== 'number' || !Number.isFinite(value.uptimeSeconds) || value.uptimeSeconds < 0)) {
    throw new MalformedDaemonHostReportError('telemetry.uptimeSeconds must be null or a non-negative number');
  }
  if (!isRecord(value.memory) || !hasExactKeys(value.memory, ['total', 'available'])) {
    throw new MalformedDaemonHostReportError('telemetry.memory must record total and available bytes');
  }
  if (!Array.isArray(value.filesystems)) {
    throw new MalformedDaemonHostReportError('telemetry.filesystems must be a list');
  }
  const filesystems = value.filesystems.map(parseFilesystem);
  if (!isRecord(value.cpu) || !hasExactKeys(value.cpu, ['logicalCores', 'model', 'loadAverage'])) {
    throw new MalformedDaemonHostReportError('telemetry.cpu must record cores, model and load average');
  }
  if (value.cpu.logicalCores !== null && !isCount(value.cpu.logicalCores)) {
    throw new MalformedDaemonHostReportError('telemetry.cpu.logicalCores must be null or a non-negative integer');
  }
  if (value.cpu.model !== null && !isText(value.cpu.model)) {
    throw new MalformedDaemonHostReportError('telemetry.cpu.model must be null or a non-empty string');
  }
  if (!Array.isArray(value.problems) || !value.problems.every(isText)) {
    throw new MalformedDaemonHostReportError('telemetry.problems must be a list of names');
  }
  return {
    uptimeSeconds: value.uptimeSeconds as number | null,
    memory: {
      total: parseMeasurement(value.memory.total, 'telemetry.memory.total'),
      available: parseMeasurement(value.memory.available, 'telemetry.memory.available'),
    },
    filesystems,
    cpu: {
      logicalCores: value.cpu.logicalCores as number | null,
      model: value.cpu.model as string | null,
      loadAverage: parseLoadAverage(value.cpu.loadAverage),
    },
    problems: [...(value.problems as string[])].sort(),
  };
}

/**
 * What a persisted report is internally inconsistent about, or `null`.
 *
 * This is the same shape of check as `executionTargetDefect`: a reason string
 * rather than a thrown error, so a reader of a state file can decide what a
 * damaged record means instead of catching an exception to find out.
 */
export function daemonHostReportDefect(report: DaemonHostReport): string | null {
  if (report.schemaVersion !== DAEMON_REPORT_SCHEMA_VERSION) {
    return `unsupported daemon report schema version ${String(report.schemaVersion)}`;
  }
  if (typeof report.hostId !== 'string' || report.hostId.length === 0) {
    return 'a report must name the host it came from';
  }
  if (!(DAEMON_HEALTHS as readonly string[]).includes(report.health)) {
    return 'a report must record a known daemon health';
  }
  if (!isTimestamp(report.observedAt)) return 'a report must record when it was observed';
  if (!isCount(report.heartbeatCount) || report.heartbeatCount < 1) {
    return 'a report must record at least one published heartbeat';
  }
  if (report.address !== null && typeof report.address !== 'string') {
    return 'a report carries either a Lubko address or null';
  }
  if (!isRecord(report.daemon) || !hasExactKeys(report.daemon, ['pid', 'startTicks', 'startedAt', 'version'])) {
    return 'a report must record the daemon process identity behind it';
  }
  if (!Number.isSafeInteger(report.daemon.pid) || report.daemon.pid <= 0) {
    return 'a report must record a positive daemon pid';
  }
  if (!Number.isSafeInteger(report.daemon.startTicks) || report.daemon.startTicks <= 0) {
    return 'a report must record the daemon start time that makes its pid mean something';
  }
  if (!isTimestamp(report.daemon.startedAt)) return 'a report must record when the daemon process started';
  if (!isText(report.daemon.version)) return 'a report must record the daemon version';
  try {
    parseTelemetry(report.telemetry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace('Antonina daemon host report is malformed: ', '');
  }
  return null;
}

/** Rejects anything that is not a report this model can act on, by name. */
export function parseDaemonHostReport(value: unknown): DaemonHostReport {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'hostId', 'address', 'health', 'observedAt', 'heartbeatCount', 'daemon', 'telemetry',
  ])) {
    throw new MalformedDaemonHostReportError('a report must record exactly its own fields');
  }
  if (value.schemaVersion !== DAEMON_REPORT_SCHEMA_VERSION) {
    throw new MalformedDaemonHostReportError('unsupported daemon report schema version');
  }
  const hostId = isText(value.hostId)
    ? (() => {
      try {
        return canonicalTargetId(value.hostId);
      } catch (error) {
        throw new MalformedDaemonHostReportError('a report must name its host with a target-id slug', { cause: error });
      }
    })()
    : null;
  if (hostId === null) throw new MalformedDaemonHostReportError('a report must name its host with a target-id slug');
  if (value.address !== null) {
    if (!isText(value.address)) throw new MalformedDaemonHostReportError('a report address must be a string or null');
    try {
      canonicalHost(value.address);
    } catch (error) {
      throw new MalformedDaemonHostReportError('a report address is not a canonical Lubko address', { cause: error });
    }
  }
  if (typeof value.health !== 'string' || !(DAEMON_HEALTHS as readonly string[]).includes(value.health)) {
    throw new MalformedDaemonHostReportError('a report must record a known daemon health');
  }
  if (!isText(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new MalformedDaemonHostReportError('a report must record a parseable observation time');
  }
  if (!isCount(value.heartbeatCount) || value.heartbeatCount < 1) {
    throw new MalformedDaemonHostReportError('a report must record at least one published heartbeat');
  }
  if (!isRecord(value.daemon) || !hasExactKeys(value.daemon, ['pid', 'startTicks', 'startedAt', 'version'])) {
    throw new MalformedDaemonHostReportError('a report must record the daemon process identity behind it');
  }
  if (!Number.isSafeInteger(value.daemon.pid) || (value.daemon.pid as number) <= 0) {
    throw new MalformedDaemonHostReportError('a report must record a positive daemon pid');
  }
  if (!Number.isSafeInteger(value.daemon.startTicks) || (value.daemon.startTicks as number) <= 0) {
    throw new MalformedDaemonHostReportError('a report must record the daemon start time');
  }
  if (!isTimestamp(value.daemon.startedAt)) {
    throw new MalformedDaemonHostReportError('a report must record when the daemon process started');
  }
  if (!isText(value.daemon.version)) throw new MalformedDaemonHostReportError('a report must record the daemon version');
  const report: DaemonHostReport = {
    schemaVersion: DAEMON_REPORT_SCHEMA_VERSION,
    hostId,
    address: value.address as string | null,
    health: value.health as DaemonHealth,
    observedAt: value.observedAt,
    heartbeatCount: value.heartbeatCount,
    daemon: {
      pid: value.daemon.pid as number,
      startTicks: value.daemon.startTicks as number,
      startedAt: value.daemon.startedAt,
      version: value.daemon.version,
    },
    telemetry: parseTelemetry(value.telemetry),
  };
  const defect = daemonHostReportDefect(report);
  if (defect !== null) throw new MalformedDaemonHostReportError(defect);
  return report;
}
