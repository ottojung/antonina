import {
  MalformedDaemonHostReportError,
  hostLiveness,
  parseDaemonHostReport,
  type DaemonHostReport,
  type HostLiveness,
} from '../../core/src/host-daemon.js';
import { DEFAULT_DAEMON_FS, hasCode, type DaemonFs } from './fs.js';
import type { DaemonPaths } from './identity.js';

/**
 * The host's published state: one report, at one path, in one directory.
 *
 * It is a single file written by rename rather than a log, because the only
 * question asked of it is "what did this host last say", and the newest answer
 * supersedes every older one. Nothing here appends to the board, and nothing
 * here is a board record: this is a host-local observation of a host, not a
 * fact the board signed.
 */

export class DaemonStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonStateError';
  }
}

export interface DaemonStateFsOptions {
  paths: DaemonPaths;
  fs?: DaemonFs;
}

function filesystem(options: { fs?: DaemonFs }): DaemonFs {
  return options.fs ?? DEFAULT_DAEMON_FS;
}

/**
 * The last report this host published, or `null` when it never has.
 *
 * A report that is present and unreadable is refused by path. Reporting the
 * host as offline because its own file is damaged would be indistinguishable
 * from reporting it offline because the daemon is gone, and those two want
 * opposite responses: one needs a human to look, the other needs a supervisor.
 */
export function readHostReport(options: DaemonStateFsOptions): DaemonHostReport | null {
  const fs = filesystem(options);
  let text: string;
  try {
    text = fs.readFileSync(options.paths.report, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw new DaemonStateError('could not read the host report at ' + options.paths.report, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DaemonStateError('the host report at ' + options.paths.report + ' is not valid JSON', { cause: error });
  }
  try {
    return parseDaemonHostReport(value);
  } catch (error) {
    if (error instanceof MalformedDaemonHostReportError) {
      throw new DaemonStateError(options.paths.report + ': ' + error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * Publishes a report.
 *
 * The write goes to a temporary file in the same directory and is renamed over
 * the report, so a reader either sees the whole previous report or the whole
 * new one. A reader must never find a half-written telemetry document and have
 * to decide whether the numbers in it are real.
 */
export function writeHostReport(report: DaemonHostReport, options: DaemonStateFsOptions): void {
  const fs = filesystem(options);
  fs.mkdirSync(options.paths.dir, { recursive: true });
  const temporary = options.paths.report + '.tmp';
  const text = JSON.stringify(report, null, 2) + '\n';
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, text);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, options.paths.report);
}

/** Removes a published report, so a stopped daemon leaves nothing claiming to be alive. */
export function clearHostReport(options: DaemonStateFsOptions): void {
  const fs = filesystem(options);
  try {
    fs.unlinkSync(options.paths.report);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw new DaemonStateError('could not remove the host report at ' + options.paths.report, { cause: error });
  }
}

export interface HostReportView {
  /** The last report, or `null` when this host has never published one. */
  readonly report: DaemonHostReport | null;
  readonly liveness: HostLiveness;
}

/** What a reader makes of the last report, given a clock and a staleness threshold. */
export function hostReportView(
  report: DaemonHostReport | null,
  options: { nowMs: number; staleAfterMs?: number },
): HostReportView {
  return { report, liveness: hostLiveness(report, options) };
}
