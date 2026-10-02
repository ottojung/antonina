import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { configuredModelAvailable, discoverSessionId, sanitizeBackendError } from '../../agent-runtime/src/backend.js';
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
  TERMINAL_STATES,
  activeRunnerFlag,
  deletePendingFlag,
  idleMeta,
  nextPromptCount,
  pendingPrompt,
  persistedAgentCwd,
  persistedControlField,
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
  title: string | null;
} {
  return {
    created_at: canonicalTimestamp(meta, 'created_at', false)!,
    last_activity_at: canonicalTimestamp(meta, 'last_activity_at', false)!,
    finished_at: canonicalTimestamp(meta, 'finished_at', true),
    prompts: meta.prompt_count as number,
    cwd: persistedAgentCwd(meta),
    title: meta.title as string | null,
  };
}

function listEntryJson(agentId: string, state: string, item: ReturnType<typeof summary>): Record<string, unknown> {
  return {
    id: agentId,
    state,
    prompts: item.prompts,
    cwd: item.cwd,
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
 */
function declaredCwd(raw: string, command: string): string {
  const cwd = resolve(raw);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`${command}: working directory does not exist: ${cwd}`);
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
  const page = parsed.values.has('--page') ? positiveInteger(parsed.values.get('--page'), '--page') : 1;
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
    title: item.title,
    created_at: item.created_at,
    started_at: canonicalTimestamp(meta, 'started_at', true),
    finished_at: item.finished_at,
    last_activity_at: item.last_activity_at,
    exit_code: meta.exit_code,
    exit_signal: meta.exit_signal,
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
    context.io.stdout(`created:    ${shown(status.created_at)}`);
    context.io.stdout(`started:    ${shown(status.started_at)}`);
    context.io.stdout(`finished:   ${shown(status.finished_at)}`);
    context.io.stdout(`exit code:  ${shown(status.exit_code)}`);
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
  const recordedCwd = persistedAgentCwd(observed);
  persistedVariant(observed);
  persistedNativeSessionId(observed);
  if (
    deriveState(observed) === 'running'
    && !parsed.flags.has('--steer')
    && (invocationAlive(observed) || reservationInFlight(observed))
  ) {
    throw new Error(`agent ${agentId} is still running; use --steer to redirect it`);
  }
  // `--cwd` declares the directory this front runs in, and the record is
  // corrected to it in the same durable write that accepts the prompt, so the
  // two can never disagree. It is only ever a statement about a front that does
  // not exist yet: under a live invocation, an accepted prompt, or an unclaimed
  // runner reservation it would make the record name a directory the front that
  // already exists is not in, so it is refused without writing anything.
  const runCwd = parsed.values.has('--cwd') ? declaredCwd(parsed.values.get('--cwd')!, 'run') : null;
  if (runCwd !== null) {
    let acceptedPending: string | null;
    try {
      acceptedPending = pendingPrompt(observed);
    } catch {
      throw new Error(`run: agent ${agentId} has malformed pending prompt authority`);
    }
    if (invocationAlive(observed) || reservationInFlight(observed) || acceptedPending !== null) {
      throw new Error(`run: agent ${agentId} already owns work; --cwd cannot be declared while a front exists`);
    }
  } else if (recordedCwd === null) {
    // The operator has no directory to give. There is still no honest value to
    // launch the backend with, and inheriting the invoking shell's directory is
    // the defect this replaces, so the launch is refused and says why.
    throw new Error(`run: agent ${agentId} has no declared working directory; pass --cwd /absolute/path`);
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
        decision.action = 'reuse';
        return;
      }
      if (pendingPrompt(meta) !== null) {
        decision.action = 'busy';
        return;
      }
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
    // The declared working directory is written here, on the one path that
    // starts a fresh invocation for an agent that owns no work, and nowhere
    // else: a transaction that ends in `busy` records nothing at all, so a
    // rejected prompt cannot leave a cwd behind that no front ever ran in.
    if (runCwd !== null) meta.cwd = runCwd;
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
  const parsed = parse(args);
  if (parsed.positionals.length !== 0) throw new UsageError(`${command}: unexpected positional arguments`);
  const agentId = requireAgentId(parsed.values.get('--id'), command);
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
  context.io.stdout(`${command === 'stop' ? 'stopped' : 'killed'} agent ${agentId}`);
  return EXIT_OK;
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
