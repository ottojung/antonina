import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentMetadata } from './metadata.js';
import type { ModelPreference } from './model-config.js';
import {
  PERMANENT_EXCLUSION_UNTIL, agentModelFailover, eligibleAgentModel, type ModelCooldown,
} from './model-failover.js';
import { MAX_PROVIDER_COOLDOWN_SECONDS } from './provider-errors.js';
import { stateRoot, type StatePathsOptions } from './store.js';

/**
 * Host-wide record of provider-attested quota and rate-limit cooldowns.
 *
 * A usage limit belongs to the account, not to the agent that happened to hit
 * it. Per-agent cooldowns alone meant every new agent rediscovered the same
 * exhausted model with a request of its own, and nothing on the host could
 * answer the question "is there any model left to run on?" before a prompt
 * was accepted.
 *
 * Only quota and rate-limit observations are shared, and only for as long as
 * the provider said (see `providerRetryAfterSeconds`). Authentication,
 * billing and unsupported-model exclusions stay per-agent, as documented in
 * model-failover.ts, and a silent stall is never shared: it is not a
 * statement by the provider.
 *
 * One small file per model, replaced atomically. To lift a cooldown early
 * (for example after buying more quota), delete the file.
 */
export type SharedCooldownReason = 'quota_exhausted' | 'rate_limited';

const MODEL_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const AGENT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_FILES_TO_READ = 200;

function cooldownDir(options: StatePathsOptions): string {
  return join(stateRoot(options), 'model-cooldowns');
}

function cooldownFile(options: StatePathsOptions, model: string): string {
  return join(cooldownDir(options), model.replace('/', '@') + '.json');
}

function validShared(value: unknown, now: number): value is ModelCooldown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.model === 'string' && MODEL_ID.test(record.model)
    && (record.reason === 'quota_exhausted' || record.reason === 'rate_limited')
    && typeof record.until === 'number' && Number.isFinite(record.until)
    && record.until > now
    // A cooldown further out than the longest one this runtime ever writes
    // was not written by it and carries no authority.
    && record.until <= now + MAX_PROVIDER_COOLDOWN_SECONDS + 60;
}

/** Active shared cooldowns. Advisory: an unreadable store is an empty one. */
export function sharedModelCooldowns(
  options: StatePathsOptions = {}, now = Date.now() / 1000,
): ModelCooldown[] {
  const dir = cooldownDir(options);
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json')).slice(0, MAX_FILES_TO_READ);
  } catch { return []; }
  const active: ModelCooldown[] = [];
  for (const file of files) {
    try {
      const path = join(dir, file);
      if (statSync(path).size > 1024) continue;
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!validShared(value, now)) continue;
      if (file !== value.model.replace('/', '@') + '.json') continue;
      if (active.some((entry) => entry.model === value.model)) continue;
      active.push({ model: value.model, reason: value.reason, until: value.until });
    } catch { /* Malformed or concurrently replaced entries carry no authority. */ }
  }
  return active;
}

/** Record that the provider refused `model` until `until`. Never shortens an existing cooldown. */
export function recordSharedModelCooldown(
  agentId: string, model: string, reason: SharedCooldownReason, until: number,
  options: StatePathsOptions = {}, now = Date.now() / 1000,
): void {
  if (!AGENT_ID.test(agentId) || !MODEL_ID.test(model) || !Number.isFinite(until) || !Number.isFinite(now)) {
    throw new Error('Invalid Antonina shared model cooldown');
  }
  const bounded = Math.min(until, now + MAX_PROVIDER_COOLDOWN_SECONDS);
  if (bounded <= now) return;
  const existing = sharedModelCooldowns(options, now).find((entry) => entry.model === model);
  if (existing !== undefined && existing.until >= bounded) return;
  const dir = cooldownDir(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = cooldownFile(options, model);
  const temporary = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(temporary, JSON.stringify({ model, reason, until: bounded, agent_id: agentId, at: now }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, target); } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * A view of this agent's record with active shared cooldowns merged into its
 * failover state, for model selection and wait planning only. The view is
 * never persisted: the shared store stays the single place a host-wide
 * cooldown lives, so deleting its file lifts the cooldown for every agent
 * that did not hit the limit itself.
 */
export function withSharedModelCooldowns(
  meta: AgentMetadata, shared: readonly ModelCooldown[], now = Date.now() / 1000,
): AgentMetadata {
  if (shared.length === 0) return meta;
  const view = { ...meta, model_failover: agentModelFailover(meta) } as AgentMetadata;
  adoptSharedModelCooldowns(view, shared, now);
  return view;
}

/**
 * Merge active shared cooldowns into a record's failover state. Keeps
 * whichever exclusion lasts longer. Returns whether anything changed.
 */
export function adoptSharedModelCooldowns(
  meta: AgentMetadata, shared: readonly ModelCooldown[], now = Date.now() / 1000,
): boolean {
  if (shared.length === 0) return false;
  const state = agentModelFailover(meta);
  const cooldowns = state.cooldowns.filter((entry) => entry.until > now);
  let changed = false;
  for (const entry of shared) {
    if (entry.until <= now) continue;
    const index = cooldowns.findIndex((own) => own.model === entry.model);
    if (index >= 0) {
      const own = cooldowns[index]!;
      // A soft transient penalty is weaker than a provider-attested limit.
      if (own.reason !== 'transient_backend' && own.until >= entry.until) continue;
      cooldowns[index] = { model: entry.model, reason: entry.reason, until: entry.until };
    } else {
      cooldowns.push({ model: entry.model, reason: entry.reason, until: entry.until });
    }
    changed = true;
  }
  if (changed) meta.model_failover = { selected_model: state.selected_model, cooldowns };
  return changed;
}

export interface ModelAvailability {
  /** False only when every configured model is under an active hard exclusion. */
  available: boolean;
  /** Earliest time (epoch seconds) a temporarily excluded model returns, or null if none will. */
  earliestReturn: number | null;
  excluded: ModelCooldown[];
}

/**
 * Could this agent be given a model right now? Soft transient penalties do not
 * make a model unavailable; quota, rate limits and hard exclusions do. The
 * record passed in is not modified.
 */
export function modelAvailability(
  meta: AgentMetadata, preferences: readonly ModelPreference[],
  shared: readonly ModelCooldown[], now = Date.now() / 1000,
): ModelAvailability {
  const probe = withSharedModelCooldowns(meta, shared, now);
  const available = eligibleAgentModel(probe, preferences, now, () => 0) !== null;
  const configured = new Set(preferences.map((entry) => entry.model));
  const excluded = agentModelFailover(probe).cooldowns.filter((entry) =>
    configured.has(entry.model) && entry.until > now && entry.reason !== 'transient_backend');
  const returning = excluded.filter((entry) => entry.until !== PERMANENT_EXCLUSION_UNTIL).map((entry) => entry.until);
  return {
    available,
    earliestReturn: returning.length === 0 ? null : Math.min(...returning),
    excluded,
  };
}
