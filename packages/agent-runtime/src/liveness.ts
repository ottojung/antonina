import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { persistedNativeSessionId, type AgentMetadata } from './metadata.js';
import { configuredModels } from './model-config.js';
import { agentModelFailover, eligibleAgentModel } from './model-failover.js';
import { readProcStat, type ProcStat } from './process.js';
import { typedProviderFailure } from './provider-errors.js';

/**
 * No-output startup and unfinished model steps receive the same conservative
 * timeout. A structured provider error is stronger evidence: allow OpenCode
 * a short grace to exit by itself before recovering its existing session.
 *
 * Eight minutes, measured on billy-dev over 70,859 completed model steps
 * (2026-11-05..15): 99% produced their first event within 93 seconds and
 * 99.9% within 429 seconds. The previous fifteen-minute window equalled
 * OpenCode's own request timeout, so OpenCode re-issued a hung request (a new
 * step_start for the same message) at the very moment this watchdog would
 * have fired, and a rate-limited model was retried silently for hours. The
 * step clock below therefore also ignores such re-issues: see
 * `InvocationActivity.stepStartedAt`.
 */
export const MODEL_STEP_SILENCE_MS = 8 * 60 * 1000;
export const FIRST_STEP_UNANSWERED_MS = 180_000;
export const STARTUP_SILENCE_MS = 90 * 1000;
export const BACKEND_ERROR_GRACE_MS = 30_000;
export const LIVENESS_POLL_MS = 5_000;
const READ_CHUNK_BYTES = 16 * 1024;
const MAX_JSONL_ROW_BYTES = 64 * 1024;
const MAX_SCAN_BYTES_PER_POLL = 256 * 1024;
const SESSION_ID = /^ses_[A-Za-z0-9_]+$/;

export type RecoverableBackendClassification =
  | 'model_quota_exhausted'
  | 'upstream_rate_limited'
  | 'model_unavailable'
  | 'transient_backend_server_error'
  | 'upstream_endpoint_unavailable'
  | 'backend_authentication_failed'
  | 'backend_billing_required';

export type AgentLivenessDiagnosis =
  | 'model_step_silent'
  | 'startup_silent'
  | 'step_finished_silent'
  | 'unverifiable_silent'
  | 'tool_running_silent'
  | 'backend_error_silent'
  | 'host_io_blocked'
  | 'process_unavailable'
  | 'progressing_or_uncertain';

export interface LivenessObservation {
  diagnosis: AgentLivenessDiagnosis;
  silentMs: number;
  processState: string | null;
  backendFailure: RecoverableBackendClassification | null;
}

/**
 * Trust only top-level OpenCode APIError events, never diagnostics embedded
 * in a tool response. Authentication/billing/unknown errors are not model
 * switching authority, even if their text happens to contain a quota phrase.
 */
export function recoverableOpenCodeError(event: Record<string, unknown>): RecoverableBackendClassification | null {
  if (event.type !== 'error' || typeof event.error !== 'object' || event.error === null
    || Array.isArray(event.error)) return null;
  const error = event.error as Record<string, unknown>;
  // OpenCode V2 typed provider errors (provider.quota, provider.rate-limit,
  // provider.free-limit, ...). Without this a V2 quota event left the phase
  // "unknown" and the invocation was never interrupted on its evidence.
  if (typeof error.type === 'string' && error.type.startsWith('provider.')) {
    return typedProviderFailure(error);
  }
  if (error.name !== 'APIError' || typeof error.data !== 'object' || error.data === null
    || Array.isArray(error.data)) return null;
  const data = error.data as Record<string, unknown>;
  const message = typeof data.message === 'string' ? data.message.toLowerCase() : '';
  const code = data.statusCode;
  // A credential or billing failure is hard and provider-scoped, not a
  // transient model failure. A distinct provider may still be eligible.
  if (code === 401 || /invalid_api_key|invalid api key|authentication failed/.test(message)) {
    return 'backend_authentication_failed';
  }
  if (code === 402 || /payment required|billing required|credit balance/.test(message)) {
    return 'backend_billing_required';
  }
  if (code === 403) return null; // Ambiguous permission failures are not retry authority.
  if (message.includes('model_not_found') || message.includes('model not found')) return 'model_unavailable';
  if (message.includes('insufficient_quota') || message.includes('the usage limit has been reached')
    || message.includes('usage limit exceeded') || message.includes('you have reached your usage limit')
    || message.includes('quota exhausted')) return 'model_quota_exhausted';
  if (code === 429 || message.includes('rate limit exceeded') || message.includes('too many requests')) {
    return 'upstream_rate_limited';
  }
  if (typeof code === 'number' && Number.isInteger(code) && code >= 500 && code < 600) {
    return 'transient_backend_server_error';
  }
  if (message.includes('endpoint is unavailable') || message.includes('upstream endpoint unavailable')) {
    return 'upstream_endpoint_unavailable';
  }
  return null;
}

/**
 * Tracks only this invocation's appended output and authoritative JSONL event
 * boundaries. Tool execution remains protected; a finished tool-call step is
 * not a running tool and must not become an indefinite blind spot. Silent startup is considered only when a durable native
 * session and another eligible model permit same-session recovery.
 *
 * The known OpenCode status footer (> build · model) is presentation, not a
 * new tool or model step. It may follow a structured provider error; do not
 * erase that reliable failure evidence merely because OpenCode writes a footer.
 */
export class InvocationActivity {
  private offset: number;
  private lastOutputAt: number;
  private phase: 'startup' | 'model_step' | 'tool_running' | 'step_finished' | 'backend_error' | 'unknown' = 'startup';
  private backendFailure: RecoverableBackendClassification | null = null;
  private partial = '';
  private observedSize: number;
  /**
   * When the model request now in flight was FIRST issued, or null outside a
   * model step. OpenCode re-issues a request that timed out or was refused by
   * writing another step_start for the same message with nothing in between.
   * That line is output, so it resets `lastOutputAt`, but it is not progress:
   * measuring silence from the latest re-issue let a provider that never
   * answered hold an agent indefinitely. Any other event ends the step clock.
   */
  private stepStartedAt: number | null = null;
  private stepMessageId: string | null = null;
  // Early recovery is only a first unanswered request, never an already
  // answered request, a later step, or an uncertain observation.
  private firstRequestEligible = true;
  private firstSession: string | null = null;
  /** The poll time being processed; acceptLine has no clock of its own. */
  private pollNow: number;

  constructor(
    private readonly file: string,
    startOffset: number,
    now = Date.now(),
    private readonly readStat: (pid: number) => ProcStat | null = readProcStat,
  ) {
    this.offset = startOffset;
    this.observedSize = startOffset;
    this.lastOutputAt = now;
    this.pollNow = now;
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    // OpenCode's terminal footer is not a new operation. Its syntax is
    // deliberately narrow: arbitrary unstructured output still fails closed.
    // eslint-disable-next-line no-control-regex
    const plain = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
    if (/^>\s+(?:build|plan|general)\s+·\s+[A-Za-z0-9_.-]+$/.test(plain)) return;
    if (Buffer.byteLength(line) > MAX_JSONL_ROW_BYTES) {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
      this.stepStartedAt = null;
      return;
    }
    let event: unknown;
    try { event = JSON.parse(line); } catch {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
      this.stepStartedAt = null;
      return;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
      this.stepStartedAt = null;
      return;
    }
    const record = event as Record<string, unknown>;
    if (typeof record.sessionID !== 'string' || !SESSION_ID.test(record.sessionID)) {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
      this.stepStartedAt = null;
      return;
    }
    if (record.type === 'step_start') {
      const part = record.part;
      const messageId = typeof part === 'object' && part !== null && !Array.isArray(part)
        && typeof (part as Record<string, unknown>).messageID === 'string'
        ? (part as Record<string, unknown>).messageID as string : null;
      // A step_start directly after a step_start, for the same message (or
      // with no message identity to tell them apart), is the backend
      // re-issuing one request. Keep the original start time.
      const reissued = this.phase === 'model_step' && this.stepStartedAt !== null
        && (messageId === null || this.stepMessageId === null || messageId === this.stepMessageId);
      if (typeof part !== 'object' || part === null || Array.isArray(part)
        || (part as Record<string, unknown>).type !== 'step-start') this.firstRequestEligible = false;
      if (this.firstSession === null) this.firstSession = record.sessionID;
      else if (!reissued || record.sessionID !== this.firstSession) this.firstRequestEligible = false;
      if (!reissued) this.stepStartedAt = this.pollNow;
      this.stepMessageId = messageId ?? this.stepMessageId;
      this.phase = 'model_step';
      this.backendFailure = null;
      return;
    }
    // Every other well-formed event shows the request was answered (or
    // failed); the step clock no longer applies.
    this.firstRequestEligible = false;
    this.stepStartedAt = null;
    this.stepMessageId = null;
    if (record.type === 'tool_use') {
      // No automatic interruption while a tool might still be executing,
      // including after a single tool reports completion in a parallel batch.
      // Only the enclosing step_finish proves all tool calls have returned.
      this.phase = 'tool_running';
      this.backendFailure = null;
    } else if (record.type === 'step_finish') {
      // OpenCode emits this AFTER tool results, before starting another model
      // request. It is an authoritative boundary, not an in-flight tool.
      // Both tool-calls and stop/other finish reasons must exit or continue.
      this.phase = 'step_finished';
      this.backendFailure = null;
    } else if (record.type === 'error') {
      const failure = recoverableOpenCodeError(record);
      this.backendFailure = failure;
      this.phase = failure === null ? 'unknown' : 'backend_error';
    }
    // Text, reasoning, and unknown well-formed events do not invalidate the
    // last authoritative step/tool boundary; only new authoritative events do.
  }

  private pollLog(now: number): void {
    this.pollNow = now;
    const st = statSync(this.file, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
      return;
    }
    if (st.size < this.offset || st.size < this.observedSize) {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
      this.offset = st.size;
      this.observedSize = st.size;
      this.partial = '';
      this.lastOutputAt = now;
      return;
    }
    if (st.size !== this.observedSize) {
      // New output makes the previous silence observation obsolete.
      this.lastOutputAt = now;
      this.observedSize = st.size;
    }
    if (st.size === this.offset) return;
    let fd: number;
    try { fd = openSync(this.file, 'r'); } catch {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
      return;
    }
    try {
      const bytes = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let budget = MAX_SCAN_BYTES_PER_POLL;
      while (this.offset < st.size && budget > 0) {
        const read = readSync(fd, bytes, 0, Math.min(bytes.length, budget, st.size - this.offset), this.offset);
        if (read <= 0) break;
        this.offset += read;
        budget -= read;
        const lines = (this.partial + bytes.toString('utf8', 0, read)).split('\n');
        this.partial = lines.pop() ?? '';
        if (Buffer.byteLength(this.partial) > MAX_JSONL_ROW_BYTES) {
          this.partial = '';
          this.firstRequestEligible = false;
          this.phase = 'unknown';
          this.backendFailure = null;
        }
        for (const line of lines) this.acceptLine(line);
      }
      if (this.offset < st.size) {
        // A truncated scan cannot establish the final event state.
        this.firstRequestEligible = false;
        this.phase = 'unknown';
        this.backendFailure = null;
        this.offset = st.size;
        this.partial = '';
      }
    } finally { closeSync(fd); }
  }

  unansweredFirstStep(session: string, now: number, quietMs = FIRST_STEP_UNANSWERED_MS): boolean {
    return this.firstRequestEligible && this.firstSession === session
      && this.phase === 'model_step' && this.partial.length === 0
      && this.stepStartedAt !== null && now - this.stepStartedAt >= quietMs;
  }

  observe(
    pid: number,
    startTicks: number,
    now = Date.now(),
    quietMs = MODEL_STEP_SILENCE_MS,
    errorGraceMs = BACKEND_ERROR_GRACE_MS,
  ): LivenessObservation {
    try { this.pollLog(now); } catch {
      this.firstRequestEligible = false;
      this.phase = 'unknown';
      this.backendFailure = null;
    }
    const stat = this.readStat(pid);
    const silentMs = Math.max(0, now - this.lastOutputAt);
    const observation = (diagnosis: AgentLivenessDiagnosis): LivenessObservation => ({
      diagnosis, silentMs, processState: stat?.state ?? null,
      backendFailure: diagnosis === 'backend_error_silent' ? this.backendFailure : null,
    });
    if (stat === null || stat.startTicks !== startTicks || stat.state === 'Z' || stat.state === 'X') {
      return observation('process_unavailable');
    }
    if (stat.state === 'D' && silentMs >= Math.min(quietMs, errorGraceMs)) {
      // Host/kernel I/O is not a model failure.
      return observation('host_io_blocked');
    }
    if (stat.state !== 'S') return observation('progressing_or_uncertain');
    // A partial/corrupt frame or missing log cannot prove that the backend
    // is inside a model request. Surface it rather than silently treating a
    // permanent unknown phase as healthy (the caller must not auto-replay it).
    if (silentMs >= quietMs && (this.partial.length > 0 || this.phase === 'unknown')) {
      return observation('unverifiable_silent');
    }
    if (this.partial.length > 0) return observation('progressing_or_uncertain');
    if (this.phase === 'backend_error' && silentMs >= errorGraceMs) return observation('backend_error_silent');
    if (this.phase === 'startup' && silentMs >= Math.min(quietMs, STARTUP_SILENCE_MS)) return observation('startup_silent');
    // Inside a model step, silence runs from the first issue of the request,
    // not from the backend's latest re-issue of it.
    if (this.phase === 'model_step' && this.stepStartedAt !== null && now - this.stepStartedAt >= quietMs) {
      return { ...observation('model_step_silent'), silentMs: Math.max(silentMs, now - this.stepStartedAt) };
    }
    if (silentMs >= quietMs) {
      if (this.phase === 'model_step') return observation('model_step_silent');
      if (this.phase === 'startup') return observation('startup_silent');
      if (this.phase === 'step_finished') return observation('step_finished_silent');
      if (this.phase === 'tool_running') return observation('tool_running_silent');
    }
    return observation('progressing_or_uncertain');
  }
}

/**
 * Interrupt only when another untried model can continue the same session.
 * Soft transient penalties stay eligible; quota and hard exclusions do not.
 */
export function safeAlternativeModel(
  meta: AgentMetadata,
  activeModel: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now() / 1000,
  alreadyTried: ReadonlySet<string> = new Set(),
  classification: RecoverableBackendClassification | null = null,
): boolean {
  if (persistedNativeSessionId(meta) === null) return false;
  try {
    const models = configuredModels(env);
    const excluded = new Set([...alreadyTried, activeModel]);
    if (classification === 'backend_authentication_failed' || classification === 'backend_billing_required') {
      const provider = activeModel.split('/')[0];
      for (const entry of models) {
        if (entry.model.split('/')[0] === provider) excluded.add(entry.model);
      }
    }
    return eligibleAgentModel(meta, models, now, undefined, excluded) !== null;
  } catch { return false; }
}

/** Faster interruption requires a genuinely unpenalized, configured alternative.
 * No shared observation can authorize a model, remove a hard exclusion, or
 * escape the same invocation's config scope. */
export function healthyAlternativeForEarlyRecovery(
  meta: AgentMetadata, activeModel: string, env: Record<string, string | undefined>,
  now: number, alreadyTried: ReadonlySet<string>, unreliable: ReadonlySet<string>,
): boolean {
  if (persistedNativeSessionId(meta) === null || !unreliable.has(activeModel)) return false;
  try {
    const cooldowns = new Set(agentModelFailover(meta).cooldowns
      .filter(entry => entry.until > now).map(entry => entry.model));
    return configuredModels(env).some(({model}) => model !== activeModel
      && !alreadyTried.has(model) && !unreliable.has(model) && !cooldowns.has(model));
  } catch { return false; }
}
