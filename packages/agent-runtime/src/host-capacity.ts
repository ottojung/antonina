import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Host memory observation, for diagnosing why a managed agent died.
 *
 * This module reports what the kernel already says about the cgroup this
 * process runs in. It does not decide whether a launch should happen. Antonina
 * is not a host scheduler or an admission controller: a valid launch is never
 * refused, delayed, or suppressed on a memory, CPU, disk or cgroup heuristic,
 * and if an agent dies because the host ran out of resources, it dies. See the
 * "Agent launch is not host-capacity policy" intent record in
 * `docs/intent-records/agent.md`.
 *
 * What the runtime owes an operator instead is an honest account of a death. A
 * bare `SIGKILL` with `exit_signal 9`, a null `backend_error` and a truncated
 * log is indistinguishable from a model-backend crash, so the OOM counters are
 * read as a before/after bracket around every invocation and a death that
 * coincides with a rising `oom_kill` is classified as resource exhaustion with
 * the observed evidence attached.
 *
 * Every reading is a plain file read under /sys/fs/cgroup and /proc, and every
 * reading is funnelled through one seam (`HostCapacityReadOptions.readText`)
 * so the reading logic can be tested against synthetic values instead of
 * against this host's live, constantly moving memory counters. A reading that
 * degrades states the reason and never substitutes a guess for a number.
 */

export const CGROUP_ROOT = '/sys/fs/cgroup';
export const PROC_SELF_CGROUP = '/proc/self/cgroup';
export const PRESSURE_PATH = '/proc/pressure/memory';

export type CapacityDegradedReason =
  | 'proc_self_cgroup_unreadable'
  | 'cgroup_v2_unavailable'
  | 'memory_max_unreadable'
  | 'no_limited_cgroup'
  | 'memory_max_malformed'
  | 'memory_current_unreadable'
  | 'memory_current_malformed';

export type CapacitySource = 'cgroup_v2' | 'degraded';

/** The single seam every cgroup/proc reading goes through. */
export type CapacityTextReader = (path: string) => string | null;

export interface HostCapacityReadOptions {
  readText?: CapacityTextReader;
  cgroupRoot?: string;
  procSelfCgroup?: string;
  pressurePath?: string;
}

/**
 * What the kernel actually said. A `null` here means "the kernel did not tell
 * us", never "assume a default" — the distinction is the whole point of the
 * issue this guard exists for.
 */
export interface HostCapacity {
  source: CapacitySource;
  cgroupPath: string | null;
  limitBytes: number | null;
  usageBytes: number | null;
  headroomBytes: number | null;
  pressureFullAvg10: number | null;
  oom: number | null;
  oomKill: number | null;
  degradedReason: CapacityDegradedReason | null;
  /** A stated, human-readable reason, present whenever `source` is `degraded`. */
  reason: string | null;
}

export interface OomCounters {
  oom: number;
  oomKill: number;
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function cgroupRelativePath(text: string): string | null {
  for (const line of text.split('\n')) {
    const fields = line.trim().split(':');
    if (fields.length < 3) continue;
    if (fields[0] === '0' && fields[1] === '') {
      const path = fields.slice(2).join(':');
      return path === '' ? '/' : path;
    }
  }
  return null;
}

function parseByteValue(raw: string): number | null {
  const value = raw.trim();
  if (value === 'max') return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseCounterLine(text: string, key: string): number | null {
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 2 && fields[0] === key && /^\d+$/.test(fields[1]!)) {
      const parsed = Number(fields[1]!);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return null;
}

function parsePressureFullAvg10(text: string): number | null {
  for (const line of text.split('\n')) {
    if (!/^full\b/.test(line.trim())) continue;
    const match = /\bavg10=(\d+(?:\.\d+)?)/.exec(line);
    if (match === null) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function degraded(reason: CapacityDegradedReason, detail: string, partial: Partial<HostCapacity> = {}): HostCapacity {
  return {
    source: 'degraded',
    cgroupPath: null,
    limitBytes: null,
    usageBytes: null,
    headroomBytes: null,
    pressureFullAvg10: null,
    oom: null,
    oomKill: null,
    degradedReason: reason,
    reason: detail,
    ...partial,
  };
}

/**
 * Reads the cgroup limit, current usage, OOM counters and memory pressure for
 * the cgroup this process will run in.
 *
 * Degrades with a stated reason rather than a guess when cgroup v2 is absent,
 * when the cgroup has no hard memory limit, or when any individual file is
 * unreadable. A degraded reading never produces a headroom number, because
 * inventing one is the failure mode this issue exists to remove.
 */
export function readHostCapacity(options: HostCapacityReadOptions = {}): HostCapacity {
  const readText = options.readText ?? defaultReadText;
  const cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT;
  const procSelfCgroup = options.procSelfCgroup ?? PROC_SELF_CGROUP;
  const pressurePath = options.pressurePath ?? PRESSURE_PATH;

  const selfCgroup = readText(procSelfCgroup);
  if (selfCgroup === null) {
    return degraded(
      'proc_self_cgroup_unreadable',
      `cannot read ${procSelfCgroup}, so the cgroup this process would run in is unknown; headroom is not estimated`,
    );
  }
  const relative = cgroupRelativePath(selfCgroup);
  if (relative === null) {
    return degraded(
      'cgroup_v2_unavailable',
      `${procSelfCgroup} exposes no cgroup v2 line, so this host is not on a unified v2 hierarchy; no memory limit is inferred`,
    );
  }
  const cgroupPath = join(cgroupRoot, relative);

  const rawMax = readText(join(cgroupPath, 'memory.max'));
  if (rawMax === null) {
    // A missing cgroup directory and an unreadable memory.max are
    // indistinguishable through a reader, so they are reported as one honest
    // condition that names the path tried, rather than split into a guess.
    return degraded(
      'memory_max_unreadable',
      `${join(cgroupPath, 'memory.max')} is unreadable, so this cgroup may not exist or may not be readable; no memory limit is known and headroom is not estimated`,
      { cgroupPath },
    );
  }
  if (rawMax.trim() === 'max') {
    return degraded(
      'no_limited_cgroup',
      `${join(cgroupPath, 'memory.max')} reads "max", meaning this cgroup has no hard memory limit; headroom is not estimated and any reading of it would be a guess`,
      { cgroupPath },
    );
  }
  const limitBytes = parseByteValue(rawMax);
  if (limitBytes === null) {
    return degraded(
      'memory_max_malformed',
      `${join(cgroupPath, 'memory.max')} reads ${JSON.stringify(rawMax.trim())}, which is neither a byte count nor "max"; no limit is inferred`,
      { cgroupPath },
    );
  }

  const rawCurrent = readText(join(cgroupPath, 'memory.current'));
  if (rawCurrent === null) {
    return degraded(
      'memory_current_unreadable',
      `${join(cgroupPath, 'memory.current')} is unreadable, so usage in a cgroup limited to ${formatBytes(limitBytes)} is unknown; headroom is not estimated`,
      { cgroupPath, limitBytes },
    );
  }
  const usageBytes = parseByteValue(rawCurrent);
  if (usageBytes === null) {
    return degraded(
      'memory_current_malformed',
      `${join(cgroupPath, 'memory.current')} reads ${JSON.stringify(rawCurrent.trim())}, which is not a byte count; headroom is not estimated`,
      { cgroupPath, limitBytes },
    );
  }

  const pressureText = readText(pressurePath);
  const eventsText = readText(join(cgroupPath, 'memory.events'));
  const headroomBytes = Math.max(0, limitBytes - usageBytes);
  return {
    source: 'cgroup_v2',
    cgroupPath,
    limitBytes,
    usageBytes,
    headroomBytes,
    pressureFullAvg10: pressureText === null ? null : parsePressureFullAvg10(pressureText),
    oom: eventsText === null ? null : parseCounterLine(eventsText, 'oom'),
    oomKill: eventsText === null ? null : parseCounterLine(eventsText, 'oom_kill'),
    degradedReason: null,
    reason: null,
  };
}

/**
 * Reads just the OOM counters, for the before/after bracket around an agent's
 * lifetime. Returns null when the kernel exposes no counters, which is a
 * distinct and reportable outcome from "no OOM happened".
 */
export function readOomCounters(options: HostCapacityReadOptions = {}): OomCounters | null {
  const capacity = readHostCapacity(options);
  if (capacity.oom === null || capacity.oomKill === null) return null;
  return { oom: capacity.oom, oomKill: capacity.oomKill };
}

/**
 * Renders a byte count for human and JSON output. A `null` or nonsensical
 * reading renders as `unknown` rather than as a number, because a formatted
 * `0` reads as a measurement and is not one.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(2)} ${units[unit]}`;
}

/** One line describing what the kernel reported, for status and error text. */
export function describeHostCapacity(capacity: HostCapacity): string {
  if (capacity.source === 'degraded' || capacity.limitBytes === null) {
    return capacity.reason
      ?? 'no cgroup memory limit could be read, so host memory headroom is unknown';
  }
  return [
    `memory.max ${formatBytes(capacity.limitBytes)}`,
    `memory.current ${formatBytes(capacity.usageBytes)}`,
    `headroom ${formatBytes(capacity.headroomBytes)}`,
    capacity.pressureFullAvg10 === null ? null : `pressure full avg10=${capacity.pressureFullAvg10}%`,
    capacity.oom === null || capacity.oomKill === null
      ? null
      : `memory.events oom ${capacity.oom} oom_kill ${capacity.oomKill}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}
