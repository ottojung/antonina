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
 *    and `delete` would then both act on. So forking a source that owns live
 *    work is refused, rather than being quietly made into an agent that believes
 *    it runs somebody else's process. See `forkBlocker`.
 *
 * The clone is not a verbatim byte copy either. It keeps the source's work
 * identity -- declared cwd, title, variant, `native_session_id` (so `run`
 * continues the same backend conversation), prompt history, and the terminal
 * outcome with its timestamps and exit status -- and it gets a fresh identity of
 * its own: new id, new creation time, and no process, runner, reservation,
 * accepted prompt or queued steer, because none of those are state a second
 * agent may own.
 */
import {
  invocationAlive,
  runnerAlive,
  reservationInFlight,
} from './lifecycle.js';
import {
  AGENT_META_VERSION,
  deletePendingFlag,
  pendingPrompt,
  persistedLifecycleState,
  validateAgentMetadata,
  type AgentMetadata,
} from './metadata.js';
import { persistedAgentId, type ProcessProbeOptions } from './process.js';
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
    super(`cannot fork agent ${agentId}: it ${reason}; a fork cannot inherit live work or process ownership`);
    this.name = 'AgentForkSourceBusyError';
  }
}

export type ForkBlocker =
  | 'live_invocation'
  | 'live_runner'
  | 'runner_reservation'
  | 'accepted_prompt'
  | 'declared_running'
  | 'delete_pending';

/**
 * Why this source may not be forked right now, or `null` when it may.
 *
 * Every rung here is a claim on live work or on a process, checked through the
 * same `invocationAlive` / `runnerAlive` / `reservationInFlight` predicates the
 * lifecycle uses, which verify pid *and* start ticks *and* the agent env marker
 * and never fall back to a process name. Deliberately absent: anything about the
 * source's history, and anything that would require writing to the source to
 * find out. The source is never modified by a fork, not even to reconcile it
 * into a forkable state.
 */
export function forkBlocker(
  source: AgentMetadata,
  options: ProcessProbeOptions = {},
  now = Date.now() / 1000,
): ForkBlocker | null {
  if (deletePendingFlag(source) === true) return 'delete_pending';
  if (invocationAlive(source, options)) return 'live_invocation';
  if (runnerAlive(source, options)) return 'live_runner';
  if (reservationInFlight(source, now)) return 'runner_reservation';
  let accepted: string | null;
  try {
    accepted = pendingPrompt(source);
  } catch {
    // Malformed pending-prompt authority is live-work uncertainty, not a
    // licence to guess. Refuse rather than clone a record nobody can read.
    return 'accepted_prompt';
  }
  if (accepted !== null) return 'accepted_prompt';
  if (persistedLifecycleState(source) === 'running') return 'declared_running';
  return null;
}

const BLOCKER_REASONS: Readonly<Record<ForkBlocker, string>> = {
  live_invocation: 'has a live backend process',
  live_runner: 'has a live runner process',
  runner_reservation: 'has a runner reservation in flight',
  accepted_prompt: 'has an accepted prompt it has not run yet',
  declared_running: 'is still recorded as running',
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
 * source: it is read once, under its own lock, and only its record is consulted.
 */
export function forkAgent(
  sourceAgentId: string,
  newAgentId: string,
  options: StatePathsOptions = {},
  probe: ProcessProbeOptions = {},
  now = Date.now() / 1000,
): AgentMetadata {
  const source = readMeta(sourceAgentId, options);
  if (source === null) throw new AgentForkSourceMissingError(sourceAgentId);
  const blocker = forkBlocker(source, probe, now);
  if (blocker !== null) throw new AgentForkSourceBusyError(sourceAgentId, BLOCKER_REASONS[blocker]);
  if (!createAgentDirectory(newAgentId, options)) throw new AgentForkTargetExistsError(newAgentId);
  const meta = forkMetaSnapshot(source, newAgentId, now);
  try {
    writeMeta(newAgentId, meta, options);
  } catch (error) {
    // A half-created agent is worse than none: remove what this call made and
    // leave the source exactly as it was found.
    removeAgentDirectory(newAgentId, options);
    throw error;
  }
  return meta;
}
