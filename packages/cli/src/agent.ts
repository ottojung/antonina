import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

import {
  beginStopLike,
  deriveState,
  exitCodeFor,
  finalizeTerminal,
  invocationAlive,
  signalInvocation,
  waitForInvocationGone,
} from '../../agent-runtime/src/lifecycle.js';
import {
  TERMINAL_STATES,
  idleMeta,
  persistedTimestamp,
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
}

export interface AgentCommandContext {
  env: Record<string, string | undefined>;
  cwd: string;
  io: AgentCommandIo;
  home?: string;
}

interface Parsed {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

function paths(context: AgentCommandContext): StatePathsOptions {
  return context.home === undefined
    ? { env: context.env }
    : { env: context.env, home: context.home };
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

function summary(meta: AgentMetadata): {
  created_at: number | null;
  prompts: number | null;
  cwd: string | null;
  title: string | null;
  metadata_errors?: string[];
} {
  const errors: string[] = [];
  const created = meta.created_at === undefined || meta.created_at === null
    ? null
    : persistedTimestamp(meta.created_at);
  if (meta.created_at !== undefined && meta.created_at !== null && created === null) errors.push('created_at');
  const prompts = typeof meta.prompt_count === 'number' && Number.isSafeInteger(meta.prompt_count) && meta.prompt_count >= 0
    ? meta.prompt_count
    : meta.prompt_count === undefined
      ? null
      : (errors.push('prompt_count'), null);
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : meta.cwd === undefined || meta.cwd === null
    ? null
    : (errors.push('cwd'), null);
  const title = typeof meta.title === 'string' ? meta.title : meta.title === undefined || meta.title === null
    ? null
    : (errors.push('title'), null);
  return errors.length > 0
    ? { created_at: created, prompts, cwd, title, metadata_errors: errors }
    : { created_at: created, prompts, cwd, title };
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
  const entries = agentIds(context)
    .map((agentId) => {
      const meta = readMeta(agentId, paths(context)) ?? { id: agentId };
      return { agentId, meta, state: deriveState(meta), summary: summary(meta) };
    })
    .filter((entry) => matchesFilters(parsed, entry.state))
    .sort((left, right) => (right.summary.created_at ?? 0) - (left.summary.created_at ?? 0));
  const selected = limit === null ? entries : entries.slice(0, limit);
  if (parsed.flags.has('--json')) {
    context.io.stdout(stableJson({
      agents: selected.map(({ agentId, state, summary: item }) => ({ id: agentId, state, ...item })),
    }));
  } else if (selected.length === 0) {
    context.io.stdout('(no agents)');
  } else {
    context.io.stdout('ID  STATE  P  AGE  CWD  TITLE');
    for (const entry of selected) {
      context.io.stdout([
        entry.agentId,
        entry.state,
        entry.summary.prompts ?? 0,
        humanAge(entry.summary.created_at),
        entry.summary.cwd ?? '',
        (entry.summary.title ?? '').replace(/\n/g, ' '),
      ].join('  '));
    }
  }
  return EXIT_OK;
}

function statusJson(agentId: string, meta: AgentMetadata): Record<string, unknown> {
  const item = summary(meta);
  const state = deriveState(meta);
  return {
    id: agentId,
    state,
    alive: invocationAlive(meta),
    native_session_id: typeof meta.native_session_id === 'string' ? meta.native_session_id : null,
    pid: typeof meta.pid === 'number' && Number.isSafeInteger(meta.pid) ? meta.pid : null,
    pgid: typeof meta.pgid === 'number' && Number.isSafeInteger(meta.pgid) ? meta.pgid : null,
    runner_pid: typeof meta.runner_pid === 'number' && Number.isSafeInteger(meta.runner_pid) ? meta.runner_pid : null,
    cwd: item.cwd,
    title: item.title,
    created_at: item.created_at,
    started_at: persistedTimestamp(meta.started_at),
    finished_at: persistedTimestamp(meta.finished_at),
    last_activity_at: persistedTimestamp(meta.last_activity_at),
    exit_code: typeof meta.exit_code === 'number' && Number.isSafeInteger(meta.exit_code) ? meta.exit_code : null,
    exit_signal: typeof meta.exit_signal === 'number' && Number.isSafeInteger(meta.exit_signal) ? meta.exit_signal : null,
    prompts: item.prompts,
    model: 'opencode/space-bunny-free',
    variant: typeof meta.variant === 'string' ? meta.variant : null,
    backend_error: typeof meta.backend_error === 'object' && meta.backend_error !== null ? meta.backend_error : null,
    log: logPath(agentId, paths({ env: process.env, cwd: process.cwd(), io: { stdout() {}, stderr() {} } })),
    ...(item.metadata_errors === undefined ? {} : { metadata_errors: item.metadata_errors }),
  };
}

async function cmdStatus(args: string[], context: AgentCommandContext): Promise<number> {
  const parsed = parse(args, ['--json']);
  if (parsed.positionals.length !== 0) throw new UsageError('status: unexpected positional arguments');
  const agentId = requireAgentId(parsed.values.get('--id'), 'status');
  const meta = requireMeta(agentId, context);
  const status = statusJson(agentId, meta);
  status.log = logPath(agentId, paths(context));
  if (parsed.flags.has('--json')) {
    context.io.stdout(JSON.stringify(status, null, 2));
  } else {
    context.io.stdout(`agent:      ${agentId}`);
    context.io.stdout(`state:      ${String(status.state)}`);
    context.io.stdout(`alive:      ${status.alive === true ? 'yes' : 'no'}`);
    context.io.stdout(`cwd:        ${String(status.cwd ?? '-')}`);
    context.io.stdout(`created:    ${String(status.created_at ?? '-')}`);
    context.io.stdout(`started:    ${String(status.started_at ?? '-')}`);
    context.io.stdout(`finished:   ${String(status.finished_at ?? '-')}`);
    context.io.stdout(`exit code:  ${String(status.exit_code ?? '-')}`);
    context.io.stdout(`prompts:    ${String(status.prompts ?? 0)}`);
    context.io.stdout(`title:      ${String(status.title ?? '-')}`);
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
  const timeoutSeconds = positiveInteger(parsed.values.get('--timeout'), '--timeout');
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const meta = requireMeta(agentId, context);
    const state = deriveState(meta);
    if (state !== 'running') return exitCodeFor(meta);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  context.io.stderr(`antonina: wait: agent ${agentId} still running after ${timeoutSeconds}s`);
  return EXIT_TIMEOUT;
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
    await updateMeta(agentId, (current) => {
      beginStopLike(current, command, Date.now() / 1000);
      current.pending_prompt = null;
      current.steer_queue = [];
      current.active_runner = false;
      current.runner_reservation = null;
      finalizeTerminal(current, command === 'stop' ? 'stopped' : 'killed', Date.now() / 1000, null, null);
      current.stop_reason = command;
    }, paths(context));
    context.io.stdout(`${command === 'stop' ? 'stopped' : 'killed'} agent ${agentId}`);
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
  const meta = requireMeta(agentId, context);
  if (deriveState(meta) === 'running' && !parsed.flags.has('--force')) {
    throw new Error(`delete: agent ${agentId} is running; use --force`);
  }
  if (deriveState(meta) === 'running') await stopLike('kill', ['--id', agentId], context);
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
    if (parsed.flags.has('--dry-run')) context.io.stdout(agentId);
    else {
      removeAgentDirectory(agentId, paths(context));
      context.io.stdout(`deleted agent ${agentId}`);
    }
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
      case 'prompt':
        throw new Error('prompt runtime is not yet ported on this migration branch');
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
