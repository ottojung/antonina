import { randomInt } from 'node:crypto';

import type { AgentMetadata } from './metadata.js';
import type { ModelPreference } from './model-config.js';

/**
 * Each agent retains its own model observations. Soft transient penalties do
 * not imply that a provider is unavailable; hard exclusions do.
 *
 * Older metadata already stores transient_backend entries with a six-hour
 * 'until'. These are interpreted as soft penalties by selection, without any
 * split between legacy and new agent identifiers or metadata formats.
 */
export const MODEL_COOLDOWN_SECONDS = 6 * 60 * 60;
export const TRANSIENT_MODEL_RETRIES = 2;
export const TRANSIENT_UNRELIABLE_SECONDS = 2 * 60;
export const RATE_LIMIT_BACKOFF_SECONDS = 90;
export const PERMANENT_EXCLUSION_UNTIL = Number.MAX_SAFE_INTEGER;
export const MODEL_FAILURE_REASONS = [
  'quota_exhausted',
  'rate_limited',
  'model_unavailable',
  'transient_backend',
  'provider_authentication_failed',
  'provider_billing_required',
] as const;
export type ModelFailureReason = (typeof MODEL_FAILURE_REASONS)[number];

export interface ModelCooldown {
  model: string;
  reason: ModelFailureReason;
  until: number;
}

export interface ModelFailoverState {
  selected_model: string | null;
  cooldowns: ModelCooldown[];
}

const MODEL_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ENTRIES = 100;

export function validModelFailover(value: unknown): value is ModelFailoverState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'cooldowns,selected_model') return false;
  if (record.selected_model !== null && (typeof record.selected_model !== 'string' || !MODEL_ID.test(record.selected_model))) return false;
  if (!Array.isArray(record.cooldowns) || record.cooldowns.length > MAX_ENTRIES) return false;
  const seen = new Set<string>();
  for (const item of record.cooldowns as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'model,reason,until') return false;
    if (typeof entry.model !== 'string' || !MODEL_ID.test(entry.model) || seen.has(entry.model)) return false;
    if (!(MODEL_FAILURE_REASONS as readonly string[]).includes(String(entry.reason))) return false;
    if (typeof entry.until !== 'number' || !Number.isFinite(entry.until) || entry.until < 0) return false;
    seen.add(entry.model);
  }
  return true;
}

export function agentModelFailover(meta: AgentMetadata): ModelFailoverState {
  const value: unknown = meta.model_failover;
  if (value === undefined || value === null) return { selected_model: null, cooldowns: [] };
  if (!validModelFailover(value)) throw new Error('managed-agent model_failover is malformed');
  return value;
}

/**
 * Ordered healthy models are preferred. If every non-excluded model has an
 * active transient penalty, draw uniformly from that soft pool. A quota,
 * rate-limit, unsupported-model, or provider-credential exclusion is never a
 * member of the random pool while active.
 *
 * The optional chooser is a deterministic test seam. Each normal invocation
 * makes its own cryptographically randomized draw; no orchestrator/daemon
 * coordinates model selection.
 */
export function eligibleAgentModel(
  meta: AgentMetadata,
  preferences: readonly ModelPreference[],
  now: number = Date.now() / 1000,
  choose: (count: number) => number = randomInt,
  exclude: ReadonlySet<string> = new Set(),
): string | null {
  const state = agentModelFailover(meta);
  const unreliable: string[] = [];
  for (const preference of preferences) {
    if (exclude.has(preference.model)) continue;
    const cooldown = state.cooldowns.find((entry) => entry.model === preference.model && entry.until > now);
    if (cooldown === undefined) return preference.model;
    if (cooldown.reason === 'transient_backend') unreliable.push(preference.model);
  }
  if (unreliable.length === 0) return null;
  const index = choose(unreliable.length);
  if (!Number.isInteger(index) || index < 0 || index >= unreliable.length) throw new Error('Invalid transient model lottery index');
  return unreliable[index]!;
}

export function recordAgentModel(meta: AgentMetadata, model: string): void {
  const state = agentModelFailover(meta);
  meta.model_failover = { selected_model: model, cooldowns: [...state.cooldowns] };
}

export function modelCooldownSeconds(reason: ModelFailureReason): number {
  switch (reason) {
    case 'transient_backend': return TRANSIENT_UNRELIABLE_SECONDS;
    case 'rate_limited': return RATE_LIMIT_BACKOFF_SECONDS;
    case 'quota_exhausted': return MODEL_COOLDOWN_SECONDS;
    case 'model_unavailable':
    case 'provider_authentication_failed':
    case 'provider_billing_required': return PERMANENT_EXCLUSION_UNTIL;
  }
}

export function coolDownAgentModel(
  meta: AgentMetadata,
  model: string,
  reason: ModelFailureReason,
  now: number = Date.now() / 1000,
  seconds: number = modelCooldownSeconds(reason),
): void {
  const previous = agentModelFailover(meta);
  meta.model_failover = {
    selected_model: previous.selected_model,
    cooldowns: [
      ...previous.cooldowns.filter((item) => item.model !== model && item.until > now),
      { model, reason, until: seconds === PERMANENT_EXCLUSION_UNTIL ? PERMANENT_EXCLUSION_UNTIL : now + seconds },
    ],
  };
}

/**
 * Account credentials and billing are scoped to a provider, not to a single
 * model. Only configured models with that exact provider ID are excluded.
 * This is a per-agent observation: other agents are not automatically marked
 * broken on the evidence of this one's request.
 */
export function excludeAgentProvider(
  meta: AgentMetadata,
  failedModel: string,
  preferences: readonly ModelPreference[],
  reason: 'provider_authentication_failed' | 'provider_billing_required',
  now: number = Date.now() / 1000,
): void {
  const provider = failedModel.split('/')[0];
  for (const entry of preferences) {
    if (entry.model.split('/')[0] === provider) {
      coolDownAgentModel(meta, entry.model, reason, now);
    }
  }
}

export function modelSoftPenaltySeconds(meta: AgentMetadata, model: string, now = Date.now() / 1000): number {
  const entry = agentModelFailover(meta).cooldowns.find((x) =>
    x.model === model && x.until > now && x.reason === 'transient_backend');
  return entry === undefined ? 0 : Math.max(0, entry.until - now);
}
