import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { persistedNativeSessionId, type AgentMetadata } from './metadata.js';
import { configuredModels } from './model-config.js';
import { agentModelFailover } from './model-failover.js';
import { readProcStat, type ProcStat } from './process.js';

/**
 * A model request with no backend output for this long is suspected stalled.
 * The watchdog never applies this duration to a tool execution or an unknown
 * backend phase: elapsed time is evidence about silence, not proof of failure.
 */
export const MODEL_STEP_SILENCE_MS = 15 * 60 * 1000;
export const LIVENESS_POLL_MS = 5_000;
const READ_CHUNK_BYTES = 16 * 1024;
const MAX_JSONL_ROW_BYTES = 64 * 1024;
const MAX_SCAN_BYTES_PER_POLL = 256 * 1024;
const SESSION_ID = /^ses_[A-Za-z0-9_]+$/;

export type AgentLivenessDiagnosis =
  | 'model_step_silent'
  | 'host_io_blocked'
  | 'process_unavailable'
  | 'progressing_or_uncertain';

export interface LivenessObservation {
  diagnosis: AgentLivenessDiagnosis;
  silentMs: number;
  processState: string | null;
}

/**
 * Tracks only bytes appended by this particular invocation, and the phase of
 * authoritative OpenCode JSON events. In particular, a long-running tool can
 * be silent indefinitely without making a model-step-stall candidate.
 *
 * An incomplete, oversized, non-JSON, or unrecognized event invalidates phase
 * evidence, rather than accidentally justifying a restart.
 */
export class InvocationActivity {
  private offset: number;
  private lastOutputAt: number;
  private phase: 'model_step' | 'unknown' = 'unknown';
  private partial = '';
  private observedSize: number;

  constructor(
    private readonly file: string,
    startOffset: number,
    now = Date.now(),
    private readonly readStat: (pid: number) => ProcStat | null = readProcStat,
  ) {
    this.offset = startOffset;
    this.observedSize = startOffset;
    this.lastOutputAt = now;
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_JSONL_ROW_BYTES) {
      this.phase = 'unknown';
      return;
    }
    let event: unknown;
    try { event = JSON.parse(line); } catch {
      this.phase = 'unknown';
      return;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      this.phase = 'unknown';
      return;
    }
    const record = event as Record<string, unknown>;
    if (typeof record.sessionID !== 'string' || !SESSION_ID.test(record.sessionID)) {
      this.phase = 'unknown';
      return;
    }
    // step_start is the one positive event proving OpenCode entered a new
    // model step. A tool-use/step-finish/text/error is NOT such evidence.
    this.phase = record.type === 'step_start' ? 'model_step' : 'unknown';
  }

  private pollLog(now: number): void {
    const st = statSync(this.file, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) {
      this.phase = 'unknown';
      return;
    }
    if (st.size < this.offset || st.size < this.observedSize) {
      this.phase = 'unknown';
      this.offset = st.size;
      this.observedSize = st.size;
      this.partial = '';
      this.lastOutputAt = now;
      return;
    }
    if (st.size !== this.observedSize) {
      // New output makes a previous silence observation obsolete regardless
      // of whether its contents are valid JSON.
      this.lastOutputAt = now;
      this.observedSize = st.size;
    }
    if (st.size === this.offset) return;
    let fd: number;
    try { fd = openSync(this.file, 'r'); } catch {
      this.phase = 'unknown';
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
          this.phase = 'unknown';
        }
        for (const line of lines) this.acceptLine(line);
      }
      if (this.offset < st.size) {
        // Cannot establish the final event state from a truncated scan.
        this.phase = 'unknown';
        this.offset = st.size;
        this.partial = '';
      }
    } finally { closeSync(fd); }
  }

  observe(pid: number, startTicks: number, now = Date.now(), quietMs = MODEL_STEP_SILENCE_MS): LivenessObservation {
    try { this.pollLog(now); } catch {
      this.phase = 'unknown';
    }
    const stat = this.readStat(pid);
    if (stat === null || stat.startTicks !== startTicks || stat.state === 'Z' || stat.state === 'X') {
      return { diagnosis: 'process_unavailable', silentMs: now - this.lastOutputAt, processState: stat?.state ?? null };
    }
    const silentMs = Math.max(0, now - this.lastOutputAt);
    if (stat.state === 'D' && silentMs >= quietMs) {
      // D-state is host/kernel I/O, not evidence that a model is faulty.
      return { diagnosis: 'host_io_blocked', silentMs, processState: stat.state };
    }
    if (stat.state === 'S' && this.phase === 'model_step' && this.partial.length === 0 && silentMs >= quietMs) {
      return { diagnosis: 'model_step_silent', silentMs, processState: stat.state };
    }
    return { diagnosis: 'progressing_or_uncertain', silentMs, processState: stat.state };
  }
}

/** A watchdog must never kill an invocation unless safe same-session fallback exists. */
export function safeAlternativeModel(
  meta: AgentMetadata,
  activeModel: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now() / 1000,
): boolean {
  if (persistedNativeSessionId(meta) === null) return false;
  try {
    const exclusions = agentModelFailover(meta).cooldowns;
    return configuredModels(env).some(({ model }) =>
      model !== activeModel && !exclusions.some((entry) => entry.model === model && entry.until > now));
  } catch { return false; }
}
