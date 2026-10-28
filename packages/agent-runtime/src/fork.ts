/**
 * Fork a managed agent by copying a distinct OpenCode V2 child session.
 * A clone shares history, not an executable session identity. This prevents
 * one agent from steering or interrupting another on the shared V2 server.
 */
import {
  AGENT_META_VERSION,
  deletePendingFlag,
  validateAgentMetadata,
  type AgentMetadata,
} from './metadata.js';
import { persistedAgentId } from './process.js';
import {
  createAgentDirectory,
  readMeta,
  removeAgentDirectory,
  writeMeta,
  type StatePathsOptions,
} from './store.js';

export class AgentForkSourceMissingError extends Error {
  constructor(agentId: string) {
    super(`cannot fork: no managed agent with id ${agentId}`);
    this.name = 'AgentForkSourceMissingError';
  }
}

export class AgentForkTargetExistsError extends Error {
  constructor(agentId: string) {
    super(`cannot fork: managed agent with id ${agentId} already exists`);
    this.name = 'AgentForkTargetExistsError';
  }
}

export class AgentForkSourceBusyError extends Error {
  constructor(agentId: string, reason: string) {
    super(`cannot fork agent ${agentId}: it ${reason}; a fork cannot outlive the source's own deletion`);
    this.name = 'AgentForkSourceBusyError';
  }
}

export type ForkBlocker = 'delete_pending';

/**
 * Why this source may not be forked right now, or `null` when it may.
 *
 * There is exactly one rung, and it is not about live work. It is that the
 * source's durable authority is being revoked: a `delete_pending` record is a
 * tombstone whose directory is on its way out, so it is not a stable thing to
 * snapshot, and a clone taken from one would outlive a deletion the operator
 * asked for. That is a different hazard from process ownership, and it is the
 * only condition here that the snapshot cannot neutralise.
 *
 * Deliberately absent, having previously been present: `live_invocation`,
 * `live_runner`, `runner_reservation`, `accepted_prompt` and
 * `declared_running`. Each of those refused a source merely for owning live
 * work, which narrowed the issue's contract past the two failure conditions it
 * names and disabled the feature for the in-flight session the issue is written
 * for. They bought nothing: `forkMetaSnapshot` clears the pid/pgid/start-time
 * triple, the invocation id, the runner identity, the runner reservation, the
 * runner generation, the accepted prompt and the steer queue, so a clone of a
 * running source names no process and no outstanding work, and `stop`, `kill`
 * and `delete` cannot reach the source through it. Note also what their removal
 * implies for this function: it no longer probes the process table at all, so
 * nothing here infers ownership from a process name, or from a pid alone.
 *
 * Also absent by design: anything that would require writing to the source in
 * order to find out. The source is never modified by a fork, not even to
 * reconcile it into a forkable state.
 */
export function forkBlocker(source: AgentMetadata): ForkBlocker | null {
  if (deletePendingFlag(source) === true) return 'delete_pending';
  return null;
}

const BLOCKER_REASONS: Readonly<Record<ForkBlocker, string>> = {
  delete_pending: 'is being deleted',
};

/**
 * The clone's record: a deep copy of the source's, with a new identity and with
 * every claim on live work and on a process reset to absent.
 *
 * `structuredClone` is what makes this a copy rather than an alias. A shallow
 * spread would leave `backend_error` (a nested record) and `steer_queue` (an
 * array of records) as objects the two agents would both reference, and a later
 * write through one would be a write through the other.
 */
export function forkMetaSnapshot(
  source: AgentMetadata,
  newAgentId: string,
  now: number,
  childNativeSessionId: string | null = null,
): AgentMetadata {
  if (persistedAgentId(newAgentId) !== newAgentId) {
    throw new Error('fork: managed-agent id is malformed');
  }
  const clone = structuredClone(source) as AgentMetadata;
  const parent = source.native_session_id;
  if (parent !== null) {
    if (typeof childNativeSessionId !== 'string'
        || !/^ses_[A-Za-z0-9_]+$/.test(childNativeSessionId)
        || childNativeSessionId === parent) {
      throw new Error('fork: distinct V2 child session is required');
    }
  } else if (childNativeSessionId !== null) {
    throw new Error('fork: cannot clone a nonexistent source session');
  }
  clone.native_session_id = childNativeSessionId;
  clone.id = newAgentId;
  clone.created_at = now;
  clone.last_activity_at = now;
  // The clone's own lifecycle state, not the source's. The clone launched
  // nothing, so inheriting the source's `state` would mint a record that says
  // `running` while owning no process, no invocation and no runner -- one that
  // `agent list` and `agent status` would report as running and that nothing
  // would ever clear. `idle` is the coherent non-running value for a clone of a
  // source in ANY state, not just a running one: the clone is a new agent that
  // has not begun its own run, whatever the source had reached, and the source's
  // own outcome is carried as history in `exit_code` / `finished_at` /
  // `last_prompt`. Copying a terminal state instead would claim the clone had
  // finished a run it never started.
  clone.state = 'idle';
  // Observation: not copied. `invocation_cwd` means "this agent was launched in
  // that directory", and the clone was launched nowhere. A `structuredClone`
  // carried it across, so a fresh agent with its own identity, no process and no
  // launch would report the source's last launch directory as its own, and
  // `agent status` would print it as `ran in:`. The clone inherits the source's
  // history (`exit_code`, `finished_at`, `last_prompt`, and the declared `cwd`,
  // which is a fact about the agent rather than about a run); the directory a
  // past run of a *different* agent used is not the clone's history.
  clone.invocation_cwd = null;
  // Forked agent never launched these models itself. Do not inherit observations.
  clone.observed_models = [];
  // Process identity: not copied. A pid means "this agent launched and owns
  // that process"; the clone launched nothing.
  clone.pid = null;
  clone.pgid = null;
  clone.start_time = null;
  clone.invocation_id = null;
  clone.runner_pid = null;
  clone.runner_start_time = null;
  // Runner generation ownership: the clone has no generations of its own, and
  // carrying the source's counter forward would let a reservation written for
  // one agent be read back as belonging to another.
  clone.active_runner = false;
  clone.runner_gen = 0;
  clone.runner_reservation = null;
  // Accepted and queued work belongs to the process that was serving it. The
  // clone inherits the history, not the outstanding work, so the FIFO steer
  // order it does have is empty and its sequence starts where its own history
  // starts.
  clone.pending_prompt = null;
  clone.steer_queue = [];
  clone.steer_seq = 0;
  clone.intent = null;
  clone.stop_reason = null;
  clone.delete_pending = false;
  // A run cursor is a byte offset into the agent's own `output.log`, and a fork
  // writes a fresh log for the clone rather than copying the source's. Inheriting
  // the source's offset would point the clone's first run past the end of its own
  // log and print nothing until that file grew beyond a byte count that belongs
  // to another agent's history.
  clone.run_log_offset = null;
  clone.agent_version = AGENT_META_VERSION;
  validateAgentMetadata(clone);
  return clone;
}

/**
 * Create `newAgentId` as a snapshot of `sourceAgentId`.
 *
 * The target's directory is created exclusively, so an id that already exists
 * fails here rather than being adopted or overwritten. Nothing is written to the
 * source. It is read once, with a plain `readMeta`, and no lock is taken -- and
 * none is needed: `writeMeta` publishes by `rename` from a temp file, so a
 * concurrent reader observes either the whole pre-write record or the whole
 * post-write one, never a torn mixture of the two. The read is a snapshot
 * either way, which is all a fork claims to be. Taking the source's lock would
 * also be the wrong tool: it would make a fork contend with the source's own
 * writers, and the source must not be written to at all, not even to reconcile
 * it into a forkable state.
 *
 * Everything from the claim to the last byte is all-or-nothing. The protected
 * region starts at the claim, not at the write, because two of the steps after
 * the claim can fail: `forkMetaSnapshot` (its id guard, and `validateAgentMetadata`
 * on the assembled clone) and `writeMeta`. A step that is allowed to fail while
 * holding a claimed target, and that leaves the target on disk when it does, is
 * how a failed fork becomes a half-created agent -- a directory under
 * `agents/` with no readable record in it, which `agentIds` enumerates and
 * `readMeta` then refuses, so the residue breaks `agent list` and `agent clean`
 * for the whole state root until someone removes it by hand. So the region covers
 * the whole creation sequence: if any step after the claim throws, the directory
 * this call created is removed again, and a failed fork leaves no half-created
 * agent, no partial record and no `.tmp` residue, with the source exactly as it
 * was found.
 */
export function forkAgent(
  sourceAgentId: string,
  newAgentId: string,
  options: StatePathsOptions = {},
  now = Date.now() / 1000,
  childNativeSessionId: string | null = null,
): AgentMetadata {
  const source = readMeta(sourceAgentId, options);
  if (source === null) throw new AgentForkSourceMissingError(sourceAgentId);
  const blocker = forkBlocker(source);
  if (blocker !== null) throw new AgentForkSourceBusyError(sourceAgentId, BLOCKER_REASONS[blocker]);
  if (!createAgentDirectory(newAgentId, options)) throw new AgentForkTargetExistsError(newAgentId);
  try {
    // Built inside the protected region, not before it: this is the step that
    // validates the id it was handed and the record it is about to publish, so
    // a failure here is as much a failed fork as a failure to write it.
    const meta = forkMetaSnapshot(source, newAgentId, now, childNativeSessionId);
    writeMeta(newAgentId, meta, options);
    return meta;
  } catch (error) {
    // A half-created agent is worse than none: remove what this call made and
    // leave the source exactly as it was found.
    removeAgentDirectory(newAgentId, options);
    throw error;
  }
}
