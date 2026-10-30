import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

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
import { configuredModels } from './model-config.js';
import { eligibleAgentModel } from './model-failover.js';

export const OPENCODE_TITLE_PREFIX = 'antonina-';
export const DEFAULT_OPENCODE_BIN = 'opencode';
export const OPENCODE_BIN_ENV = 'ANTONINA_OPENCODE_BIN';
const SESSION_LIST_MAX_COUNT = 100;
const SESSION_LIST_TIMEOUT_MS = 10_000;
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
    model: null,
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
  provider: string | null;
  transient: boolean;
  automaticRetrySafe: boolean;
}

const BACKEND_FAILURE_RULES: readonly BackendFailureRule[] = [
  // Explicit exhausted quota differs from a short network hiccup.
  {
    marker: 'insufficient_quota',
    classification: 'model_quota_exhausted',
    provider: null,
    transient: false,
    automaticRetrySafe: false,
  },
  {
    marker: 'You have reached your usage limit',
    classification: 'model_quota_exhausted',
    provider: null,
    transient: false,
    automaticRetrySafe: false,
  },
  {
    // OpenCode's current OpenAI OAuth quota diagnostic on billy-dev.
    // Treat it as exhausted quota, not an unrecognized retryable failure.
    marker: 'The usage limit has been reached',
    classification: 'model_quota_exhausted',
    provider: null,
    transient: false,
    automaticRetrySafe: false,
  },
  {
    marker: 'usage limit exceeded',
    classification: 'model_quota_exhausted',
    provider: null,
    transient: false,
    automaticRetrySafe: false,
  },
  {
    marker: 'Your credit balance is too low',
    classification: 'model_quota_exhausted',
    provider: null,
    transient: false,
    automaticRetrySafe: false,
  },
  {
    marker: 'model_not_found',
    classification: 'model_unavailable',
    provider: null,
    transient: false,
    automaticRetrySafe: false,
  },
  // Invalid credentials and billing errors need operator action, not another
  // invocation potentially using the same billable credentials.
  {
    marker: 'invalid_api_key',
    classification: 'backend_authentication_failed',
    provider: 'openai',
    transient: false,
    automaticRetrySafe: false,
  },
  {
    marker: 'Payment Required',
    classification: 'backend_billing_required',
    provider: 'openai',
    transient: false,
    automaticRetrySafe: false,
  },
  // An OpenCode Go request may fail temporarily even after the previous
  // turn has performed tool actions. Classify the outage for operators and
  // the scheduler, and the operator explicitly accepts at-least-once tool effects on recovery.
  {
    marker: 'Endpoint is unavailable',
    classification: 'upstream_endpoint_unavailable',
    provider: 'opencode-go',
    transient: true,
    automaticRetrySafe: true,
  },
  // The OpenCode Go Step 5 free tier can reject requests across many sessions
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
// OpenCode emits structured JSONL API errors for fresh run invocations.
// Real OAuth/provider errors may contain only statusCode 429 or 503 rather
// than one of the older provider-specific prose diagnostics. Inspect
// top-level OpenCode error events, not arbitrary JSON in tool output.
function structuredBackendFailureRule(text: string): BackendFailureRule | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index]!); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type !== 'error' || typeof event.error !== 'object' || event.error === null || Array.isArray(event.error)) continue;
    const error = event.error as Record<string, unknown>;
    // OpenCode V2 emits provider errors as typed top-level error events,
    // including provider.no-route for a configured but unavailable model.
    if (error.type === 'provider.no-route') {
      return {
        marker: 'OpenCode V2 provider.no-route',
        classification: 'model_unavailable',
        provider: null,
        transient: false,
        automaticRetrySafe: false,
      };
    }
    if (error.name !== 'APIError' || typeof error.data !== 'object' || error.data === null || Array.isArray(error.data)) continue;
    const data = error.data as Record<string, unknown>;
    const statusCode = data.statusCode;
    if (statusCode === 401 || statusCode === 402) {
      return {
        marker: statusCode === 401 ? 'OpenCode APIError HTTP 401' : 'OpenCode APIError HTTP 402',
        classification: statusCode === 401 ? 'backend_authentication_failed' : 'backend_billing_required',
        provider: null,
        transient: false,
        automaticRetrySafe: false,
      };
    }
    if (statusCode === 404 && typeof data.message === 'string'
      && /model_not_found|model not found|unknown model/i.test(data.message)) {
      return {
        marker: 'OpenCode APIError unknown model',
        classification: 'model_unavailable',
        provider: null,
        transient: false,
        automaticRetrySafe: false,
      };
    }
    if (statusCode === 429) {
      return {
        marker: 'OpenCode APIError HTTP 429',
        classification: 'upstream_rate_limited',
        provider: null,
        transient: true,
        automaticRetrySafe: false,
      };
    }
    if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 500 && statusCode < 600) {
      return {
        marker: 'OpenCode APIError HTTP 5xx',
        classification: 'transient_backend_server_error',
        provider: null,
        transient: true,
        automaticRetrySafe: false,
      };
    }
  }
  return undefined;
}

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
 * `session list` the runtime runs beside the invocation. It is dropped
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
  childEnv.PWD = cwd;
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

/** The configured order is authoritative. Never probe the OpenCode model catalog. */
export function selectConfiguredModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return configuredModels(env)[0]!.model;
}

/** Per-agent selection skips only this agent's unexpired model cooldowns. */
export function selectConfiguredAgentModel(
  meta: AgentMetadata,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now() / 1000,
  excludedModels: ReadonlySet<string> = new Set(),
): string {
  const chosen = eligibleAgentModel(meta, configuredModels(env), now, undefined, excludedModels);
  if (chosen === null) throw new Error('No eligible configured model: all candidates have an active quota, rate limit, hard exclusion, or were tried this invocation');
  return chosen;
}

export function buildAgentCommand(
  meta: AgentMetadata,
  prompt: string,
  isContinue: boolean,
  env: Record<string, string | undefined> = process.env,
  excludedModels: ReadonlySet<string> = new Set(),
  modelEnv: Record<string, string | undefined> = env,
): string[] | null {
  const agentId = requiredPersistedAgentId(meta);
  const cwd = requiredAgentCwd(meta);
  // OpenCode V2 uses the process cwd (set by the runner) instead of a --dir flag.
  // Canonical V2 records have a product-level variant; it is not an
  // override supplied by an obsolete OpenCode CLI flag.
  persistedVariant(meta);
  const variant = DEFAULT_VARIANT;
  const executable = resolveOpencode(env);
  const model = selectConfiguredAgentModel(meta, modelEnv, Date.now() / 1000, excludedModels);
  if (isContinue) {
    const recorded = persistedNativeSessionId(meta);
    const sessionId = recorded ?? discoverSessionId(agentId, env, cwd);
    if (sessionId === null) return null;
    return [
      executable, 'run', '--auto',
      '--format', 'json',
      '--session', sessionId,
      '--model', `${model}#${variant}`,
      '--thinking',
      prompt,
    ];
  }
  return [
    executable, 'run', '--auto',
    '--format', 'json',
    '--title', `${OPENCODE_TITLE_PREFIX}${agentId}`,
    '--model', `${model}#${variant}`,
    '--thinking',
    prompt,
  ];
}


/**
 * Service administration must never inherit an agent's invocation markers:
 * these markers identify processes eligible for per-agent orphan cleanup.
 * The shared background service is not an agent subprocess.
 */
function serviceAdministrationEnv(
  env: Record<string, string | undefined>,
  cwd: string,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...process.env, ...env, PWD: cwd };
  for (const marker of ['ANTONINA_AGENT_ID', 'ANTONINA_INVOCATION_ID', 'ANTONINA_PROMPT', RUNNER_OWNER_TOKEN_ENV]) {
    delete sanitized[marker];
  }
  return sanitized;
}

/**
 * Copy a V2 session into a distinct child before publishing a forked agent.
 * Shared-server agents must never write the same native session concurrently.
 */
export function forkBackendSession(
  source: AgentMetadata,
  env: Record<string, string | undefined>,
): string | null {
  const parent = persistedNativeSessionId(source);
  if (parent === null) return null;
  const cwd = requiredAgentCwd(source);
  const executable = resolveOpencode(env);
  ensureHostV2Service(executable, env, cwd);
  const result = spawnSync(
    executable,
    ['api', 'session.fork', '--param', 'sessionID=' + parent, '--data', '{}'],
    { cwd, env: serviceAdministrationEnv(env, cwd), encoding: 'utf8', timeout: 15_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error('OpenCode V2 could not fork its native session: ' + (result.stderr || result.error?.message || 'server unavailable').slice(0, 300));
  }
  let decoded: unknown;
  try { decoded = JSON.parse(result.stdout); }
  catch { throw new Error('OpenCode V2 returned invalid fork session JSON'); }
  const response = decoded as { data?: { id?: unknown }; id?: unknown };
  const id = response?.data?.id ?? response?.id;
  if (typeof id !== 'string' || !/^ses_[A-Za-z0-9_]+$/.test(id) || id === parent) {
    throw new Error('OpenCode V2 did not return a distinct child session ID');
  }
  return id;
}

/**
 * Stop server-side work for precisely one native session. Never kill/restart the
 * shared server and never start a new service merely to interrupt a dead one.
 */
export function interruptBackendSession(
  meta: AgentMetadata,
  env: Record<string, string | undefined>,
): boolean {
  const session = persistedNativeSessionId(meta);
  if (session === null) return false;
  const cwd = requiredAgentCwd(meta);
  const childEnv = serviceAdministrationEnv(env, cwd);
  const executable = resolveOpencode(env);
  const service = spawnSync(executable, ['service', 'status'], {
    cwd, env: childEnv, encoding: 'utf8', timeout: 2_500,
  });
  if (service.error || service.status !== 0) return false;
  // Only a real bound V2 service URL may authorize a remote interrupt.
  // A fake or malformed service-status result is not authority to issue API calls.
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+\/?$/.test(service.stdout.trim())) return false;
  const result = spawnSync(executable, [
    'api', 'session.interrupt', '--param', 'sessionID=' + session,
    '--param', 'resume=false',
  ], { cwd, env: childEnv, encoding: 'utf8', timeout: 5_000 });
  return !result.error && result.status === 0;
}

/**
 * Identify the official native V2 CLI (ELF, Mach-O or PE).
 * Script-only fake backends in protocol unit tests do not manage services.
 */
function isNativeOpenCodeExecutable(executable: string, env: Record<string, string | undefined>): boolean {
  const candidates = executable.includes('/')
    ? [executable]
    : (env.PATH ?? process.env.PATH ?? '').split(delimiter).map((part) => join(part || '.', executable));
  for (const candidate of candidates) {
    let fd: number;
    try { fd = openSync(candidate, 'r'); } catch { continue; }
    const header = Buffer.alloc(4);
    let bytes = 0;
    try { bytes = readSync(fd, header, 0, 4, 0); }
    finally { closeSync(fd); }
    if (bytes < 4) return false;
    if (header[0] === 0x7f && header.subarray(1).toString('ascii') === 'ELF') return true;
    if (header[0] === 0x4d && header[1] === 0x5a) return true;
    const magic = header.readUInt32BE(0);
    return magic === 0xfeedface || magic === 0xfeedfacf
      || magic === 0xcefaedfe || magic === 0xcffaedfe;
  }
  return false;
}

/**
 * Start/discover the dedicated host service BEFORE spawning a marked invocation.
 * The V2 service inherits invocation markers if started by the CLI client, so
 * orphan cleanup for that one agent could otherwise kill all agents' service.
 * The service starts with no agent markers. Automatic V2 service discovery
 * also supplies the locally generated password (explicit --server does not).
 */
export function ensureHostV2Service(
  executable: string,
  env: Record<string, string | undefined>,
  cwd: string,
): string | null {
  if (!isNativeOpenCodeExecutable(executable, env)) return null;
  const cleanEnv = serviceAdministrationEnv(env, cwd);
  const localUrl = (output: string): string | null => {
    const value = output.trim();
    return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+\/?$/.test(value)
      ? value : null;
  };
  const status = spawnSync(executable, ['service', 'status'], {
    cwd, env: cleanEnv, encoding: 'utf8', timeout: 8_000,
  });
  if (!status.error && status.status === 0) {
    const present = localUrl(status.stdout);
    if (present !== null) return present;
  }
  const started = spawnSync(executable, ['service', 'start'], {
    cwd, env: cleanEnv, encoding: 'utf8', timeout: 20_000,
  });
  const url = started.error || started.status !== 0 ? null : localUrl(started.stdout);
  if (url === null) {
    throw new Error('OpenCode V2 host service unavailable: ' + (started.stderr || started.error?.message || 'missing loopback endpoint').slice(0, 250));
  }
  return url;
}

export interface BackendCapabilities {
  /**
   * Whether this backend can launch an invocation in a directory the operator
   * named. OpenCode can: every invocation is a fresh process, `buildAgentCommand`
   * the runner sets both `spawn({cwd})` and `PWD` to the declared
   * directory. A backend that cannot must refuse a declaration *by name*, before
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

/**
 * Respect a documented provider quota reset in the current invocation log.
 * Nested JSON is escaped once in OpenCode's JSONL response body.
 * If the hint is missing or unsafe, retain the default model cooldown.
 */
export function quotaResetDelaySeconds(
  path: string, start: number, now = Date.now() / 1000,
): number | null {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isFinite(now)) return null;
  let text: string;
  try {
    const size = statSync(path).size;
    const begin = Math.max(start, size - BACKEND_DIAGNOSTIC_MAX_BYTES);
    text = readFileSync(path).subarray(begin, size).toString('utf8');
  } catch {
    return null;
  }
  const decoded = text.replace(/\\\"/g, '"');
  if (!decoded.includes('usage_limit_reached')) return null;
  const matches = [...decoded.matchAll(/"resets_at"\s*:\s*(\d{10})/g)];
  const resetAt = Number(matches.at(-1)?.[1]);
  if (!Number.isSafeInteger(resetAt) || resetAt <= now || resetAt > now + 6 * 3600) return null;
  return Math.min(6 * 3600, Math.max(60, Math.ceil(resetAt - now) + 120));
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
  const rule = BACKEND_FAILURE_RULES.find((candidate) => text.includes(candidate.marker))
    ?? structuredBackendFailureRule(text);
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
      model: null,
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
    model: null,
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
  // Endpoint outages are recoverable even if earlier tool calls may replay.
  // Retry without an attempt cap; cap the delay to prevent excessive latency.
  if (error?.classification === 'upstream_endpoint_unavailable'
      && error.transient === true && error.automatic_retry_safe === true
      && Number.isSafeInteger(attempt) && attempt >= 0) {
    return Math.min(30_000, BACKEND_RETRY_BASE_MS * (2 ** Math.min(attempt, 6)));
  }
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
