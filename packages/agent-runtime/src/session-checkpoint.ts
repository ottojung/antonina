import { openSync, readSync, closeSync } from 'node:fs';

/**
 * Reads only the newly appended portion of a fresh OpenCode run's JSONL log.
 * A native session ID is checkpointed as soon as OpenCode emits an event,
 * independently of whether a later session-list probe succeeds.
 *
 * Unknown output and untrusted tool text cannot assert a session: only
 * top-level OpenCode event records with a canonical sessionID are accepted.
 */
const CHUNK_BYTES = 16 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const SESSION_ID = /^ses_[A-Za-z0-9_]+$/;
const EVENT_TYPES = new Set(['step_start', 'step_finish', 'tool_use', 'text', 'error']);

export function sessionIdFromOpenCodeEvent(line: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (!EVENT_TYPES.has(String(event.type))) return null;
  const sessionId = event.sessionID;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  return sessionId;
}

export class SessionCheckpointReader {
  private offset: number;
  private partial = '';
  private discovered: string | null = null;

  constructor(private readonly logFile: string, start: number) {
    this.offset = start;
  }

  /** Incremental and bounded: never reread a whole agent transcript. */
  scan(): string | null {
    if (this.discovered !== null) return this.discovered;
    let fd: number;
    try {
      fd = openSync(this.logFile, 'r');
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      // Reading several chunks makes progress even on a noisy tool transcript.
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const length = readSync(fd, buffer, 0, buffer.length, this.offset);
        if (length <= 0) break;
        this.offset += length;
        const rows = (this.partial + buffer.subarray(0, length).toString('utf8')).split('\n');
        this.partial = rows.pop() ?? '';
        if (Buffer.byteLength(this.partial) > MAX_LINE_BYTES) this.partial = '';
        for (const row of rows) {
          if (Buffer.byteLength(row) > MAX_LINE_BYTES) continue;
          const id = sessionIdFromOpenCodeEvent(row.trim());
          if (id !== null) {
            this.discovered = id;
            return id;
          }
        }
      }
    } finally {
      closeSync(fd);
    }
    return null;
  }
}
