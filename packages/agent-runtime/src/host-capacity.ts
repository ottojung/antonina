import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Host capacity reading and the pre-launch feasibility guard for managed
 * agents.
 *
 * This is a *guard*, not a scheduler. It measures what the kernel already
 * reports about the cgroup this process will run in and decides whether a
 * launch is worth attempting. It never reorders work, never chooses work,
 * never holds a process alive, and — deliberately, per the boundary this guard
 * was written under — never writes to another process, another cgroup, or
 * /proc/sys in order to manufacture room. If the host is full, the honest
 * answer is a refusal the operator can see, not a stolen cycle from somebody
 * else's build.
 *
 * Every reading is a plain file read under /sys/fs/cgroup and /proc, and every
 * reading is funnelled through one seam (`HostCapacityReadOptions.readText`)
 * so the decision logic can be tested against synthetic values instead of
 * against this host's live, constantly moving memory counters.
 */

export const CGROUP_ROOT = '/sys/fs/cgroup';
export const PROC_SELF_CGROUP = '/proc/self/cgroup';
export const PRESSURE_PATH = '/proc/pressure/memory';

/**
 * Default minimum free memory for a managed agent's cgroup, in bytes.
 *
 * 2 GiB is chosen because it is the one number that is defensible across the
 * range of developer hosts Antonina is expected to run on: it is comfortably
 * above the working set a single `opencode run --thinking` invocation has been
 * observed to reach, and it is a small fraction of a typical 8-32 GiB laptop or
 * workstation limit, so it does not block normal launches on a healthy host.
 *
 * It is deliberately *not* the 2 GiB this board improvised as prose in issue
 * comments: that number was chosen against one 30 GiB host. On a 4 GiB
 * container it would be half the limit, and on a 256 GiB build host it would be
 * noise. Hence `ANTONINA_AGENT_MIN_HEADROOM_BYTES`, which accepts a plain byte
 * count or a K/M/G/T suffix, and `0` to disable the refusal outright.
 */
export const DEFAULT_MIN_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

/** Configurable refusal threshold, in bytes. `0` disables the refusal. */
export const MIN_HEADROOM_ENV = 'ANTONINA_AGENT_MIN_HEADROOM_BYTES';

/**
 * Operator escape hatch. It is an environment variable because it must work
 * from a one-line shell invocation before any agent exists, but it is never
 * silent: every refusal message names this variable and its value verbatim, so
 * the hatch is always visible in the refusal rather than hidden in a dotfile.
 */
export const CAPACITY_OVERRIDE_ENV = 'ANTONINA_AGENT_IGNORE_CAPACITY';

/**
 * `/proc/pressure/memory` `full` avg10 percentage at which a host under
 * transient pressure is called out. PSI `full` means the cgroup was stalled
 * waiting on memory for the whole sampling window; 10% is well clear of idle
 * noise (an idle host sits near 0) and well below the ~25% recorded on this
 * host while an off-board build was cycling.
 */
export const PRESSURE_WARNING_AVG10 = 10;

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

const BYTE_SUFFIXES: Record<string, number> = {
  k: 1024,
  m: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  t: 1024 * 1024 * 1024 * 1024,
};

/**
 * Resolves the configured refusal threshold. An explicitly configured but
 * unusable value is refused loudly rather than silently defaulted, because a
 * typo that quietly disabled the guard is exactly the "check that cannot fail"
 * defect class this guard was written to end.
 */
export function resolveMinHeadroomBytes(
  env: Record<string, string | undefined> = process.env,
): { bytes: number; configured: boolean } {
  const raw = env[MIN_HEADROOM_ENV];
  if (raw === undefined || raw === '') {
    return { bytes: DEFAULT_MIN_HEADROOM_BYTES, configured: false };
  }
  const value = raw.trim();
  const match = /^(\d+)([kmgt]?)$/i.exec(value);
  if (match === null) {
    throw new Error(
      `${MIN_HEADROOM_ENV} must be a whole number of bytes, optionally suffixed with K, M, G or T (for example 2147483648 or 2G); refusing to guess a value for ${JSON.stringify(raw)}`,
    );
  }
  const magnitude = Number(match[1]!);
  const scale = match[2] === '' ? 1 : BYTE_SUFFIXES[match[2]!.toLowerCase()]!;
  const bytes = magnitude * scale;
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(`${MIN_HEADROOM_ENV}=${JSON.stringify(raw)} overflows a safe integer of bytes`);
  }
  return { bytes, configured: true };
}

/** True when the operator explicitly asked to launch despite a refusal. */
export function capacityOverrideRequested(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[CAPACITY_OVERRIDE_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export type CapacityOutcome = 'ok' | 'warning' | 'refused' | 'unknown';

export interface CapacityDecision {
  outcome: CapacityOutcome;
  capacity: HostCapacity;
  thresholdBytes: number;
  thresholdConfigured: boolean;
  overrideApplied: boolean;
  /** The operator-facing explanation, always present and never empty. */
  reason: string;
}

export interface CapacityDecisionOptions {
  thresholdBytes?: number;
  thresholdConfigured?: boolean;
  override?: boolean;
  env?: Record<string, string | undefined> | undefined;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
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

function measuredDetail(capacity: HostCapacity): string {
  const parts: string[] = [];
  if (capacity.limitBytes !== null) parts.push(`memory.max ${formatBytes(capacity.limitBytes)}`);
  if (capacity.usageBytes !== null) parts.push(`memory.current ${formatBytes(capacity.usageBytes)}`);
  if (capacity.pressureFullAvg10 !== null) parts.push(`pressure full avg10=${capacity.pressureFullAvg10}%`);
  if (capacity.oom !== null && capacity.oomKill !== null) {
    parts.push(`memory.events oom ${capacity.oom} oom_kill ${capacity.oomKill}`);
  }
  return parts.length === 0 ? 'no cgroup memory detail available' : parts.join(', ');
}

/**
 * Builds the refusal text. It names the headroom that was actually measured,
 * the threshold it failed, the readings behind both, and the escape hatch by
 * name and value, so an operator hitting it does not have to go looking for a
 * hidden flag.
 */
export function capacityRefusalMessage(
  decision: Pick<CapacityDecision, 'capacity' | 'thresholdBytes'>,
): string {
  const capacity = decision.capacity;
  const headroom = capacity.headroomBytes === null ? 'unknown' : formatBytes(capacity.headroomBytes);
  return [
    `refusing to launch managed agent: host memory headroom ${headroom} is below the required minimum ${formatBytes(decision.thresholdBytes)}`,
    `(${measuredDetail(capacity)})`,
    `Re-run with ${CAPACITY_OVERRIDE_ENV}=1 to launch anyway on operator request.`,
    'This is a feasibility guard only: nothing was killed, throttled, or reordered to make room, and the board queue was not touched.',
  ].join(' ');
}

/**
 * Decides whether a launch may proceed.
 *
 * `refused` only ever means one thing: a cgroup with a hard limit was read, its
 * headroom was measured, and that headroom is below the threshold. A host whose
 * limit could not be read degrades to `unknown` and proceeds with the stated
 * reason, because refusing a host we cannot model would make the guard
 * permanently unlaunchable rather than safer. Transient pressure with adequate
 * headroom is a `warning`, not a refusal, for the same reason.
 */
export function evaluateLaunchCapacity(
  capacity: HostCapacity,
  options: CapacityDecisionOptions = {},
): CapacityDecision {
  const env: Record<string, string | undefined> = options.env ?? process.env;
  const resolved = options.thresholdBytes === undefined
    ? resolveMinHeadroomBytes(env)
    : { bytes: options.thresholdBytes, configured: options.thresholdConfigured ?? true };
  const override = options.override ?? capacityOverrideRequested(env);
  const base = {
    capacity,
    thresholdBytes: resolved.bytes,
    thresholdConfigured: resolved.configured,
    overrideApplied: false,
  };

  if (capacity.source === 'degraded' || capacity.headroomBytes === null) {
    return {
      ...base,
      outcome: 'unknown',
      reason: capacity.reason ?? 'no cgroup memory limit could be read; headroom is not estimated',
    };
  }

  if (capacity.headroomBytes < resolved.bytes) {
    if (override) {
      return {
        ...base,
        overrideApplied: true,
        outcome: 'ok',
        reason: `host memory headroom ${formatBytes(capacity.headroomBytes)} is below the minimum ${formatBytes(resolved.bytes)}, but ${CAPACITY_OVERRIDE_ENV} was set, so the launch proceeds on operator request (${measuredDetail(capacity)})`,
      };
    }
    return { ...base, outcome: 'refused', reason: capacityRefusalMessage(base) };
  }

  if (capacity.pressureFullAvg10 !== null && capacity.pressureFullAvg10 >= PRESSURE_WARNING_AVG10) {
    return {
      ...base,
      outcome: 'warning',
      reason: `host memory headroom ${formatBytes(capacity.headroomBytes)} is above the minimum ${formatBytes(resolved.bytes)} but the cgroup is under transient memory pressure (pressure full avg10=${capacity.pressureFullAvg10}%, threshold ${PRESSURE_WARNING_AVG10}%); proceeding because refusing here would make a busy host unlaunchable`,
    };
  }

  return {
    ...base,
    outcome: 'ok',
    reason: `host memory headroom ${formatBytes(capacity.headroomBytes)} is at or above the minimum ${formatBytes(resolved.bytes)} (${measuredDetail(capacity)})`,
  };
}

/** Convenience wrapper: read the host, then decide, with one seam. */
export function checkHostLaunchCapacity(
  options: CapacityDecisionOptions & HostCapacityReadOptions = {},
): CapacityDecision {
  return evaluateLaunchCapacity(readHostCapacity(options), options);
}

export class HostCapacityRefusalError extends Error {
  readonly decision: CapacityDecision;

  constructor(decision: CapacityDecision) {
    super(decision.reason);
    this.name = 'HostCapacityRefusalError';
    this.decision = decision;
  }
}
