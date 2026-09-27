import {
  DEFAULT_STALE_AFTER_MS,
  type DaemonHostReport,
  type HostBytesMeasurement,
} from '../../core/src/host-daemon.js';
import {
  DaemonConfigError,
  loadDaemonConfig,
  type DaemonConfig,
} from '../../host-daemon/src/config.js';
import type { DaemonFs } from '../../host-daemon/src/fs.js';
import {
  daemonPaths,
  resolveHostIdentity,
  type DaemonPaths,
} from '../../host-daemon/src/identity.js';
import { daemonLockVerdict, readDaemonLock } from '../../host-daemon/src/lock.js';
import { hostReportView, readHostReport } from '../../host-daemon/src/state.js';
import { startDaemon } from '../../host-daemon/src/service.js';

/**
 * `antonina daemon ...`: the operator-facing adapter.
 *
 * It parses, prints and wires signals, and it decides nothing. Identity,
 * telemetry, liveness and the published state are all owned by
 * `packages/host-daemon` and modelled in `packages/core`, so a board view never
 * has to reach a second implementation of any of it.
 *
 * The daemon is a foreground process that is meant to be supervised by the
 * host it runs on -- a systemd unit, a launchd plist, or whatever the operator
 * already uses for long-lived processes. Detaching into the background from
 * here would make a host's most persistent process the one process with no
 * supervisor, no exit status and no restart policy.
 */

export interface DaemonCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface DaemonCommandContext {
  env: Record<string, string | undefined>;
  io: DaemonCommandIo;
  /** Injected by tests so no command can reach the ambient `$HOME`. */
  home?: string;
  fs?: DaemonFs;
  /** Injected clock, so a command's liveness output is a function of its input. */
  now?: () => number;
  procRoot?: string;
  signal?: (pid: number, signal: NodeJS.Signals | number) => boolean;
}

function pathsFor(context: DaemonCommandContext): DaemonPaths {
  return daemonPaths({
    env: context.env,
    ...(context.home === undefined ? {} : { home: context.home }),
    ...(context.fs === undefined ? {} : { fs: context.fs }),
  });
}

function configFor(context: DaemonCommandContext): DaemonConfig {
  return loadDaemonConfig({
    env: context.env,
    ...(context.home === undefined ? {} : { home: context.home }),
    ...(context.fs === undefined ? {} : { fs: context.fs }),
  });
}

function bytes(megabytes: number): string {
  return megabytes + ' MiB';
}

function renderMeasurement(measurement: HostBytesMeasurement): string {
  return measurement.ok
    ? bytes(Math.round(measurement.bytes / (1024 * 1024)))
    : 'unavailable (' + measurement.reason + ')';
}

function renderReport(report: DaemonHostReport | null, livenessReason: string): string[] {
  if (report === null) return ['offline: ' + livenessReason];
  const lines = [
    'host: ' + report.hostId,
    'address: ' + (report.address ?? '(none)'),
    'health: ' + report.health,
    'observed at: ' + report.observedAt,
    'heartbeats: ' + report.heartbeatCount,
    'daemon: pid ' + report.daemon.pid + ' since ' + report.daemon.startedAt + ' (v' + report.daemon.version + ')',
    'liveness: ' + livenessReason,
    'uptime: ' + (report.telemetry.uptimeSeconds === null ? 'unavailable' : Math.round(report.telemetry.uptimeSeconds) + 's'),
    'memory: ' + renderMeasurement(report.telemetry.memory.total) + ' total, '
      + renderMeasurement(report.telemetry.memory.available) + ' available',
    'cpu: ' + (report.telemetry.cpu.logicalCores === null ? 'cores unavailable' : report.telemetry.cpu.logicalCores + ' cores')
      + (report.telemetry.cpu.model === null ? '' : ' (' + report.telemetry.cpu.model + ')')
      + (report.telemetry.cpu.loadAverage === null ? '' : ' load ' + report.telemetry.cpu.loadAverage.join('/')),
  ];
  for (const filesystem of report.telemetry.filesystems) {
    lines.push('filesystem ' + filesystem.path + ': ' + renderMeasurement(filesystem.total)
      + ' total, ' + renderMeasurement(filesystem.available) + ' available');
  }
  for (const problem of report.telemetry.problems) lines.push('problem: ' + problem);
  return lines;
}

interface StatusView {
  readonly hostId: string | null;
  readonly address: string | null;
  readonly report: DaemonHostReport | null;
  readonly liveness: { status: string; ageMs: number | null; reason: string };
  readonly lock: { held: boolean; reason: string };
}

/** Everything `status` reports, as data, so the JSON form and the text form are one reading. */
function statusView(context: DaemonCommandContext, config: DaemonConfig): StatusView {
  const paths = pathsFor(context);
  const nowMs = (context.now ?? Date.now)();
  const report = readHostReport({ paths, ...(context.fs === undefined ? {} : { fs: context.fs }) });
  const view = hostReportView(report, { nowMs, staleAfterMs: config.staleAfterMs });
  const verdict = daemonLockVerdict(readDaemonLock({ paths, ...(context.fs === undefined ? {} : { fs: context.fs }) }), {
    paths,
    ...(context.fs === undefined ? {} : { fs: context.fs }),
    ...(context.procRoot === undefined ? {} : { procRoot: context.procRoot }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const identity = resolveHostIdentity({
    config,
    identityPath: paths.identity,
    ...(context.fs === undefined ? {} : { fs: context.fs }),
  });
  return {
    hostId: identity.hostId,
    address: report?.address ?? config.address ?? 'lubko://' + identity.hostId,
    report,
    liveness: view.liveness,
    lock: { held: verdict.heldBy !== null, reason: verdict.reason },
  };
}

/**
 * Host telemetry is not a board record, so this output is plain JSON rather
 * than the canonical form the signed board log uses: a load average of 0.1 is a
 * real reading, and rounding it to make a number canonical would be a lie about
 * the host.
 */
function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function runStatus(args: string[], context: DaemonCommandContext): number {
  const json = args.includes('--json');
  const config = configFor(context);
  const view = statusView(context, config);
  if (json) {
    context.io.stdout(jsonText(view));
    return 0;
  }
  for (const line of renderReport(view.report, view.liveness.reason)) context.io.stdout(line);
  context.io.stdout('daemon lock: ' + (view.lock.held ? 'held' : 'free') + ' (' + view.lock.reason + ')');
  return 0;
}

function runIdentity(args: string[], context: DaemonCommandContext): number {
  const json = args.includes('--json');
  const config = configFor(context);
  const paths = pathsFor(context);
  const identity = resolveHostIdentity({
    config,
    identityPath: paths.identity,
    ...(context.fs === undefined ? {} : { fs: context.fs }),
  });
  const document = {
    hostId: identity.hostId,
    source: identity.source,
    address: config.address ?? 'lubko://' + identity.hostId,
  };
  if (json) {
    context.io.stdout(jsonText(document));
    return 0;
  }
  context.io.stdout('host: ' + document.hostId);
  context.io.stdout('derived from: ' + document.source);
  context.io.stdout('address: ' + document.address);
  return 0;
}

function usage(io: DaemonCommandIo): void {
  io.stderr(
    'usage: antonina daemon <identity|status|start> [--json]\n'
      + '  identity  print the stable identity this host answers to\n'
      + '  status    print the last published report and whether it is fresh\n'
      + '  start     run the daemon in the foreground until it is signalled\n',
  );
}

/**
 * Runs the daemon until it is signalled, then converges.
 *
 * SIGINT and SIGTERM both mean "stop publishing", and both are handled here
 * rather than left to the default disposition, so a supervisor's stop always
 * leaves a host that reads as offline instead of one that reads as online until
 * its report goes stale.
 */
function runStart(args: string[], context: DaemonCommandContext): Promise<number> {
  const config = configFor(context);
  const handle = startDaemon({
    config,
    env: context.env,
    ...(context.home === undefined ? {} : { home: context.home }),
    ...(context.fs === undefined ? {} : { fs: context.fs }),
    ...(context.now === undefined ? {} : { now: context.now }),
    ...(context.procRoot === undefined ? {} : { procRoot: context.procRoot }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const first = handle.lastReport();
  context.io.stdout('antonina daemon: reporting host ' + handle.hostId + ' at ' + handle.address
    + ' every ' + config.heartbeatIntervalMs + 'ms'
    + (first === null ? '' : ' (' + first.telemetry.problems.length + ' telemetry problem(s))'));
  return new Promise<number>((resolve) => {
    const finish = (): void => {
      void handle.stop().then(() => {
        context.io.stdout('antonina daemon: stopped for host ' + handle.hostId);
        resolve(0);
      });
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

export async function runDaemonCommand(argv: string[], context: DaemonCommandContext): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === 'status') return runStatus(args, context);
    if (command === 'identity') return runIdentity(args, context);
    if (command === 'start') return await runStart(args, context);
    if (command === undefined || command === '--help' || command === 'help') {
      usage(context.io);
      return command === undefined ? 2 : 0;
    }
    usage(context.io);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.io.stderr('antonina daemon: ' + message);
    if (error instanceof DaemonConfigError) {
      context.io.stderr('antonina daemon: configure the host in $XDG_CONFIG_HOME/antonina/daemon.json');
    }
    return 1;
  }
}
