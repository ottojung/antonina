import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { isAbsolute } from 'node:path';

import {
  DEFAULT_VARIANT,
  RUNNER_OWNER_TOKEN_ENV,
  persistedNativeSessionId,
  persistedVariant,
  requiredAgentCwd,
  requiredPersistedAgentId,
  type AgentMetadata,
} from './metadata.js';
import type { OomCounters } from './host-capacity.js';

export const AGENT_MODEL = 'opencode-go/longcat-2.5-preview-free';
export const OPENCODE_TITLE_PREFIX = 'antonina-';
export const DEFAULT_OPENCODE_BIN = 'opencode';
export const OPENCODE_BIN_ENV = 'ANTONINA_OPENCODE_BIN';
const SESSION_LIST_MAX_COUNT = 100;
const SESSION_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;
export const BACKEND_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
export const BACKEND_RETRY_MAX_ATTEMPTS = 2;
export const BACKEND_RETRY_BASE_MS = 500;
const BACKEND_CLASSIFICATION_MAX_CHARS = 80;
const BACKEND_FIELD_MAX_CHARS = 200;

export interface BackendError {
  classification: string;
  provider?: string | null;
  model?: string | null;
  request_boundary?: 'fresh_session' | 'continuation' | null;
  reference?: string | null;
  transient?: boolean;
  automatic_retry_safe?: boolean;
  fresh_session_useful?: boolean | null;
  backend_scope?: string | null;
  diagnostic_bytes?: number;
  /**
   * Signal-death detail. Present only on `SIGNAL_DEATH_CLASSIFICATION` records,
   * where it names the signal and reports the cgroup OOM counters observed
   * across the agent's lifetime. Absent on genuine backend failures, which is
   * what keeps the two cases distinguishable in persisted state and in
   * `agent status`.
   */
  signal?: number | null;
  signal_name?: string | null;
  oom_evidence?: 'observed' | 'unavailable' | null;
  oom_delta?: number | null;
  oom_kill_delta?: number | null;
  lifetime_seconds?: number | null;
}

/**
 * A managed agent that exited on a signal without an operator stop/kill intent
 * was killed from outside its own process. Recording that as a bare
 * `exit_signal 9` / `exit_code -9` with a null backend error is what made a host
 * OOM kill indistinguishable from a model-backend crash, so the signal death
 * gets its own classification rather than sharing the backend-failure channel's
 * null case.
 */
export const SIGNAL_DEATH_CLASSIFICATION = 'external_signal_kill';

/** Longest accepted `signal_name`; keeps a corrupted record from bloating state. */
const SIGNAL_NAME_MAX_CHARS = 32;

const OOM_EVIDENCE_VALUES = ['observed', 'unavailable'] as const;

function signalNameFor(signal: number): string | null {
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === signal && name.length <= SIGNAL_NAME_MAX_CHARS) return name;
  }
  return null;
}

export interface SignalDeathEvidence {
  signal: number;
  isContinue: boolean;
  /** OOM counters sampled immediately before the agent was spawned. */
  before: OomCounters | null;
  /** OOM counters sampled immediately after the agent was reaped. */
  after: OomCounters | null;
  lifetimeSeconds: number | null;
}

/**
 * Classifies an externally signalled death and brackets it with the cgroup OOM
 * counters the kernel exposes.
 *
 * When both counter samples are readable the deltas across the agent's
 * lifetime are reported, and a non-zero `oom_kill` delta is the kernel's own
 * statement that the OOM killer fired inside the window. When the kernel
 * exposes nothing, `oom_evidence` is `unavailable`: the record says the
 * evidence is absent rather than implying the agent was not OOM killed.
 */
export function classifySignalDeath(evidence: SignalDeathEvidence): BackendError {
  const { signal, isContinue, before, after } = evidence;
  const observed = before !== null && after !== null;
  // Millisecond precision, and deliberately fractional: an agent lifetime of
  // 42.5s is a real observation, and rounding it to an integer would be a
  // second small guess about a number the kernel gave us.
  const rawLifetime = evidence.lifetimeSeconds;
  const lifetime = typeof rawLifetime === 'number' && Number.isFinite(rawLifetime)
    ? Math.round(Math.max(0, rawLifetime) * 1000) / 1000
    : null;
  const oomDelta = observed ? Math.max(0, after!.oom - before!.oom) : null;
  const oomKillDelta = observed ? Math.max(0, after!.oomKill - before!.oomKill) : null;
  const name = signalNameFor(signal);
  return {
    classification: SIGNAL_DEATH_CLASSIFICATION,
    provider: null,
    model: AGENT_MODEL,
    request_boundary: isContinue ? 'continuation' : 'fresh_session',
    reference: null,
    transient: false,
    automatic_retry_safe: false,
    fresh_session_useful: isContinue ? null : false,
    backend_scope: 'host',
    diagnostic_bytes: 0,
    signal,
    signal_name: name,
    oom_evidence: observed ? 'observed' : 'unavailable',
    oom_delta: oomDelta,
    oom_kill_delta: oomKillDelta,
    lifetime_seconds: lifetime,
  };
}

/**
 * A one-line, human-readable summary of a signal death for the `error` note
 * that `agent status` and the board carry. Says what is known and, just as
 * importantly, what is not.
 */
export function describeSignalDeath(error: BackendError | null): string | null {
  if (error === null || error.classification !== SIGNAL_DEATH_CLASSIFICATION) return null;
  const signal = typeof error.signal === 'number' ? error.signal : null;
  const name = typeof error.signal_name === 'string' && error.signal_name.length > 0
    ? error.signal_name
    : 'unknown signal';
  const head = signal === null ? `killed by ${name}` : `killed by ${name} (signal ${signal})`;
  if (error.oom_evidence !== 'observed') {
    return `${head}; the kernel exposed no cgroup OOM counters for this cgroup, so OOM involvement is unknown rather than absent`;
  }
  const oom = error.oom_delta ?? 0;
  const kills = error.oom_kill_delta ?? 0;
  const window = typeof error.lifetime_seconds === 'number' ? ` over the ${error.lifetime_seconds}s agent lifetime` : '';
  return `${head}; cgroup memory.events rose by oom ${oom} and oom_kill ${kills}${window}${kills > 0 ? ', so the OOM killer fired inside the agent lifetime' : ', with no OOM kill recorded inside the agent lifetime'}`;
}

/**
 * A one-line reason for a non-signal, non-zero backend exit, for the `error`
 * note that `agent status` and the board carry.
 *
 * Its job is to make the durable record say *which* of the two very different
 * things happened: the backend itself failed (this), or the runtime lost the
 * invocation before any exit status existed (`reconcileDeadMeta`'s note, which
 * carries no exit code at all). Before board 159 both produced a bare `failed`.
 */
export function describeBackendDeath(
  error: BackendError | null,
  excerpt: string | null,
  operatorSignalRefused = false,
): string | null {
  if (operatorSignalRefused) {
    // The operator asked for this invocation to end and the runtime tried, but
    // `signalInvocation` refused: the durable identity no longer resolved, or
    // the pid/start-time/marker checks failed against live `/proc`, or the
    // signal itself failed. Nothing reached the backend process group. Say
    // exactly that, rather than saying the operator stopped the backend.
    const base = describeBackendDeath(error, excerpt);
    return `${base ?? 'the backend process ended unsuccessfully'}; this runtime did not deliver a signal to the backend process group for that request`;
  }
  if (error === null) {
    const tail = excerpt === null ? '' : `; the last line it wrote was: ${excerpt}`;
    return `the backend process exited unsuccessfully without writing a diagnostic this runtime could read${tail}`;
  }
  if (error.classification === SIGNAL_DEATH_CLASSIFICATION) return describeSignalDeath(error);
  if (error.classification === UNRECOGNIZED_BACKEND_FAILURE) {
    const tail = excerpt === null ? '' : `; the last line it wrote was: ${excerpt}`;
    return `the backend process exited unsuccessfully and this runtime does not recognise the failure${tail}`;
  }
  return `the backend process reported ${error.classification}${excerpt === null ? '' : `; the last line it wrote was: ${excerpt}`}`;
}

interface BackendFailureRule {
  marker: string;
  classification: string;
  provider: string;
  transient: boolean;
  automaticRetrySafe: boolean;
}

const BACKEND_FAILURE_RULES: readonly BackendFailureRule[] = [
  // An OpenCode Go request may fail temporarily even after the previous
  // turn has performed tool actions. Classify the outage for operators and
  // the scheduler, but NEVER replay the same turn automatically.
  {
    marker: 'Endpoint is unavailable',
    classification: 'upstream_endpoint_unavailable',
    provider: 'opencode-go',
    transient: true,
    automaticRetrySafe: false,
  },
  // The OpenCode Go LongCat free tier can reject requests across many sessions
  // simultaneously. Name the provider throttle instead of reporting an
  // unrecognized backend failure. Do not replay the turn automatically:
  // the API error alone cannot prove no earlier tool action was committed.
  {
    marker: 'Rate limit exceeded. Please try again later.',
    classification: 'upstream_rate_limited',
    provider: 'opencode-go',
    transient: true,
    automaticRetrySafe: false,
  },
  {
    marker: 'Unexpected server error',
    classification: 'transient_backend_server_error',
    provider: 'opencode',
    transient: true,
    automaticRetrySafe: false,
  },
  // Board 159. The backend prints this and exits non-zero at the end of an
  // otherwise complete turn; observed in three managed agents on 2026-10-02
  // (`agents/94d01`, `agents/92a01`, `agents/136d`), all three of which had
  // already done their work. The cause is upstream of this repository, so all
  // the runtime can do is name the failure class rather than leave the terminal
  // record blank. Deliberately not `transient`: nothing here says the same
  // request would succeed next time, and a retry would re-run a completed turn.
  {
    marker: 'Failed to execute statement',
    classification: 'backend_statement_execution_error',
    provider: 'opencode',
    transient: false,
    automaticRetrySafe: false,
  },
];

/**
 * Classification for a non-zero backend exit that matched no rule.
 *
 * Before this existed, `classifyBackendFailure` returned null for every
 * unrecognised non-zero exit, so `finalizeInvocation` recorded the turn as
 * `failed` with `exit_code 1`, `backend_error null` and `error null`: a
 * terminal state with no reason at all, and therefore indistinguishable in
 * durable state from a record in which the runtime lost track of the
 * invocation. A bare non-zero exit *is* a fact about the backend, so it gets a
 * classification of its own.
 */
export const UNRECOGNIZED_BACKEND_FAILURE = 'unrecognized_backend_failure';

const EXCERPT_MAX_CHARS = 200;

/**
 * Strips the backend's terminal ANSI styling and collapses the line, so the
 * excerpt a human reads is the sentence rather than the escape codes.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// Token-shaped runs are replaced rather than truncated: the point of an excerpt
// is to name the failure, and a credential-shaped run is not part of the name.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
];

export function redactLogExcerpt(line: string): string {
  let out = line.replace(ANSI, '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The last non-empty line the backend wrote inside this invocation, redacted
 * and length-capped, or null when there is none.
 *
 * Read from the invocation's own log window only (`start`), so a resumed
 * transcript cannot attribute an earlier invocation's last words to this one.
 */
export function lastLogLineExcerpt(path: string, start: number): string | null {
  let data: Buffer;
  let size: number;
  try {
    size = statSync(path).size;
    const begin = Math.max(start, size - BACKEND_DIAGNOSTIC_MAX_BYTES);
    data = readFileSync(path).subarray(begin, size);
  } catch {
    return null;
  }
  const lines = data.toString('utf8').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const excerpt = redactLogExcerpt(lines[index] ?? '');
    if (excerpt.length > 0) return excerpt.slice(0, EXCERPT_MAX_CHARS);
  }
  return null;
}

interface SessionRow {
  id: string;
  title: string;
  created: number;
}

/**
 * Resolves the OpenCode executable. Antonina looks the backend up by bare
 * name on `PATH` by default, which is the production behaviour.
 *
 * `ANTONINA_OPENCODE_BIN` is a test seam, not a supported user setting: it is
 * how the test suites inject the absolute path of their own fake backend so
 * the backend spawn site can be pinned to a known program. It exists as a
 * production parameter because there is exactly one backend spawn seam
 * (`buildAgentCommand` and the two `spawnSync` probes) and it cannot be
 * reached from a test without it. There is no user-facing documentation of
 * this variable and none is intended; a configuration setting would be a
 * separate front with a README and an intent record.
 *
 * For that reason the value is *required* to be absolute. A bare name or a
 * relative path would be handed to `spawn`, which would then resolve it
 * against `PATH` (or against the cwd) — the exact silent fall-through to a
 * real host backend that this seam exists to rule out — so such a value is
 * refused rather than honoured. The absolute value is used verbatim and is
 * never re-resolved against `PATH`.
 */
export function resolveOpencode(env: Record<string, string | undefined> = process.env): string {
  const configured = env[OPENCODE_BIN_ENV];
  if (configured === undefined) return DEFAULT_OPENCODE_BIN;
  if (configured.length === 0) {
    throw new Error(`${OPENCODE_BIN_ENV} must be a non-empty absolute executable path`);
  }
  if (configured !== configured.trim() || configured.startsWith('-') || configured.includes('\0')) {
    throw new Error(`${OPENCODE_BIN_ENV} must be an executable path without surrounding whitespace`);
  }
  if (!isAbsolute(configured)) {
    throw new Error(
      `${OPENCODE_BIN_ENV} must be an absolute path; a relative value would be resolved against PATH or the cwd instead of pinning the executable`,
    );
  }
  return configured;
}

function parseSessionRows(value: unknown): SessionRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: SessionRow[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string'
      || record.id.length === 0
      || typeof record.title !== 'string'
      || typeof record.created !== 'number'
      || !Number.isFinite(record.created)
    ) return null;
    rows.push({ id: record.id, title: record.title, created: record.created });
  }
  return rows;
}

/**
 * The environment a backend *probe* is handed.
 *
 * Board 197: the per-invocation owner token authorises one runner's claim on one
 * reservation and nothing else, and the probe is not that runner -- it is a short
 * `models`/`session list` the runtime runs beside the invocation. It is dropped
 * here rather than at each call site so no probe can be added later that leaks
 * it by forgetting. `delete` rather than a blank value, so a later spread cannot
 * reintroduce a copy.
 */
function probeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete childEnv[RUNNER_OWNER_TOKEN_ENV];
  return childEnv;
}

export function discoverSessionId(
  agentId: string,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string | null {
  const childEnv = probeEnv(env);
  const result = spawnSync(
    resolveOpencode(childEnv),
    ['session', 'list', '--format', 'json', '--max-count', String(SESSION_LIST_MAX_COUNT)],
    {
      encoding: 'utf8',
      timeout: SESSION_LIST_TIMEOUT_MS,
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const rows = parseSessionRows(value);
  if (rows === null) return null;
  const title = `${OPENCODE_TITLE_PREFIX}${agentId}`;
  const matches = rows.filter((row) => row.title === title);
  matches.sort((left, right) => right.created - left.created || right.id.localeCompare(left.id));
  return matches[0]?.id ?? null;
}

export function configuredModelAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean | null {
  const childEnv = probeEnv(env);
  const result = spawnSync(resolveOpencode(childEnv), ['models'], {
    encoding: 'utf8',
    timeout: MODEL_LIST_TIMEOUT_MS,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).includes(AGENT_MODEL);
}

export function buildAgentCommand(
  meta: AgentMetadata,
  prompt: string,
  isContinue: boolean,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const agentId = requiredPersistedAgentId(meta);
  const cwd = requiredAgentCwd(meta);
  // The durable field is still validated so malformed or old records fail closed,
  // but Antonina's backend variant is a product-level setting rather than a
  // per-agent override. Legacy records may still say `low`; every invocation
  // launched by this build uses the current Antonina default.
  persistedVariant(meta);
  const variant = DEFAULT_VARIANT;
  const executable = resolveOpencode(env);
  if (isContinue) {
    const recorded = persistedNativeSessionId(meta);
    const sessionId = recorded ?? discoverSessionId(agentId, env, cwd);
    if (sessionId === null) return null;
    return [
      executable, 'run', '--auto',
      '--session', sessionId,
      '--model', AGENT_MODEL,
      '--variant', variant,
      '--thinking',
      '--dir', cwd,
      prompt,
    ];
  }
  return [
    executable, 'run', '--auto',
    '--title', `${OPENCODE_TITLE_PREFIX}${agentId}`,
    '--model', AGENT_MODEL,
    '--variant', variant,
    '--thinking',
    '--dir', cwd,
    prompt,
  ];
}


export interface BackendCapabilities {
  /**
   * Whether this backend can launch an invocation in a directory the operator
   * named. OpenCode can: every invocation is a fresh process, `buildAgentCommand`
   * tells it `--dir` and the runner spawns it with `spawn({cwd})` on the same
   * value. A backend that cannot must refuse a declaration *by name*, before
   * any write, rather than running the invocation somewhere else and reporting
   * the declared directory as if it had honoured it.
   */
  invocation_cwd: boolean;
}

/**
 * Test-only override that makes the configured backend report a capability it
 * does not have, so the refusal path can be driven from outside the package.
 *
 * It exists only because `invocation_cwd` is a constant `true`: with one backend
 * and no way to make the answer differ, no test could reach a refusal, and
 * "unreachable" is exactly how a divergence between entry points hides.
 *
 * Deliberately narrow: only the exact value `'1'` withdraws a capability, and
 * every other value (including unset) leaves the backend's real answer alone,
 * so no ordinary environment can reach a different answer. It is a test seam in
 * the same sense and for the same reason as `ANTONINA_OPENCODE_BIN`: it exists
 * as a production parameter because there is exactly one backend seam and no
 * test can reach the other side of it without one. It is not a user setting.
 */
const TEST_WITHDRAW_INVOCATION_CWD_ENV = 'ANTONINA_TEST_BACKEND_NO_INVOCATION_CWD';

export function backendCapabilities(
  env: Record<string, string | undefined> = process.env,
): BackendCapabilities {
  if (env[TEST_WITHDRAW_INVOCATION_CWD_ENV] === '1') return { invocation_cwd: false };
  return { invocation_cwd: true };
}

/**
 * Whether a capability answer may be relied on, failing closed.
 *
 * Only the literal boolean `true` counts as "this backend can honour a named
 * directory". Anything else -- absent, `null`, a string, a capability this
 * runtime does not know the meaning of, a backend that reported a shape it was
 * never asked for -- is treated as "cannot", because the alternative is to run
 * an invocation somewhere the operator did not ask for and report the declared
 * directory as though it had been honoured. An unrecognised capability must
 * never be read as permission.
 */
export function honoursInvocationCwd(capabilities: unknown): boolean {
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) return false;
  return (capabilities as Record<string, unknown>).invocation_cwd === true;
}

export function classifyBackendFailure(
  path: string,
  start: number,
  exitCode: number,
  isContinue = false,
): BackendError | null {
  // A negative code is the runner's encoding of a signal death (`-signum`),
  // not an exit status, and a signal death is classified by
  // `classifySignalDeath`. It must not be read here as a backend failure: an
  // operator's own SIGTERM would then be recorded as the backend dying.
  if (exitCode === 0 || exitCode < 0 || !Number.isSafeInteger(start) || start < 0) return null;
  let data: Buffer;
  let size: number;
  try {
    size = statSync(path).size;
    const begin = Math.max(start, size - BACKEND_DIAGNOSTIC_MAX_BYTES);
    data = readFileSync(path).subarray(begin, size);
  } catch {
    return null;
  }
  const text = data.toString('utf8');
  const rule = BACKEND_FAILURE_RULES.find((candidate) => text.includes(candidate.marker));
  if (rule === undefined) {
    // An empty window is not an unrecognised failure: a spawn that never
    // produced a byte (`child.once('error')` yields exit 127) also exits
    // non-zero, and calling that a backend failure would misattribute it. The
    // runner already has a stated reason for that case.
    if (text.trim().length === 0) return null;
    // A non-zero exit with a readable log window is still a fact about the
    // backend, and it gets a classification. Returning null here is what left
    // the 2026-10-02 deaths recorded as `failed` with no reason anywhere.
    return {
      classification: UNRECOGNIZED_BACKEND_FAILURE,
      provider: null,
      model: AGENT_MODEL,
      request_boundary: isContinue ? 'continuation' : 'fresh_session',
      reference: null,
      transient: false,
      automatic_retry_safe: false,
      fresh_session_useful: null,
      backend_scope: 'unknown',
      diagnostic_bytes: Math.min(Math.max(0, size - start), BACKEND_DIAGNOSTIC_MAX_BYTES),
    };
  }
  const match = /"ref"\s*:\s*"([^"\r\n]+)"/.exec(text);
  return {
    classification: rule.classification,
    provider: rule.provider,
    model: AGENT_MODEL,
    request_boundary: isContinue ? 'continuation' : 'fresh_session',
    reference: match?.[1] ?? null,
    transient: rule.transient,
    automatic_retry_safe: rule.automaticRetrySafe,
    fresh_session_useful: isContinue ? null : false,
    backend_scope: 'unknown',
    diagnostic_bytes: Math.min(Math.max(0, size - start), BACKEND_DIAGNOSTIC_MAX_BYTES),
  };
}

export function backendRetryDelay(error: BackendError | null, attempt: number): number | null {
  if (
    error === null
    || !Number.isSafeInteger(attempt)
    || attempt < 0
    || attempt >= BACKEND_RETRY_MAX_ATTEMPTS
    || error.transient !== true
    || error.automatic_retry_safe !== true
  ) return null;
  return BACKEND_RETRY_BASE_MS * (2 ** attempt);
}

export function sanitizeBackendError(value: unknown): BackendError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const classification = record.classification;
  if (
    typeof classification !== 'string'
    || classification.length === 0
    || classification.length > BACKEND_CLASSIFICATION_MAX_CHARS
  ) return null;

  const result: BackendError = { classification };
  for (const key of ['provider', 'model', 'request_boundary', 'reference', 'backend_scope'] as const) {
    const item = record[key];
    if (item === null) result[key] = null;
    else if (typeof item === 'string' && item.length <= BACKEND_FIELD_MAX_CHARS) {
      if (key === 'request_boundary' && item !== 'fresh_session' && item !== 'continuation') continue;
      result[key] = item as never;
    }
  }
  for (const key of ['transient', 'automatic_retry_safe'] as const) {
    const item = record[key];
    if (typeof item === 'boolean') result[key] = item;
  }
  const fresh = record.fresh_session_useful;
  if (fresh === null || typeof fresh === 'boolean') result.fresh_session_useful = fresh;
  const bytes = record.diagnostic_bytes;
  if (
    typeof bytes === 'number'
    && Number.isSafeInteger(bytes)
    && bytes >= 0
    && bytes <= BACKEND_DIAGNOSTIC_MAX_BYTES
  ) result.diagnostic_bytes = bytes;

  // Signal-death detail is carried only when the classification claims it, so a
  // backend failure can never grow signal fields and start reading like a host
  // kill.
  if (classification === SIGNAL_DEATH_CLASSIFICATION) {
    const signal = record.signal;
    if (typeof signal === 'number' && Number.isSafeInteger(signal) && signal >= 1) result.signal = signal;
    const name = record.signal_name;
    if (name === null || (typeof name === 'string' && name.length > 0 && name.length <= SIGNAL_NAME_MAX_CHARS)) {
      result.signal_name = name;
    }
    const evidence = record.oom_evidence;
    if (evidence === null || (typeof evidence === 'string' && (OOM_EVIDENCE_VALUES as readonly string[]).includes(evidence))) {
      result.oom_evidence = evidence as never;
    }
    for (const key of ['oom_delta', 'oom_kill_delta'] as const) {
      const delta = record[key];
      if (typeof delta === 'number' && Number.isSafeInteger(delta) && delta >= 0) result[key] = delta;
    }
    const lifetime = record.lifetime_seconds;
    if (typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime >= 0) {
      result.lifetime_seconds = lifetime;
    }
  }
  return result;
}
