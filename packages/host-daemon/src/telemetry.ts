import { readFileSync, statfsSync } from 'node:fs';
import * as os from 'node:os';

import {
  hostBytes,
  unavailableHostBytes,
  type HostBytesMeasurement,
  type HostCpu,
  type HostFilesystem,
  type HostTelemetry,
} from '../../core/src/host-daemon.js';

/**
 * Telemetry collection, over an injected seam of platform facts.
 *
 * The collector decides nothing about the numbers: it asks for each fact, keeps
 * what came back, and names what did not. That is what makes the collection
 * testable without a machine, and what makes a host that can answer three of
 * four questions still report three of them.
 *
 * Everything here is a read. The collector never deletes, never moves, and
 * never decides a path is unused -- that is the future garbage collector's job
 * (board issue 20's family), and this daemon is only its natural future home.
 * The only paths it touches are the ones the operator configured, and it stats
 * them rather than descending into them.
 */

/** One platform fact, or the reason it is not available. */
export interface HostFacts {
  readonly nowMs: number;
  totalMemoryBytes(): HostBytesMeasurement;
  availableMemoryBytes(): HostBytesMeasurement;
  logicalCores(): number | null;
  cpuModel(): string | null;
  loadAverage(): readonly [number, number, number] | null;
  uptimeSeconds(): number | null;
  filesystemCapacity(path: string): { total: HostBytesMeasurement; available: HostBytesMeasurement };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : code + ': ' + error.message;
  }
  return String(error);
}

function guard(label: string, read: () => HostBytesMeasurement): HostBytesMeasurement {
  try {
    const measurement = read();
    // A fact implementation that answers with something else has not measured
    // anything, and reporting it as an observation would be a lie about the
    // host. It is recorded as malformed instead.
    if (typeof measurement !== 'object' || measurement === null || typeof measurement.ok !== 'boolean') {
      return unavailableHostBytes('malformed', label + ' did not answer with a measurement');
    }
    if (measurement.ok) {
      if (!Number.isSafeInteger(measurement.bytes) || measurement.bytes < 0) {
        return unavailableHostBytes('malformed', label + ' answered with bytes that are not a size');
      }
      if (typeof measurement.source !== 'string' || measurement.source.length === 0) {
        return unavailableHostBytes('malformed', label + ' did not name the fact it measured');
      }
    }
    return measurement;
  } catch (error) {
    return unavailableHostBytes('unreadable', label + ' could not be read (' + describe(error) + ')');
  }
}

/** A nullable platform fact, together with the problem to record when it is absent. */
function guardNullable(label: string, read: () => number | string | readonly [number, number, number] | null): {
  value: number | string | readonly [number, number, number] | null;
  problem: string | null;
} {
  let value: number | string | readonly [number, number, number] | null;
  try {
    value = read();
  } catch (error) {
    return { value: null, problem: `${label} is unavailable (unreadable: ${describe(error)})` };
  }
  return { value: value === undefined ? null : value, problem: null };
}

function problemOf(label: string, measurement: HostBytesMeasurement): string | null {
  return measurement.ok ? null : `${label} is unavailable (${measurement.reason})`;
}

/** Records a problem only when there is one, so an observed measurement costs no entry. */
function record(problems: string[], problem: string | null): void {
  if (problem !== null) problems.push(problem);
}

/**
 * One telemetry reading over the given paths.
 *
 * A fact that throws becomes an absent measurement rather than a failed
 * collection, so a single unreadable workspace cannot cost a host its memory
 * figures as well. The paths are statted in the order given, de-duplicated, and
 * returned in the caller's order, because a report is a reading of a named set
 * of places rather than a sorted database.
 */
export function collectTelemetry(facts: HostFacts, paths: readonly string[]): HostTelemetry {
  const problems: string[] = [];
  const total = guard('total memory', () => facts.totalMemoryBytes());
  const available = guard('available memory', () => facts.availableMemoryBytes());
  const uptime = guardNullable('host uptime', () => facts.uptimeSeconds());
  const cores = guardNullable('cpu cores', () => facts.logicalCores());
  const model = guardNullable('cpu model', () => facts.cpuModel());
  const load = guardNullable('load average', () => facts.loadAverage());
  const uptimeSeconds = typeof uptime.value === 'number' && Number.isFinite(uptime.value) && uptime.value >= 0
    ? uptime.value
    : null;
  const logicalCores = typeof cores.value === 'number' && Number.isSafeInteger(cores.value) && cores.value >= 0
    ? cores.value
    : null;
  const loadAverage = Array.isArray(load.value) && load.value.length === 3
    && load.value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? ([load.value[0], load.value[1], load.value[2]] as [number, number, number])
    : null;
  record(problems, uptime.value !== null && uptimeSeconds === null ? 'host uptime is unavailable (malformed)' : uptime.problem);
  record(problems, cores.value !== null && logicalCores === null ? 'cpu cores are unavailable (malformed)' : cores.problem);
  record(problems, load.value !== null && loadAverage === null ? 'load average is unavailable (malformed)' : load.problem);

  const filesystems: HostFilesystem[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    let capacity: { total: HostBytesMeasurement; available: HostBytesMeasurement };
    try {
      capacity = facts.filesystemCapacity(path);
      if (typeof capacity !== 'object' || capacity === null) {
        capacity = {
          total: unavailableHostBytes('malformed', `${path} did not answer with a filesystem reading`),
          available: unavailableHostBytes('malformed', `${path} did not answer with a filesystem reading`),
        };
      }
    } catch (error) {
      capacity = {
        total: unavailableHostBytes('unreadable', `${path} could not be measured (${describe(error)})`),
        available: unavailableHostBytes('unreadable', `${path} could not be measured (${describe(error)})`),
      };
    }
    const totalMeasurement = guard(`${path} total`, () => capacity.total);
    const availableMeasurement = guard(`${path} available`, () => capacity.available);
    record(problems, problemOf(`${path} total`, totalMeasurement));
    record(problems, problemOf(`${path} available`, availableMeasurement));
    filesystems.push({ path, total: totalMeasurement, available: availableMeasurement });
  }
  record(problems, problemOf('total memory', total));
  record(problems, problemOf('available memory', available));

  const cpu: HostCpu = {
    logicalCores,
    model: typeof model.value === 'string' && model.value.length > 0 ? model.value : null,
    loadAverage,
  };
  return {
    uptimeSeconds,
    memory: { total, available },
    filesystems,
    cpu,
    problems: [...new Set(problems.filter((entry): entry is string => entry !== null))].sort(),
  };
}

export interface PlatformHostFactsOptions {
  nowMs: number;
  /** Overridden in tests; the daemon never reads the operator's real `/proc`. */
  memInfoPath?: string;
}

/** The number of bytes the kernel calls available, or `null` when it says nothing useful. */
export function readMemAvailableBytes(memInfoPath = '/proc/meminfo'): number | null {
  let text: string;
  try {
    text = readFileSync(memInfoPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const match = /^MemAvailable:\s+([0-9]+)\s*kB\s*$/.exec(line);
    if (match === null) continue;
    const kib = Number(match[1]);
    if (!Number.isSafeInteger(kib)) return null;
    const bytes = kib * 1024;
    return Number.isSafeInteger(bytes) ? bytes : null;
  }
  return null;
}

function platformFilesystemCapacity(path: string): { total: HostBytesMeasurement; available: HostBytesMeasurement } {
  let stats: ReturnType<typeof statfsSync>;
  try {
    stats = statfsSync(path);
  } catch (error) {
    return {
      total: unavailableHostBytes('unreadable', `${path} could not be statted (${describe(error)})`),
      available: unavailableHostBytes('unreadable', `${path} could not be statted (${describe(error)})`),
    };
  }
  const blockSize = stats.bsize;
  const totalBlocks = stats.blocks;
  const availableBlocks = stats.bavail;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0
      || !Number.isSafeInteger(totalBlocks) || totalBlocks < 0
      || !Number.isSafeInteger(availableBlocks) || availableBlocks < 0) {
    return {
      total: unavailableHostBytes('malformed', `${path} reported a filesystem shape Antonina cannot read`),
      available: unavailableHostBytes('malformed', `${path} reported a filesystem shape Antonina cannot read`),
    };
  }
  const totalBytes = blockSize * totalBlocks;
  const availableBytes = blockSize * availableBlocks;
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0
      || !Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    return {
      total: unavailableHostBytes('malformed', `${path} reported byte counts Antonina cannot read`),
      available: unavailableHostBytes('malformed', `${path} reported byte counts Antonina cannot read`),
    };
  }
  return {
    total: hostBytes(totalBytes, 'fs.statfs(' + path + ').blocks'),
    // `bavail` rather than `bfree`: blocks reserved for the superuser are not
    // capacity an unprivileged job on this host can use.
    available: hostBytes(availableBytes, 'fs.statfs(' + path + ').bavail'),
  };
}

/**
 * The real platform: `os`, `/proc/meminfo` and `fs.statfs`, and nothing else.
 *
 * No dependency is added for this and no command is run: the numbers an
 * orchestrator needs are already exposed by the platform the daemon runs on.
 */
export function platformHostFacts(options: PlatformHostFactsOptions): HostFacts {
  const memInfoPath = options.memInfoPath ?? '/proc/meminfo';
  return {
    nowMs: options.nowMs,
    totalMemoryBytes: () => hostBytes(os.totalmem(), 'os.totalmem'),
    availableMemoryBytes: () => {
      const available = readMemAvailableBytes(memInfoPath);
      return available === null
        ? hostBytes(os.freemem(), 'os.freemem')
        : hostBytes(available, memInfoPath + ' MemAvailable');
    },
    logicalCores: () => os.cpus().length,
    cpuModel: () => os.cpus()[0]?.model ?? null,
    loadAverage: () => {
      const averages = os.loadavg();
      return [averages[0] ?? 0, averages[1] ?? 0, averages[2] ?? 0] as [number, number, number];
    },
    uptimeSeconds: () => os.uptime(),
    filesystemCapacity: platformFilesystemCapacity,
  };
}

/** The paths a host reports: its configured filesystems, then its workspaces. */
export function reportedPaths(config: {
  readonly filesystems: readonly string[];
  readonly workspaces: readonly string[];
}): string[] {
  return [...new Set([...config.filesystems, ...config.workspaces])];
}
