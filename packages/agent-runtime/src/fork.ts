/**
 * Board issue 126: `antonina agent new --id <NEW> --fork <OLD>`.
 *
 * What a managed agent's durable state actually IS, as this package owns it:
 * exactly one canonical JSON record at `<state>/antonina/agents/<id>/meta.json`,
 * validated field-for-field by `validateAgentMetadata` (metadata.ts) and read
 * and written only under the per-agent lock in store.ts. There is no other
 * durable per-agent object that carries meaning: `output.log` is an append-only
 * transcript of a run, `.lock` is an ephemeral lock record, and everything else
 * about an agent (its process, its runner, its prompts) is encoded as fields
 * inside that one record. So a fork is the making of a second record.
 *
 * Two rules make that a snapshot rather than a link.
 *
 * 1. Independence. The clone is written into its own directory by
 *    `createAgentDirectory` + `writeMeta`, and the record is built by
 *    `structuredClone`, so the two records share no object, nested or top-level,
 *    in memory or on disk. There is no parent field, no link, no shared path,
 *    and no code path that ever reads one record in order to update the other.
 *    Mutating either agent afterwards writes only that agent's own `meta.json`.
 *
 * 2. Process ownership is never inherited. A pid/pgid/start-time triple, a
 *    runner identity, or a runner reservation is a claim on ONE live process.
 *    Copying it would make two agent records name the same process, which is
 *    precisely the state the repository's rules forbid and which `stop`, `kill`
 *    and `delete` would then both act on. So the snapshot clears every one of
 *    those fields on the clone, whatever the source was doing.
 *
 * A source that is *live* is therefore not a reason to refuse. The clone names
 * no process, so no control command can reach the source through it, and the
 * issue's stated purpose -- forking an in-flight session so it can continue from
 * the same point -- is exactly the live case. The snapshot is what makes that
 * safe, not a gate. The one refusal that remains is a source whose durable
 * authority is being revoked; see `forkBlocker`.
 *
 * The clone is not a verbatim byte copy either. It keeps the source's work
 * identity -- declared cwd, title, variant, `native_session_id` (so `run`
 * continues the same backend conversation), prompt history, and the terminal
 * outcome with its timestamps and exit status -- and it gets a fresh identity of
 * its own: new id, new creation time, its own lifecycle state, and no process,
 * runner, reservation, accepted prompt or queued steer, because none of those
 * are state a second agent may own.
 *
 * A fork SHARES the source's backend session: `native_session_id` is carried
 * deliberately, because that is what "continue from the same point" means. The
 * two agent *records* are independent, and the two agents are separately
 * runnable, so if both are run they will both drive that one backend
 * conversation. This is a known, accepted overlap, not an oversight: dropping
 * the session id would make the clone a fresh conversation and defeat the
 * feature.
 *
 * There is currently no way to give a clone its own backend session, and that
 * is a known gap rather than a hidden one. `native_session_id` is terminal once
 * set: `cmdRun` selects `mode: 'continue'` from the recorded session and never
 * re-consults session discovery, and the only two writers of an existing
 * record's field (`rememberFreshSession` and the `cmdRun` session-recovery
 * branch) both write only when it is null. So a clone of a source that has a
 * recorded session can never be given a different one, and no command exists
 * to start one. A clone of a source that has no recorded session yet does
 * start its own, because `agent new` records a null session. So forking a
 * source that has not been run yet is the only way to get two separate
 * conversations: the clone inherits the source's recorded
 * `native_session_id`, and every later run of either agent takes
 * `mode: 'continue'` against that one session id, so the two agents are two
 * turns of the same conversation and not two. Running them at different times
 * does not change that; it only serialises the turns. The board owes an
 * opt-out.
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
): AgentMetadata {
  if (persistedAgentId(newAgentId) !== newAgentId) {
    throw new Error('fork: managed-agent id is malformed');
  }
  const clone = structuredClone(source) as AgentMetadata;
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
    const meta = forkMetaSnapshot(source, newAgentId, now);
    writeMeta(newAgentId, meta, options);
    return meta;
  } catch (error) {
    // A half-created agent is worse than none: remove what this call made and
    // leave the source exactly as it was found.
    removeAgentDirectory(newAgentId, options);
    throw error;
  }
}
