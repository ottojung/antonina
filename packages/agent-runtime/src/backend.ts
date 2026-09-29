import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { isAbsolute } from 'node:path';

import { DEFAULT_VARIANT, persistedNativeSessionId, persistedVariant, requiredAgentCwd, requiredPersistedAgentId, type AgentMetadata } from './metadata.js';
import type { OomCounters } from './host-capacity.js';

export const AGENT_MODEL = 'opencode/space-bunny-free';
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

interface BackendFailureRule {
  marker: string;
  classification: string;
  provider: string;
  transient: boolean;
  automaticRetrySafe: boolean;
}

const BACKEND_FAILURE_RULES: readonly BackendFailureRule[] = [
  {
    marker: 'Unexpected server error',
    classification: 'transient_backend_server_error',
    provider: 'opencode',
    transient: true,
    automaticRetrySafe: false,
  },
];

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

export function discoverSessionId(
  agentId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const childEnv = { ...process.env, ...env };
  const result = spawnSync(
    resolveOpencode(childEnv),
    ['session', 'list', '--format', 'json', '--max-count', String(SESSION_LIST_MAX_COUNT)],
    {
      encoding: 'utf8',
      timeout: SESSION_LIST_TIMEOUT_MS,
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
  const childEnv = { ...process.env, ...env };
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
  const variant = persistedVariant(meta) || DEFAULT_VARIANT;
  const executable = resolveOpencode(env);
  if (isContinue) {
    const recorded = persistedNativeSessionId(meta);
    const sessionId = recorded ?? discoverSessionId(agentId, env);
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


export function classifyBackendFailure(
  path: string,
  start: number,
  exitCode: number,
  isContinue = false,
): BackendError | null {
  if (exitCode === 0 || !Number.isSafeInteger(start) || start < 0) return null;
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
  if (!rule) return null;
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
