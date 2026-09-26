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

async function reconcileAgent(agentId: string, context: AgentCommandContext): Promise<void> {
  if (readMeta(agentId, paths(context)) === null) return;
  await updateMeta(agentId, (meta) => { reconcileDeadMeta(meta); }, paths(context));
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
  cwd: string;
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

async function cmdNew(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--json']);
  if (parsed.positionals.length !== 0) throw new UsageError('new: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'new');
  const cwd = resolve(parsed.values.get('--cwd') ?? context.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`new: working directory does not exist: ${cwd}`);
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
    context.io.stdout(`Created agent with id ${agentId} (idle). Start work with \`antonina agent prompt --id ${agentId} 'task'\`.`);
  }
  return EXIT_OK;
}

async function cmdList(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--json', '--running', '--finished', '--succeeded', '--failed', '--stopped', '--killed']);
  if (parsed.positionals.length !== 0) throw new UsageError('list: unexpected positional arguments');
  const limit = parsed.values.has('--limit') ? positiveInteger(parsed.values.get('--limit'), '--limit') : null;
  const entries: Array<{ agentId: string; meta: AgentMetadata; state: string; summary: ReturnType<typeof summary> }> = [];
  for (const agentId of agentIds(context)) {
    await reconcileAgent(agentId, context);
    const meta = readMeta(agentId, paths(context));
    if (meta === null) continue;
    const state = deriveState(meta);
    if (!matchesFilters(parsed, state)) continue;
    entries.push({ agentId, meta, state, summary: summary(meta) });
  }
  entries.sort((left, right) => right.summary.created_at - left.summary.created_at);
  const selected = limit === null ? entries : entries.slice(0, limit);
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
        entry.summary.cwd,
        (entry.summary.title ?? '').replace(/\n/g, ' '),
      ].join('  '));
    }
  }
  return EXIT_OK;
}

function statusJson(agentId: string, meta: AgentMetadata): Record<string, unknown> {
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
    log: '',
  };
}

async function cmdStatus(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--json']);
  if (parsed.positionals.length !== 0) throw new UsageError('status: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'status');
  await reconcileAgent(agentId, context);
  const meta = requireMeta(agentId, context);
  const status = statusJson(agentId, meta);
  status.log = logPath(agentId, paths(context));
  if (parsed.flags.has('--json')) {
    context.io.stdout(JSON.stringify(status, null, 2));
  } else {
    const shown = (value: unknown, fallback = '-'): string => String(value ?? fallback);
    context.io.stdout(`agent:      ${agentId}`);
    context.io.stdout(`state:      ${String(status.state)}`);
    context.io.stdout(`alive:      ${status.alive === true ? 'yes' : 'no'}`);
    context.io.stdout(`cwd:        ${shown(status.cwd)}`);
    context.io.stdout(`created:    ${shown(status.created_at)}`);
    context.io.stdout(`started:    ${shown(status.started_at)}`);
    context.io.stdout(`finished:   ${shown(status.finished_at)}`);
    context.io.stdout(`exit code:  ${shown(status.exit_code)}`);
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

async function cmdPrompt(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--steer', '--detach', '--json']);
  if (parsed.positionals.length > 1) throw new UsageError('prompt: expected one prompt');
  const agentId = requireAgentId(parsed.values.get('--id'), 'prompt');
  const prompt = parsed.values.get('--prompt') ?? parsed.positionals[0];
  if (!prompt) throw new UsageError('prompt: a prompt is required');
  const observed = requireMeta(agentId, context);
  // Durable execution configuration must be canonical before this prompt can
  // acquire runner or invocation authority.
  requiredPersistedAgentId(observed);
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
  const ownsWork = deriveState(observed) === 'running'
    || invocationAlive(observed)
    || activeRunnerFlag(observed) === true
    || reservationInFlight(observed)
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

async function cmdClean(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--dry-run']);
  if (parsed.positionals.length !== 0) throw new UsageError('clean: unexpected positional arguments');
  const configured = parsed.values.get('--days') ?? context.env.ANTONINA_AGENT_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS);
  const days = nonnegativeInteger(configured, '--days');
  const cutoff = Date.now() / 1000 - days * 86_400;
  const candidates = agentIds(context).filter((agentId) => {
    const meta = readMeta(agentId, paths(context));
    if (meta === null || !(TERMINAL_STATES as readonly string[]).includes(deriveState(meta))) return false;
    const finished = persistedTimestamp(meta.finished_at);
    return finished !== null && finished < cutoff;
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
      const state = deriveState(meta);
      const finished = persistedTimestamp(meta.finished_at);
      if (
        !(TERMINAL_STATES as readonly string[]).includes(state)
        || finished === null
        || finished >= cutoff
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
      case 'prompt': return await cmdPrompt(args, context);
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
