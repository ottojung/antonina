import type { DaemonHostView, HostBytesMeasurement } from './api';
import { executionTargetAccess, type BoardExecutionTarget, type ExecutionTargetAccess } from './api';
import type { TargetView } from './api';

/**
 * The words the execution-target overview uses, kept out of the component so
 * they can be asserted on directly and so a reviewer can read every claim the
 * page makes in one place.
 *
 * Two rules govern all of it. A target that cannot report something says so in
 * its own words — `unknown` with a reason, or `not applicable` — and never
 * shows a number that was invented to fill the gap. And the two kinds of target
 * are not drawn as two versions of a machine: an ephemeral environment is shown
 * what is true of it, which is mostly that the host-shaped questions have no
 * answer, because the reasons are what keep a reader from scheduling against a
 * figure nobody measured.
 */

export const TARGETS_EMPTY = {
  title: 'No execution targets registered',
  body: 'A target is an environment a job may be dispatched to. Register one with `antonina board target add` before dispatching work.',
} as const;

export const TARGETS_HINT = 'A target is an environment a job may run on, not a durable resource. A persistent host keeps a filesystem between jobs; an ephemeral environment is gone when its job ends.';

export const TARGET_ACCESS_LABEL: { readonly [M in ExecutionTargetAccess['accessMethod']]: string } = {
  'lubko-transport': 'Lubko transport',
  'github-workflow-dispatch': 'GitHub Actions workflow dispatch',
};

export const TARGET_PERSISTENCE_LABEL: { readonly [P in ExecutionTargetAccess['persistence']]: string } = {
  'durable-host-filesystem': 'Durable — the filesystem survives the job',
  'per-job-workspace': 'Per job — the workspace is destroyed with the job',
};

export const TARGET_CLEANUP_LABEL: { readonly [G in ExecutionTargetAccess['garbageCollection']]: string } = {
  'host-local-collector': 'Host-local collector, by hand, with --confirm',
  'provider-managed': 'The provider expires it; Antonina has no part in it',
  none: 'Nothing removes it',
};

export const TARGET_KIND_LABEL: { readonly [K in ExecutionTargetAccess['kind']]: string } = {
  'persistent-host': 'Persistent host',
  'ephemeral-environment': 'Ephemeral environment',
};

export const TARGET_STATUS_LABEL: { readonly [S in ExecutionTargetAccess['status']]: string } = {
  available: 'Available',
  unavailable: 'Unavailable — refused by name, not routed around',
};

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** A byte count at a scale a person can read, with the exact count kept beside it. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
  return (unit === 0 ? String(value) : value.toFixed(1)) + ' ' + BYTE_UNITS[unit];
}

/** A reported measurement, or the reason it is absent. A missing measurement is never a zero. */
export function formatBytesMeasurement(measurement: HostBytesMeasurement): string {
  return measurement.ok
    ? formatBytes(measurement.bytes)
    : 'unknown (' + measurement.reason + ')';
}

/**
 * The live state of one target, as a small set of named lines.
 *
 * Every line is either a measurement the host itself published or a statement
 * that the measurement does not exist. The distinction the two words carry is
 * the point: `unknown` means Antonina does not know and something could report
 * it, while `not applicable` means the question has no answer for this kind of
 * target at all, and no future integration would produce one.
 */
export interface TargetStateLine {
  label: string;
  value: string;
  /** Rendered as the page's muted unknown state rather than as a measurement. */
  absent: boolean;
  /** Why the value is absent, in the page's own words. */
  reason?: string;
}

/** A line stating that a value is not knowable here, rather than a value of zero. */
function absentLine(label: string, value: string, reason: string): TargetStateLine {
  return { label, value, absent: true, reason };
}

/** The live state of an ephemeral environment: a host-shaped question with no host answer. */
export function ephemeralStateLines(): TargetStateLine[] {
  return [
    absentLine('Capacity', 'not applicable',
      'An ephemeral environment has no host RAM, disk or CPU of its own. A runner reports what the job asked for, not what the machine has.'),
    absentLine('Host telemetry', 'not applicable',
      'No Antonina daemon runs on the provider, so there is no host report to read here.'),
    absentLine('Provider quota', 'unknown',
      'Antonina holds no integration that reads a provider account quota. Read it from the provider before a burst of jobs.'),
  ];
}

/**
 * The live state of a persistent host, from the daemon report when there is one
 * and from an explicit statement when there is not.
 *
 * A persistent host with no report is a real and common state: the daemon is
 * optional. It is rendered as `unknown` with the reason, never as a host with
 * no memory, and a report that is present but stale still says how stale.
 */
export function hostStateLines(host: DaemonHostView | undefined): TargetStateLine[] {
  if (host === undefined) {
    return [
      absentLine('Host telemetry', 'unknown',
        'No host-local daemon report reached this page. A host reports capacity only while its Antonina daemon is running, and this browser cannot read a host filesystem at all.'),
    ];
  }
  const lines: TargetStateLine[] = [{
    // Liveness is a property of how old the last report is and of nothing else,
    // so it is shown next to the host it belongs to rather than folded into the
    // daemon's own health: a healthy daemon reporting late and a daemon that has
    // stopped are different states with the same health word.
    label: 'Host',
    value: host.hostId + ' · ' + host.liveness.status,
    absent: host.liveness.status !== 'online',
    reason: host.liveness.reason,
  }, {
    label: 'Daemon health',
    value: host.health === null ? 'unknown (never reported)' : host.health,
    absent: host.health === null,
    ...(host.observedAt === null ? {} : { reason: 'last report at ' + host.observedAt }),
  }];
  if (host.telemetry === null) {
    return [...lines, absentLine('Capacity', 'unknown', 'The last report carried no telemetry.')];
  }
  const telemetry = host.telemetry;
  lines.push({
    label: 'Memory',
    value: formatBytesMeasurement(telemetry.memory.available) + ' free of ' + formatBytesMeasurement(telemetry.memory.total),
    absent: !telemetry.memory.available.ok || !telemetry.memory.total.ok,
  });
  for (const filesystem of telemetry.filesystems) {
    lines.push({
      label: 'Filesystem ' + filesystem.path,
      value: formatBytesMeasurement(filesystem.available) + ' free of ' + formatBytesMeasurement(filesystem.total),
      absent: !filesystem.available.ok || !filesystem.total.ok,
    });
  }
  lines.push({
    label: 'CPU',
    value: telemetry.cpu.logicalCores === null
      ? 'unknown (cores not reported)'
      : telemetry.cpu.logicalCores + ' logical cores'
        + (telemetry.cpu.model === null ? '' : ' · ' + telemetry.cpu.model),
    absent: telemetry.cpu.logicalCores === null,
  });
  lines.push({
    label: 'Load average',
    value: telemetry.cpu.loadAverage === null ? 'unknown (not reported on this platform)' : telemetry.cpu.loadAverage.join(' / '),
    absent: telemetry.cpu.loadAverage === null,
  });
  lines.push({
    label: 'Provider quota',
    value: 'not applicable',
    absent: true,
    reason: 'A persistent host is not a metered external execution service, so there is no account quota to read.',
  });
  if (telemetry.problems.length > 0) {
    lines.push({ label: 'Report problems', value: telemetry.problems.join(', '), absent: false });
  }
  return lines;
}

/** The live state of one catalogued target, from the host view related to it. */
export function targetStateLines(
  target: BoardExecutionTarget,
  hosts: readonly DaemonHostView[],
): TargetStateLine[] {
  if (target.kind !== 'persistent-host') return ephemeralStateLines();
  const host = hosts.find((entry) => entry.targetId === target.id
    || (target.address !== null && entry.address === target.address));
  return hostStateLines(host);
}

/** The catalog, ordered as the board ordered it, with each target's own view of itself. */
export function targetCatalogRows(
  targets: readonly TargetView[],
  hosts: readonly DaemonHostView[],
): { target: TargetView; access: ExecutionTargetAccess; state: TargetStateLine[] }[] {
  return targets.map((target) => ({
    target,
    access: executionTargetAccess(target),
    state: targetStateLines(target, hosts),
  }));
}
