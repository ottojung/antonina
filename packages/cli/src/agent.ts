import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

import {
  backendCapabilities,
  configuredModelAvailable,
  describeSignalDeath,
  discoverSessionId,
  sanitizeBackendError,
} from '../../agent-runtime/src/backend.js';
import {
  beginInvocation,
  beginStopLike,
  currentProcessStartTicks,
  deriveState,
  exitCodeFor,
  finalizeTerminal,
  invocationAlive,
  queueSteer,
  reconcileDeadMeta,
  reservationInFlight,
  runnerAlive,
  setActiveRunner,
  signalInvocation,
  signalRunner,
  steerQueue,
  steerSequence,
  waitForInvocationGone,
} from '../../agent-runtime/src/lifecycle.js';
import {
  AgentForkSourceMissingError,
  forkAgent,
} from '../../agent-runtime/src/fork.js';
import {
  formatBytes,
  readHostCapacity,
  type HostCapacity,
} from '../../agent-runtime/src/host-capacity.js';
import {
  LAUNCH_DIRECTORY_MISSING,
  TERMINAL_STATES,
  activeRunnerFlag,
  deletePendingFlag,
  idleMeta,
  nextPromptCount,
  pendingPrompt,
  persistedAgentCwd,
  persistedControlField,
  persistedInvocationCwd,
  persistedLifecycleState,
  persistedNativeSessionId,
  persistedTimestamp,
  persistedVariant,
  requiredPersistedAgentId,
  runnerGeneration,
  runnerReservationMode,
  runnerReservationState,
  type AgentMetadata,
} from '../../agent-runtime/src/metadata.js';
import { normalizeAgentId } from '../../agent-runtime/src/process.js';
import {
  agentDir,
  agentsDir,
  createAgentDirectory,
  logPath,
  readMeta,
  removeAgentDirectory,
  updateMeta,
  writeMeta,
  type StatePathsOptions,
  type StoreFs,
} from '../../agent-runtime/src/store.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_TIMEOUT = 124;
const DEFAULT_RETENTION_DAYS = 14;

export interface AgentCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
  stdoutRaw?(text: string): void;
}

export interface AgentCommandContext {
  env: Record<string, string | undefined>;
  cwd: string;
  io: AgentCommandIo;
  home?: string;
  entryScript?: string;
  storeFs?: StoreFs;
}

interface Parsed {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function paths(context: AgentCommandContext): StatePathsOptions {
  return {
    env: context.env,
    ...(context.home === undefined ? {} : { home: context.home }),
    ...(context.storeFs === undefined ? {} : { fs: context.storeFs }),
  };
}

function parse(argv: string[], booleanFlags: readonly string[] = []): Parsed {
  const flags = new Set(booleanFlags);
  const result: Parsed = { positionals: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (!arg.startsWith('--')) {
      result.positionals.push(arg);
      continue;
    }
    if (flags.has(arg)) {
      result.flags.add(arg);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    result.values.set(arg, value);
    index += 1;
  }
  return result;
}

function positiveInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function requireAgentId(raw: string | undefined, command: string): string {
  const agentId = normalizeAgentId(raw);
  if (agentId === null) throw new UsageError(`${command}: --id is required and must be a base-16 string`);
  return agentId;
}

class UsageError extends Error {}
class NotFoundError extends Error {}

function requireMeta(agentId: string, context: AgentCommandContext): AgentMetadata {
  const meta = readMeta(agentId, paths(context));
  if (meta === null) throw new NotFoundError(`unknown agent: ${agentId}`);
  return meta;
}

async function reconcileAgent(agentId: string, context: AgentCommandContext): Promise<AgentMetadata | null> {
  const observed = readMeta(agentId, paths(context));
  if (observed === null) return null;
  if (persistedLifecycleState(observed) !== 'running') return observed;
  if (!reconcileDeadMeta(observed)) return observed;
  return updateMeta(agentId, (meta) => { reconcileDeadMeta(meta); }, paths(context));
}

function agentIds(context: AgentCommandContext): string[] {
  try {
    return readdirSync(agentsDir(paths(context)), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalTimestamp(meta: AgentMetadata, field: string, nullable: boolean): number | null {
  const raw = meta[field];
  if (nullable && raw === null) return null;
  const value = persistedTimestamp(raw);
  if (value === null) throw new Error(`canonical metadata invariant violated at ${field}`);
  return value;
}

function summary(meta: AgentMetadata): {
  created_at: number;
  last_activity_at: number;
  finished_at: number | null;
  prompts: number;
  cwd: string | null;
  invocation_cwd: string | null;
  title: string | null;
} {
  return {
    created_at: canonicalTimestamp(meta, 'created_at', false)!,
    last_activity_at: canonicalTimestamp(meta, 'last_activity_at', false)!,
    finished_at: canonicalTimestamp(meta, 'finished_at', true),
    prompts: meta.prompt_count as number,
    // `cwd` is the declared default for invocations that name no directory of
    // their own; `invocation_cwd` is the directory the current or most recent
    // invocation was launched in. Board issue 178: reporting only the
    // declaration made `status` a statement about intent dressed as a location.
    cwd: persistedAgentCwd(meta),
    invocation_cwd: persistedInvocationCwd(meta),
    title: meta.title as string | null,
  };
}

function listEntryJson(agentId: string, state: string, item: ReturnType<typeof summary>): Record<string, unknown> {
  return {
    id: agentId,
    state,
    prompts: item.prompts,
    cwd: item.cwd,
    invocation_cwd: item.invocation_cwd,
    title: item.title,
    created_at: item.created_at,
    last_activity_at: item.last_activity_at,
    finished_at: item.finished_at,
  };
}

function humanAge(epoch: number | null): string {
  if (epoch === null) return '-';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function matchesFilters(parsed: Parsed, state: string): boolean {
  if (parsed.flags.has('--running') && state !== 'running') return false;
  if (parsed.flags.has('--finished') && !(TERMINAL_STATES as readonly string[]).includes(state)) return false;
  for (const terminal of TERMINAL_STATES) {
    if (parsed.flags.has(`--${terminal}`) && state !== terminal) return false;
  }
  return true;
}

/**
 * A working directory an operator declared, resolved and checked to be an
 * existing directory. Both `new` and `run` declare one, and both refuse a bad
 * one before any state is written.
 *
 * A path that is not an existing directory is a *usage* error, not a state
 * conflict: the command named a value that cannot mean anything, and no record
 * was read to find out so. Board issue 178 moved this from exit 1 to exit 2 for
 * that reason, and it applies to `new` and `run` alike.
 */
function declaredCwd(raw: string, command: string): string {
  const cwd = resolve(raw);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new UsageError(`${command}: working directory does not exist: ${cwd}`);
  }
  return cwd;
}

async function cmdNew(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--json']);
  if (parsed.positionals.length !== 0) throw new UsageError('new: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'new');
  if (parsed.values.has('--fork')) {
    return await cmdFork(parsed.values.get('--fork')!, agentId, parsed, context);
  }
  // A front is not created in whatever directory happened to invoke this
  // command. With no `--cwd` the agent records no working directory at all, and
  // `run` then refuses to launch it until one is declared, rather than
  // inheriting one and reporting it as the front's location.
  const cwd = parsed.values.has('--cwd') ? declaredCwd(parsed.values.get('--cwd')!, 'new') : null;
  if (!createAgentDirectory(agentId, paths(context))) throw new Error(`new: agent ${agentId} already exists`);
  const meta = idleMeta(agentId, cwd, parsed.values.get('--title') ?? null);
  try {
    writeMeta(agentId, meta, paths(context));
  } catch (error) {
    removeAgentDirectory(agentId, paths(context));
    throw error;
  }
  if (parsed.flags.has('--json')) {
    context.io.stdout(stableJson({ id: agentId, state: 'idle', cwd, created_at: meta.created_at }));
  } else {
    context.io.stdout(
      cwd === null
        ? `Created agent with id ${agentId} (idle, no declared working directory). Declare one with \`antonina agent run --id ${agentId} --cwd /absolute/path --prompt 'task'\`.`
        : `Created agent with id ${agentId} (idle). Start work with \`antonina agent run --id ${agentId} --prompt 'task'\`.`,
    );
  }
  return EXIT_OK;
}

/**
 * `agent new --id <NEW> --fork <OLD>`: a snapshot of an existing agent.
 *
 * The clone gets the source's persisted work identity -- declared cwd, title,
 * variant, native session, prompt history and terminal outcome -- and its own
 * id, its own record and its own lifecycle state, with no process, runner,
 * reservation, accepted prompt or queued steer inherited. It is a snapshot, not
 * a link: nothing in the product reads the source in order to update the clone,
 * or the clone in order to update the source, and the two never share a file.
 *
 * A source that is currently running is forkable, and that is the case the
 * feature exists for: because the clone names no process, no control command
 * can reach the source through it. The clone does inherit the source's
 * `native_session_id`, so the two agents share one backend conversation by
 * design; the operator is told so.
 *
 * `--cwd` and `--title` are refused here rather than silently ignored. They
 * describe a fresh front's own declaration, and letting them apply to a fork
 * would leave an operator believing they had named the clone's directory when
 * the record says the source's.
 */
async function cmdFork(
  raw: string,
  agentId: string,
  parsed: Parsed,
  context: AgentCommandContext,
): Promise<number> {
  const sourceId = normalizeAgentId(raw);
  if (sourceId === null) throw new UsageError('new: --fork must be a base-16 managed-agent id');
  if (sourceId === agentId) throw new UsageError('new: --fork source and --id must be different agents');
  if (parsed.values.has('--cwd')) throw new UsageError('new: --cwd cannot be combined with --fork');
  if (parsed.values.has('--title')) throw new UsageError('new: --title cannot be combined with --fork');
  let meta: AgentMetadata;
  try {
    meta = forkAgent(sourceId, agentId, paths(context));
  } catch (error) {
    // A source that does not exist is a lookup failure, not a crash, and gets
    // the same exit code every other unknown-id path in this file returns.
    if (error instanceof AgentForkSourceMissingError) throw new NotFoundError(error.message);
    throw error;
  }
  if (parsed.flags.has('--json')) {
    context.io.stdout(stableJson({
      id: agentId,
      forked_from: sourceId,
      state: persistedLifecycleState(meta),
      cwd: persistedAgentCwd(meta),
      title: meta.title as string | null,
      native_session_id: persistedNativeSessionId(meta),
      prompts: meta.prompt_count as number,
      created_at: meta.created_at,
    }));
  } else {
    const cwd = persistedAgentCwd(meta);
    context.io.stdout(
      `Forked agent ${sourceId} into ${agentId} (state ${String(persistedLifecycleState(meta))}, ${String(meta.prompt_count)} prompts, ${cwd === null ? 'no declared working directory' : cwd}). `
      + `The clone inherits the source's backend session, and apart from that session the two records are independent: neither is ever read in order to update the other. `
      + `They share one backend session, so running both will drive the same conversation. `
      + `Start work with \`antonina agent run --id ${agentId} --prompt 'task'\`.`,
    );
  }
  return EXIT_OK;
}

async function cmdList(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--json', '--running', '--finished', '--succeeded', '--failed', '--stopped', '--killed']);
  if (parsed.positionals.length !== 0) throw new UsageError('list: unexpected positional arguments');
  const pageSize = parsed.values.has('--limit')
    ? positiveInteger(parsed.values.get('--limit'), '--limit')
    : 50;
  if (!parsed.values.has('--page')) throw new UsageError('list: --page is required');
  const page = positiveInteger(parsed.values.get('--page'), '--page');
  const entries: Array<{ agentId: string; meta: AgentMetadata; state: string; summary: ReturnType<typeof summary> }> = [];
  for (const agentId of agentIds(context)) {
    const meta = await reconcileAgent(agentId, context);
    if (meta === null) continue;
    const state = deriveState(meta);
    if (!matchesFilters(parsed, state)) continue;
    entries.push({ agentId, meta, state, summary: summary(meta) });
  }
  entries.sort((left, right) => right.summary.created_at - left.summary.created_at);
  const start = (page - 1) * pageSize;
  const selected = Number.isSafeInteger(start) ? entries.slice(start, start + pageSize) : [];
  if (parsed.flags.has('--json')) {
    context.io.stdout(stableJson({
      agents: selected.map(({ agentId, state, summary: item }) => listEntryJson(agentId, state, item)),
    }));
  } else if (selected.length === 0) {
    context.io.stdout('(no agents)');
  } else {
    context.io.stdout('ID  STATE  P  AGE  CWD  TITLE');
    for (const entry of selected) {
      context.io.stdout([
        entry.agentId,
        entry.state,
        entry.summary.prompts,
        humanAge(entry.summary.created_at),
        entry.summary.cwd ?? 'undeclared',
        (entry.summary.title ?? '').replace(/\n/g, ' '),
      ].join('  '));
    }
  }
  return EXIT_OK;
}

/**
 * Host memory as an observation, for an operator diagnosing a dead agent. It
 * reports what the kernel said and nothing more: there is no outcome, no
 * threshold and no refusal here, because Antonina does not decide whether a
 * host has room to launch.
 */
function hostCapacityJson(capacity: HostCapacity): Record<string, unknown> {
  return {
    source: capacity.source,
    cgroup_path: capacity.cgroupPath,
    limit_bytes: capacity.limitBytes,
    usage_bytes: capacity.usageBytes,
    headroom_bytes: capacity.headroomBytes,
    headroom: formatBytes(capacity.headroomBytes),
    pressure_full_avg10: capacity.pressureFullAvg10,
    oom: capacity.oom,
    oom_kill: capacity.oomKill,
    degraded_reason: capacity.degradedReason,
  };
}

/**
 * Board issue 166: the recorded death note (`meta.error`) is surfaced here.
 *
 * This is a visibility change only. Nothing in the runtime's recording is
 * altered: which states carry a note, and which note, is decided entirely by
 * `finalizeTerminal`'s callers in `packages/agent-runtime`, which this file does
 * not touch. Issue 167 is a separate question about *which* states record a
 * note, and nothing below answers it.
 *
 * ## Why the note cannot simply be printed
 *
 * `meta.error` is free text, and `sanitizeBackendError` — the discipline this
 * change is required to follow — cannot be applied to it: that function accepts
 * a structured `BackendError` record and returns `null` for anything that is
 * not one, so handing it a string would yield `null` unconditionally and the
 * note would never appear. The note needs its own sanitiser, and it needs one
 * with the same shape as the existing one: validate, and substitute a neutral
 * description for anything not positively known to be safe. Never scrub by
 * removing suspicious substrings.
 *
 * The reason this is an allowlist rather than a pattern is that on this head the
 * note is not guaranteed to be operator-safe. The producers are not all in one
 * file: on this head `finalizeTerminal` receives a note from seven call sites in
 * `packages/agent-runtime/src/runner.ts` and one in
 * `packages/agent-runtime/src/lifecycle.ts` (see the enumeration below). Two of
 * the eight are free text, and one of those — the `spawn(...)` failure path,
 * which records `String(error)` — can carry whatever Node put in the spawn
 * error, including the resolved absolute path of the backend executable. A
 * denylist cannot be shown not to leak a credential; an allowlist of exactly the
 * sentences this repository itself writes can.
 *
 * A note is displayed only when it is *byte-identical* to one of:
 *
 *   - the fixed literals passed to `finalizeTerminal` on this head, each of which
 *     is a constant in its own source file and contains no interpolation, so
 *     equality is proof rather than a guess. Six of the eight note-passing call
 *     sites write such a literal, and `DISPLAYABLE_AGENT_ERRORS` below carries
 *     all six: four from `runner.ts` and two more, one of them from
 *     `lifecycle.ts`, which is why that file is named here rather than only
 *     `runner.ts`;
 *   - `describeSignalDeath(sanitizeBackendError(meta.backend_error))`, which is
 *     the sentence the runtime itself generates for a signal death from bounded
 *     integers and an OS signal name, and which already went through
 *     `sanitizeBackendError`'s field-by-field validation.
 *
 * The complete enumeration of the eight note-passing call sites on this head,
 * found by grepping `finalizeTerminal` across the `packages` sources and then
 * reading each site:
 *
 *   | site | note | displayed? |
 *   | --- | --- | --- |
 *   | `runner.ts:244` `releaseUnrecordedSpawn` | fixed literal | yes |
 *   | `runner.ts:313` `finalizeInvocation` | `describeSignalDeath(death)` | via the derivation branch |
 *   | `runner.ts:347` `buildAgentCommand` threw | `error.message` | no — free text |
 *   | `runner.ts:354` no underlying session | fixed literal | yes |
 *   | `runner.ts:387` `spawn(...)` threw | `String(error)` | no — can carry the resolved executable path |
 *   | `runner.ts:396` no pid | fixed literal | yes |
 *   | `runner.ts:423` no `/proc` identity | fixed literal | yes |
 *   | `lifecycle.ts:250` `reconcileDeadMeta` | fixed literal | yes |
 *
 * The two `finalizeTerminal` call sites that pass *no* note
 * (`packages/cli/src/agent.ts`, the `stop` and `kill` paths) are not producers
 * and appear nowhere above.
 *
 * Anything else is reported as withheld. That is deliberately visible rather
 * than silent: an operator who sees "a note is recorded but is not displayable"
 * learns that the record exists and that the display declines to quote it, which
 * is the honest report. A note from a producer added later will not be quoted
 * until it is added to `DISPLAYABLE_AGENT_ERRORS` here — the cost of that
 * conservatism is deliberate and is recorded on the issue.
 */
const DISPLAYABLE_AGENT_ERRORS: readonly string[] = [
  // runner.ts: the spawn identity could not be persisted, so the process was
  // killed and never recorded.
  'could not persist the spawned OpenCode process identity; the process was killed and never recorded',
  // runner.ts: a continuation was requested with no underlying session.
  'cannot continue: underlying session not available',
  // runner.ts: the backend process produced no pid.
  'OpenCode process had no pid',
  // runner.ts: /proc identity could not be established for a live process.
  'could not establish canonical OpenCode process identity',
  // runner.ts: the directory this invocation was launched in no longer exists.
  // Board issue 178. Matched as a fixed-literal prefix followed by the offending
  // path: the prefix is the constant this repository writes and the path is the
  // operator's own `--cwd`, so the whole note is a composition of a known
  // sentence and a value the operator already supplied.
  `${LAUNCH_DIRECTORY_MISSING}: `,
  // lifecycle.ts: `reconcileDeadMeta` found a `running` record whose process is
  // gone with no captured exit status. Reached from `agent status` and
  // `agent list`, so it is an ordinary sight, not a corner case.
  'runner/model process disappeared without a captured exit status',
];

/**
 * What `agent status` says in place of a recorded note it will not quote.
 *
 * Named rather than empty so that "no note was recorded" and "a note was
 * recorded and withheld" stay distinguishable in both output forms.
 */
export const AGENT_ERROR_WITHHELD = 'a note is recorded but is not displayable here';

/**
 * The note to display for a managed agent, or `null` when there is nothing to
 * display.
 *
 * `null` means no note was recorded. A note that was recorded but is not
 * displayable returns {@link AGENT_ERROR_WITHHELD} instead, so that "nothing was
 * recorded" and "something was recorded and the display declines to quote it"
 * stay distinguishable in both output forms.
 *
 * ## Freshness: this function is deliberately state-blind
 *
 * `finalizeTerminal` writes `meta.error` conditionally and never clears it
 * (`packages/agent-runtime/src/lifecycle.ts`, `if (note) meta.error = note;`),
 * and a clean exit passes no note. So the note belongs to *a* run, not
 * necessarily to the run the current state describes: an agent that failed once
 * and then succeeded still carries the first run's note. Both surfaces say so
 * where they print it -- the JSON key is `last_error`, the human line reads
 * `last error:` -- rather than gating on the state, because:
 *
 *  - gating the display on `failed` would hide a note the runtime genuinely
 *    recorded, and would bake the "which states carry a meaningful note"
 *    question -- a recording policy, and board issue 167's, not this issue's --
 *    into a display function;
 *  - clearing `meta.error` when no note is passed would make a state record less
 *    than it does today, which is exactly what a visibility change must not do.
 *
 * Both of those were available and both were rejected on those grounds. What this
 * function does is state-blind on purpose: it answers "what did the runtime last
 * record?", never "why did this run end?".
 *
 * One consequence, observed rather than assumed. A later run *replaces*
 * `meta.backend_error` (`finalizeInvocation` assigns it on every terminal run),
 * so a note inherited from an earlier run stops matching a sentence derived from
 * the record it now sits in and falls through to {@link AGENT_ERROR_WITHHELD}.
 * That is the allowlist working, and it is the truthful answer: the note really
 * is no longer derivable, and the marker discloses nothing about which run wrote
 * it. It is also why the surfaces must not call the value `error` -- under
 * `exit code: 0` that word would be a false statement about the current run,
 * and the note beside it is not even quotable.
 */
export function displayableAgentError(meta: AgentMetadata): string | null {
  const note = meta.error;
  if (typeof note !== 'string' || note.length === 0) return null;
  if (DISPLAYABLE_AGENT_ERRORS.includes(note)) return note;
  // One allowlist entry is a fixed-literal *prefix* (ending in `: `), for a
  // sentence this repository writes followed by a value the operator supplied.
  // Nothing else in the list is a prefix, and a suffix match is never accepted:
  // free text is never quoted because part of it happens to look known.
  if (DISPLAYABLE_AGENT_ERRORS.some((entry) => entry.endsWith(': ') && note.startsWith(entry))) return note;
  const derived = describeSignalDeath(sanitizeBackendError(meta.backend_error));
  if (derived !== null && derived === note) return note;
  return AGENT_ERROR_WITHHELD;
}

function statusJson(
  agentId: string,
  meta: AgentMetadata,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const item = summary(meta);
  const sequence = steerSequence(meta);
  const steers = steerQueue(meta, sequence);
  if (sequence === null || steers === null) throw new Error('canonical steer metadata invariant violated');
  const intent = persistedControlField(meta, 'intent');
  if (intent.malformed) throw new Error('canonical control metadata invariant violated');
  return {
    id: agentId,
    state: deriveState(meta),
    alive: invocationAlive(meta),
    native_session_id: persistedNativeSessionId(meta),
    pid: meta.pid,
    pgid: meta.pgid,
    runner_pid: meta.runner_pid,
    cwd: item.cwd,
    // Board issue 178: where this invocation launched, which is not always the
    // declared default -- a `--steer` can relocate an invocation, and a record
    // written before this field existed honestly reports that it was never
    // observed rather than inventing one from the declaration.
    invocation_cwd: item.invocation_cwd,
    capabilities: backendCapabilities(env),
    title: item.title,
    created_at: item.created_at,
    started_at: canonicalTimestamp(meta, 'started_at', true),
    finished_at: item.finished_at,
    last_activity_at: item.last_activity_at,
    exit_code: meta.exit_code,
    exit_signal: meta.exit_signal,
    // The note the runtime last recorded, if it is displayable. Named
    // `last_error`, not `error`, because `meta.error` is never cleared: on an
    // agent that failed once and then succeeded, this is the *earlier* run's
    // note, and a key called `error` beside `exit_code: 0` would read as the
    // current run's cause. See `displayableAgentError`.
    last_error: displayableAgentError(meta),
    prompts: item.prompts,
    steers_pending: steers.length,
    next_steer: steers.length > 0 ? steers[0]!.prompt.split('\n', 1)[0] : null,
    steer_preempting: intent.value === 'steer',
    steer_metadata_error: null,
    model: 'opencode/space-bunny-free',
    variant: persistedVariant(meta),
    backend_error: sanitizeBackendError(meta.backend_error),
    host_capacity: hostCapacityJson(readHostCapacity()),

    log: '',
  };
}

async function cmdStatus(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--json']);
  if (parsed.positionals.length !== 0) throw new UsageError('status: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'status');
  await reconcileAgent(agentId, context);
  const meta = requireMeta(agentId, context);
  const status = statusJson(agentId, meta, context.env);
  status.log = logPath(agentId, paths(context));
  if (parsed.flags.has('--json')) {
    context.io.stdout(JSON.stringify(status, null, 2));
  } else {
    const shown = (value: unknown, fallback = '-'): string => String(value ?? fallback);
    context.io.stdout(`agent:      ${agentId}`);
    context.io.stdout(`state:      ${String(status.state)}`);
    context.io.stdout(`alive:      ${status.alive === true ? 'yes' : 'no'}`);
    // The declared working directory, which is the directory the front runs in.
    // It is not a live observation of wherever the front has since wandered --
    // nothing here can know that -- and it is not inherited from the shell that
    // created the agent, so an undeclared agent says so rather than naming a
    // directory nobody chose.
    context.io.stdout(`cwd:        ${shown(status.cwd, 'undeclared')}`);
    // Where the front actually launched. `never ran` is a fact, not a missing
    // value: an agent with a declared directory that has never been launched in
    // it is not the same agent as one that was, and one line cannot say both.
    context.io.stdout(`ran in:     ${shown(status.invocation_cwd, 'never ran')}`);
    context.io.stdout(`created:    ${shown(status.created_at)}`);
    context.io.stdout(`started:    ${shown(status.started_at)}`);
    context.io.stdout(`finished:   ${shown(status.finished_at)}`);
    context.io.stdout(`exit code:  ${shown(status.exit_code)}`);
    // The note the runtime last recorded, next to the exit code. Only printed
    // when there is one, so a run that never recorded a note is unchanged, and
    // only ever the sanitised form -- see `displayableAgentError`. Labelled
    // `last error` rather than `error` because the runtime never clears
    // `meta.error`: on an agent that failed and then succeeded, this line is
    // the earlier failure's note, and calling it `error` under `exit code: 0`
    // would state it was this run's cause.
    if (status.last_error !== null) {
      context.io.stdout(`last error: ${String(status.last_error)}`);
    }
    // Host memory as reported by the kernel, so a pass can see the state a
    // death happened in rather than inferring it from an empty log.
    const capacity = status.host_capacity as Record<string, unknown>;
    context.io.stdout(`headroom:   ${shown(capacity.headroom)} of ${shown(capacity.limit_bytes)} limit`);
    if (capacity.degraded_reason !== null) {
      context.io.stdout(`host:       ${String(capacity.degraded_reason)}`);
    }
    context.io.stdout(`prompts:    ${shown(status.prompts, '0')}`);
    if (status.steer_metadata_error) {
      context.io.stdout(`steers:     ${String(status.steer_metadata_error)}`);
    } else if (typeof status.steers_pending === 'number' && status.steers_pending > 0) {
      context.io.stdout(`steers:     ${status.steers_pending} queued: ${String(status.next_steer ?? '')}`);
    }
    if (status.steer_preempting === true) context.io.stdout('steer:      hard-preempting current invocation');
    context.io.stdout(`title:      ${shown(status.title)}`);
  }
  return EXIT_OK;
}

function tailLines(path: string, count: number): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return count <= 0 ? lines : lines.slice(-count);
}

async function cmdLog(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--follow']);
  if (parsed.positionals.length !== 0) throw new UsageError('log: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'log');
  await reconcileAgent(agentId, context);
  requireMeta(agentId, context);
  const path = logPath(agentId, paths(context));
  const lines = parsed.values.has('--lines') ? nonnegativeInteger(parsed.values.get('--lines'), '--lines') : 50;
  for (const line of tailLines(path, lines)) context.io.stdout(line);
  if (!parsed.flags.has('--follow')) {
    if (!existsSync(path)) context.io.stderr('(no output yet)');
    return EXIT_OK;
  }
  let offset = existsSync(path) ? statSync(path).size : 0;
  while (true) {
    const meta = readMeta(agentId, paths(context));
    if (meta === null) return EXIT_NOT_FOUND;
    if (existsSync(path)) {
      const data = readFileSync(path);
      if (data.length > offset) {
        context.io.stdout(data.subarray(offset).toString('utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\n$/, ''));
        offset = data.length;
      }
    }
    const state = deriveState(meta);
    if ((TERMINAL_STATES as readonly string[]).includes(state) || state === 'unknown' || state === 'idle') return EXIT_OK;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function cmdWait(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args);
  if (parsed.positionals.length !== 0) throw new UsageError('wait: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'wait');
  const timeoutSeconds = nonnegativeInteger(parsed.values.get('--timeout'), '--timeout');
  const deadline = timeoutSeconds === 0 ? null : Date.now() + timeoutSeconds * 1000;
  while (deadline === null || Date.now() < deadline) {
    await reconcileAgent(agentId, context);
    const meta = requireMeta(agentId, context);
    const state = deriveState(meta);
    if (state !== 'running') return exitCodeFor(meta);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  context.io.stderr(`antonina: wait: agent ${agentId} still running after ${timeoutSeconds}s`);
  return EXIT_TIMEOUT;
}


function writeRaw(context: AgentCommandContext, text: string): void {
  if (!text) return;
  if (context.io.stdoutRaw) context.io.stdoutRaw(text);
  else context.io.stdout(text.replace(/\n$/, ''));
}

function spawnRunner(
  agentId: string,
  mode: 'new' | 'continue',
  generation: number,
  context: AgentCommandContext,
): void {
  const entryScript = context.entryScript ?? process.argv[1];
  if (!entryScript) throw new Error('cannot locate Antonina JavaScript entry point');
  const child = spawn(
    process.execPath,
    [entryScript, '_runner', agentId, mode, String(generation)],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...context.env,
        ANTONINA_AGENT_ID: agentId,
        ANTONINA_RUNNER_GEN: String(generation),
      },
    },
  );
  child.unref();
}

async function followAttached(agentId: string, context: AgentCommandContext): Promise<number> {
  const path = logPath(agentId, paths(context));
  let offset = 0;
  let terminalSince: number | null = null;
  while (true) {
    if (existsSync(path)) {
      const data = readFileSync(path);
      if (data.length > offset) {
        const text = data.subarray(offset).toString('utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
        writeRaw(context, text);
        offset = data.length;
      }
    }
    const meta = readMeta(agentId, paths(context));
    if (meta === null) return EXIT_NOT_FOUND;
    const state = deriveState(meta);
    const terminal = (TERMINAL_STATES as readonly string[]).includes(state) && activeRunnerFlag(meta) === false;
    if (terminal) {
      if (terminalSince === null) terminalSince = Date.now();
      if (Date.now() - terminalSince >= 500) return exitCodeFor(meta);
    } else {
      terminalSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function cmdRun(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--steer', '--detach', '--json']);
  if (parsed.positionals.length !== 0) throw new UsageError('run: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'run');
  const prompt = parsed.values.get('--prompt');
  if (!prompt) throw new UsageError('run: --prompt is required');
  const observed = requireMeta(agentId, context);
  // Durable execution configuration must be canonical before this prompt can
  // acquire runner or invocation authority.
  requiredPersistedAgentId(observed);
  // Canonicality is still checked here even though the declared value is no
  // longer the one that decides the launch: a malformed record must be refused
  // before this prompt can acquire runner or invocation authority.
  persistedAgentCwd(observed);
  persistedVariant(observed);
  persistedNativeSessionId(observed);
  if (
    deriveState(observed) === 'running'
    && !parsed.flags.has('--steer')
    && (invocationAlive(observed) || reservationInFlight(observed))
  ) {
    throw new Error(`agent ${agentId} is still running; use --steer to redirect it`);
  }
  // `--cwd` names the directory *this invocation* runs in. It means the same
  // thing on every path -- fresh run, and a `--steer` that kills the current
  // invocation and starts the next one in the same conversation -- and it is
  // accepted on every one of them. Board issue 178 deletes the quiescence gate
  // that used to refuse it while a front existed: a flag whose meaning depended
  // on whether the agent happened to be busy was not one flag, it was two, and
  // the busy case also refused the prompt the operator asked for.
  const runCwd = parsed.values.has('--cwd') ? declaredCwd(parsed.values.get('--cwd')!, 'run') : null;
  // Backend agnosticism, represented as data: a backend that cannot launch an
  // invocation in a named directory refuses here, by name, before any write --
  // never by running the invocation somewhere else and reporting the declared
  // directory as if it had honoured it.
  if (runCwd !== null && !backendCapabilities(context.env).invocation_cwd) {
    throw new Error('run: the configured backend cannot run an invocation in a different working directory');
  }
  if (runCwd === null) {
    const launchCwd = persistedAgentCwd(observed);
    if (launchCwd === null) {
      // The operator has no directory to give. There is still no honest value to
      // launch the backend with, and inheriting the invoking shell's directory is
      // the defect this replaces, so the launch is refused and says why.
      throw new Error(`run: agent ${agentId} has no declared working directory; pass --cwd /absolute/path`);
    }
    // A directory that has since been removed is refused here rather than
    // launched into, where it would produce no pid and a note that does not
    // name the cause. `runner.ts` repeats this check at the spawn, because a
    // directory can disappear in between.
    if (!existsSync(launchCwd) || !statSync(launchCwd).isDirectory()) {
      throw new Error(`run: agent ${agentId} working directory does not exist: ${launchCwd}`);
    }
  }
  if (configuredModelAvailable(context.env) === false) {
    throw new Error('configured OpenCode model opencode/space-bunny-free is unavailable');
  }
  const decision: {
    action?: 'busy' | 'spawn' | 'reuse';
    mode?: 'new' | 'continue';
    generation?: number;
    interrupt?: boolean;
    recoverBusy?: boolean;
  } = {};
  const steer = parsed.flags.has('--steer');
  // Written inside the same durable transaction that accepts the prompt, and on
  // every accepting branch, so the declared default and the directory the
  // accepted invocation will launch in can never disagree with each other or
  // with the prompt's acceptance. A transaction that ends in `busy` records
  // nothing at all, so a rejected prompt cannot leave a directory behind that no
  // front ever ran in.
  //
  // It writes the declaration and nothing else. Board issue 178: writing
  // `invocation_cwd` here too is what let an accepted-then-never-launched
  // invocation leave a record permanently naming a directory no front was ever
  // in, including in a terminal state, and what let a fork report the source's
  // last launch directory as the clone's own. The observation is written by the
  // runner, once a child exists; nothing reachable from this command writes it.
  const acceptCwd = (meta: AgentMetadata): void => {
    if (runCwd === null) return;
    meta.cwd = runCwd;
  };
  await updateMeta(agentId, (meta) => {
    const lifecycle = persistedLifecycleState(meta);
    const active = activeRunnerFlag(meta);
    if (deletePendingFlag(meta) !== false) {
      decision.action = 'busy';
      return;
    }
    const reservationState = runnerReservationState(meta.runner_reservation);
    if (lifecycle === null || active === null || reservationState === 'malformed') {
      decision.action = 'busy';
      return;
    }

    const live = invocationAlive(meta);
    if (live) {
      if (!steer) {
        decision.action = 'busy';
        return;
      }
      if (!queueSteer(meta, prompt, Date.now() / 1000)) {
        decision.action = 'busy';
        return;
      }
      acceptCwd(meta);
      meta.intent = 'steer';
      decision.action = 'reuse';
      decision.interrupt = true;
      return;
    }

    if (active === true && reservationInFlight(meta)) {
      if (steer) {
        if (!queueSteer(meta, prompt, Date.now() / 1000)) {
          decision.action = 'busy';
          return;
        }
        acceptCwd(meta);
        decision.action = 'reuse';
        return;
      }
      if (pendingPrompt(meta) !== null) {
        decision.action = 'busy';
        return;
      }
      acceptCwd(meta);
      meta.pending_prompt = prompt;
      meta.state = 'running';
      meta.last_activity_at = Date.now() / 1000;
      decision.action = 'reuse';
      return;
    }

    if (active === true && (reservationState === 'reserved' || reservationState === 'claimed')) {
      const reservation = meta.runner_reservation as Record<string, unknown>;
      const mode = runnerReservationMode(reservation);
      const currentGeneration = runnerGeneration(meta.runner_gen, 0);
      const accepted = pendingPrompt(meta);
      if (mode === null || currentGeneration === null) {
        decision.action = 'busy';
        return;
      }
      if (accepted !== null) {
        if (steer) {
          if (!queueSteer(meta, prompt, Date.now() / 1000)) {
            decision.action = 'busy';
            return;
          }
          acceptCwd(meta);
        } else {
          decision.recoverBusy = true;
        }
        const generation = currentGeneration + 1;
        meta.active_runner = true;
        meta.runner_gen = generation;
        meta.runner_reservation = {
          state: 'reserved',
          gen: generation,
          owner_pid: process.pid,
          owner_start_ticks: currentProcessStartTicks(),
          reserved_at: Date.now() / 1000,
          mode,
        };
        decision.action = 'spawn';
        decision.mode = mode;
        decision.generation = generation;
        return;
      }
      setActiveRunner(meta, false);
    }

    const currentGeneration = runnerGeneration(meta.runner_gen, 0);
    const promptCount = nextPromptCount(meta);
    if (currentGeneration === null || promptCount === null) {
      decision.action = 'busy';
      return;
    }
    let mode: 'new' | 'continue';
    const recordedSession = persistedNativeSessionId(meta);
    if (recordedSession !== null) {
      mode = 'continue';
    } else if (persistedLifecycleState(meta) === 'idle' && meta.prompt_count === 0) {
      mode = 'new';
    } else {
      const recoveredSession = discoverSessionId(agentId, context.env);
      if (recoveredSession === null) {
        mode = 'new';
      } else {
        meta.native_session_id = recoveredSession;
        mode = 'continue';
      }
    }
    const generation = currentGeneration + 1;
    const now = Date.now() / 1000;
    acceptCwd(meta);
    beginInvocation(meta, prompt, now, promptCount);
    meta.active_runner = true;
    meta.runner_gen = generation;
    meta.runner_reservation = {
      state: 'reserved',
      gen: generation,
      owner_pid: process.pid,
      owner_start_ticks: currentProcessStartTicks(),
      reserved_at: now,
      mode,
    };
    decision.action = 'spawn';
    decision.mode = mode;
    decision.generation = generation;
  }, paths(context));

  if (decision.action === 'busy' || decision.action === undefined) {
    throw new Error(`agent ${agentId} is still running; use --steer to redirect it`);
  }
  if (decision.action === 'spawn') {
    spawnRunner(agentId, decision.mode!, decision.generation!, context);
    if (decision.recoverBusy) {
      throw new Error(`agent ${agentId} is recovering an already accepted prompt; this prompt was rejected`);
    }
  } else if (decision.interrupt) {
    const current = readMeta(agentId, paths(context));
    if (current !== null) signalInvocation(current, 'SIGTERM');
  }

  if (parsed.flags.has('--detach')) {
    if (parsed.flags.has('--json')) {
      context.io.stdout(JSON.stringify({ id: agentId, state: 'running', detached: true }));
    } else {
      context.io.stdout(`Started agent ${agentId} in the background. Observe it with \`antonina agent log --id ${agentId} --follow\`.`);
    }
    return EXIT_OK;
  }
  return followAttached(agentId, context);
}

async function waitForRunnerGone(
  agentId: string,
  context: AgentCommandContext,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(agentId, paths(context));
    if (meta === null || !runnerAlive(meta)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const meta = readMeta(agentId, paths(context));
  return meta === null || !runnerAlive(meta);
}

/**
 * A stop/kill command is complete only when both the invocation and its detached
 * runner are gone. The runner owns the final state-file writes; returning while
 * it is still alive lets callers tear down or reuse that directory while a
 * background process is still mutating it.
 */
async function reapRunnerBeforeReturn(
  agentId: string,
  command: 'stop' | 'kill',
  context: AgentCommandContext,
): Promise<void> {
  if (await waitForRunnerGone(agentId, context, 2_000)) return;

  let current = readMeta(agentId, paths(context));
  if (current !== null) signalRunner(current, command === 'stop' ? 'SIGTERM' : 'SIGKILL');
  if (await waitForRunnerGone(agentId, context, 2_000)) return;

  if (command === 'stop') {
    current = readMeta(agentId, paths(context));
    if (current !== null) signalRunner(current, 'SIGKILL');
    if (await waitForRunnerGone(agentId, context, 2_000)) return;
  }
  throw new Error(`agent ${agentId} runner did not terminate`);
}

async function stopLike(
  command: 'stop' | 'kill',
  args: string[],
  context: AgentCommandContext,
): Promise<number> {
  // Board issue 178: `stop`/`kill` are the only lifecycle commands that rejected
  // `--json` outright, so an operator scripting a cleanup had to parse prose
  // from exactly the commands that destroy state. The command's meaning is
  // unchanged; only its output form is added, and both forms still exit after
  // the invocation *and* the detached runner are gone.
  const parsed = parse(args, ['--json']);
  if (parsed.positionals.length !== 0) throw new UsageError(`${command}: unexpected positional arguments`);
  const agentId = requireAgentId(parsed.values.get('--id'), command);
  const report = (current: AgentMetadata): number => {
    if (parsed.flags.has('--json')) {
      context.io.stdout(stableJson({ id: agentId, state: deriveState(current), command }));
    } else {
      context.io.stdout(`${command === 'stop' ? 'stopped' : 'killed'} agent ${agentId}`);
    }
    return EXIT_OK;
  };
  let meta = requireMeta(agentId, context);
  if (!invocationAlive(meta)) {
    let acceptedPending: string | null;
    try {
      acceptedPending = pendingPrompt(meta);
    } catch {
      throw new Error(`agent ${agentId} has malformed pending prompt authority`);
    }
    const ownsWork = activeRunnerFlag(meta) === true || acceptedPending !== null || reservationInFlight(meta);
    if (!ownsWork) {
      if (parsed.flags.has('--json')) return report(meta);
      context.io.stdout(
        command === 'stop'
          ? `antonina: agent ${agentId} is already stopped (state ${deriveState(meta)})`
          : `antonina: agent ${agentId} is already dead (state ${deriveState(meta)})`,
      );
      return EXIT_OK;
    }
    await updateMeta(agentId, (current) => {
      if (!beginStopLike(current, command, Date.now() / 1000)) {
        throw new Error('durable execution authority is malformed');
      }
      current.pending_prompt = null;
      current.steer_queue = [];
      current.active_runner = false;
      current.runner_reservation = null;
      finalizeTerminal(current, command === 'stop' ? 'stopped' : 'killed', Date.now() / 1000, null, null);
      current.stop_reason = command;
    }, paths(context));
    if (parsed.flags.has('--json')) return report(requireMeta(agentId, context));
    context.io.stdout(`${command === 'stop' ? 'stopped' : 'killed'} agent ${agentId} (cancelled reserved runner work)`);
    return EXIT_OK;
  }

  const started = await updateMeta(agentId, (current) => {
    if (!beginStopLike(current, command, Date.now() / 1000)) throw new Error('durable execution authority is malformed');
  }, paths(context));
  if (started === null) throw new NotFoundError(`unknown agent: ${agentId}`);
  meta = started;
  signalInvocation(meta, command === 'stop' ? 'SIGTERM' : 'SIGKILL');
  let gone = await waitForInvocationGone(meta, command === 'stop' ? 10_000 : 5_000);
  if (!gone && command === 'stop') {
    signalInvocation(meta, 'SIGKILL');
    gone = await waitForInvocationGone(meta, 5_000);
  }
  if (!gone) throw new Error(`agent ${agentId} did not terminate`);
  await updateMeta(agentId, (current) => {
    finalizeTerminal(current, command === 'stop' ? 'stopped' : 'killed', Date.now() / 1000, null, command === 'kill' ? 9 : 15);
    current.stop_reason = command;
    current.active_runner = false;
    current.runner_reservation = null;
  }, paths(context));
  await reapRunnerBeforeReturn(agentId, command, context);
  return report(requireMeta(agentId, context));
}

async function cmdDelete(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--force']);
  if (parsed.positionals.length !== 0) throw new UsageError('delete: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'delete');
  const observed = requireMeta(agentId, context);
  let pending: string | null;
  try {
    pending = pendingPrompt(observed);
  } catch {
    throw new Error(`delete: agent ${agentId} has malformed pending prompt authority`);
  }
  // No reservation disjunct here, and that is deliberate rather than an
  // oversight: `reservationInFlight` can only return true when
  // `activeRunnerFlag(meta)` is null or true. `null` is unreachable through
  // `requireMeta`, because `readMeta` runs `validateAgentMetadata`, which
  // rejects a missing or non-boolean `active_runner` outright; and `true` is
  // exactly the preceding disjunct, so it short-circuits before this point.
  // A reservation disjunct here could therefore only ever be evaluated, never
  // satisfied. The reservation is still owned work -- `reconcileDeadMeta`
  // (lifecycle.ts) and the `stopLike`, `prompt` and `clean` paths reach the
  // rung and are guarded by their own tests. See
  // packages/cli/test/delete-reservation-rung.test.mjs, which pins the absence.
  const ownsWork = deriveState(observed) === 'running'
    || invocationAlive(observed)
    || activeRunnerFlag(observed) === true
    || pending !== null;
  if (ownsWork && !parsed.flags.has('--force')) {
    throw new Error(`delete: agent ${agentId} is running; use --force`);
  }

  const tombstoned = await updateMeta(agentId, (meta) => {
    if (deletePendingFlag(meta) === null) {
      throw new Error('delete: durable deletion authority is malformed');
    }
    meta.delete_pending = true;
  }, paths(context));
  if (tombstoned === null) throw new NotFoundError(`unknown agent: ${agentId}`);

  if (ownsWork) {
    const result = await stopLike('kill', ['--id', agentId], context);
    if (result !== EXIT_OK) return result;

    if (!await waitForRunnerGone(agentId, context, 2_000)) {
      const current = readMeta(agentId, paths(context));
      if (current !== null) signalRunner(current, 'SIGKILL');
      if (!await waitForRunnerGone(agentId, context, 2_000)) {
        throw new Error(`delete: runner for agent ${agentId} did not terminate`);
      }
    }
  }
  removeAgentDirectory(agentId, paths(context));
  context.io.stdout(`deleted agent ${agentId}`);
  return EXIT_OK;
}

/**
 * The two questions the retention sweep asks about a record, kept apart because
 * they were previously one expression and the conflation is board issue 129.
 *
 * `retentionEligibleState` is "has this record's work finished?". Two answers
 * count, and they are answers rather than accidents:
 *
 *   - a terminal state, which is what every writer other than the fork produces
 *     once a run ends (`finalizeTerminal` writes the terminal state and the
 *     `finished_at` together); and
 *   - `idle` together with a persisted `finished_at`, which is the state
 *     `forkMetaSnapshot` produces for a clone of a source that had already
 *     finished. It is coherent, not corrupt: the clone is a new agent that has
 *     begun no run of its own, and the work it carries forward is finished. The
 *     previous predicate asked only the first question, so that record matched
 *     neither test and was retained forever and invisibly -- it recurred on every
 *     fork of a finished agent.
 *
 * `retentionAnchor` is "how old is it, for retention purposes?", and it is the
 * LATER of the record's `finished_at` and its own `created_at`. For every record
 * the product creates itself those are ordered -- `created_at` is stamped at
 * creation and `finished_at` at the end of a later run -- so the later of the
 * two IS `finished_at` and this changes no existing behaviour. The single
 * exception is the fork, which stamps `created_at` as now and inherits
 * `finished_at` from a source that may be arbitrarily old, and there the anchor
 * is the clone's own creation.
 *
 * That asymmetry is the decision, not an accident of implementation. A clone is
 * a durable object the operator just asked for; its retention window running
 * from its own creation means `agent clean` can never delete an artifact seconds
 * old because the session it was forked from ended months ago. The opposite
 * choice -- anchoring on `finished_at` alone -- would make `agent clean --days
 * 14` delete a fork made moments ago from a three-month-old source, and if the
 * source has since been deleted that clone is the last copy of that history, so
 * the sweep would be silently destroying the work the fork was made to preserve.
 * Leaking a record forever is the milder failure; deleting it early is
 * irreversible.
 *
 * Reversal condition: if `agent clean` is ever specified as strictly "the age
 * of the finished work" rather than "the age of the record", both helpers change
 * with it -- `retentionAnchor` becomes plain `finished_at` and a fork's
 * retention window begins at the source's outcome again. A second reversal
 * condition: if fork snapshots ever stop inheriting `finished_at`, the idle
 * clause of `retentionEligibleState` becomes unreachable and should be deleted
 * rather than left as a dead branch.
 */
function retentionEligibleState(meta: AgentMetadata): boolean {
  const state = deriveState(meta);
  if ((TERMINAL_STATES as readonly string[]).includes(state)) return true;
  return state === 'idle' && persistedTimestamp(meta.finished_at) !== null;
}

function retentionAnchor(meta: AgentMetadata): number | null {
  const finished = persistedTimestamp(meta.finished_at);
  if (finished === null) return null;
  const created = persistedTimestamp(meta.created_at);
  return created === null ? finished : Math.max(finished, created);
}

async function cmdClean(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--dry-run']);
  if (parsed.positionals.length !== 0) throw new UsageError('clean: unexpected positional arguments');
  const configured = parsed.values.get('--days') ?? context.env.ANTONINA_AGENT_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS);
  const days = nonnegativeInteger(configured, '--days');
  const cutoff = Date.now() / 1000 - days * 86_400;
  const candidates = agentIds(context).filter((agentId) => {
    const meta = readMeta(agentId, paths(context));
    if (meta === null || !retentionEligibleState(meta)) return false;
    const anchor = retentionAnchor(meta);
    return anchor !== null && anchor < cutoff;
  });
  for (const agentId of candidates) {
    if (parsed.flags.has('--dry-run')) {
      context.io.stdout(agentId);
      continue;
    }
    let removable = false;
    await updateMeta(agentId, (meta) => {
      let pending: string | null;
      try {
        pending = pendingPrompt(meta);
      } catch {
        return;
      }
      const anchor = retentionAnchor(meta);
      if (
        !retentionEligibleState(meta)
        || anchor === null
        || anchor >= cutoff
        || invocationAlive(meta)
        || activeRunnerFlag(meta) !== false
        || reservationInFlight(meta)
        || pending !== null
        || deletePendingFlag(meta) !== false
      ) return;
      meta.delete_pending = true;
      removable = true;
    }, paths(context));
    if (!removable) continue;
    removeAgentDirectory(agentId, paths(context));
    context.io.stdout(`deleted agent ${agentId}`);
  }
  return EXIT_OK;
}

export async function runAgentCommand(argv: string[], context: AgentCommandContext): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'new': return await cmdNew(args, context);
      case 'list': return await cmdList(args, context);
      case 'status': return await cmdStatus(args, context);
      case 'log': return await cmdLog(args, context);
      case 'wait': return await cmdWait(args, context);
      case 'stop': return await stopLike('stop', args, context);
      case 'kill': return await stopLike('kill', args, context);
      case 'delete': return await cmdDelete(args, context);
      case 'clean': return await cmdClean(args, context);
      case 'run': return await cmdRun(args, context);
      default:
        throw new UsageError(command ? `unsupported antonina agent command: ${command}` : 'an agent command is required');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      context.io.stderr(`antonina: ${message}`);
      return EXIT_USAGE;
    }
    if (error instanceof NotFoundError) {
      context.io.stderr(`antonina: ${message}`);
      return EXIT_NOT_FOUND;
    }
    context.io.stderr(`antonina: ${message}`);
    return EXIT_ERROR;
  }
}
