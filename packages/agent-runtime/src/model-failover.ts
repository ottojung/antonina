import type { AgentMetadata } from './metadata.js';
import type { ModelPreference } from './model-config.js';

/**
 * Each agent has its own expiring model exclusions. The ordered, host-local
 * configuration remains authoritative; model identifiers are opaque strings.
 */
export const MODEL_COOLDOWN_SECONDS = 6 * 60 * 60;
export const TRANSIENT_MODEL_RETRIES = 2;
export const MODEL_FAILURE_REASONS = ['quota_exhausted', 'rate_limited', 'model_unavailable', 'transient_backend'] as const;
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
 * Retry higher-priority models at the first invocation boundary after their
 * cooldown expires. Do not restart or interrupt productive active sessions.
 */
export function eligibleAgentModel(
  meta: AgentMetadata,
  preferences: readonly ModelPreference[],
  now: number = Date.now() / 1000,
): string | null {
  const state = agentModelFailover(meta);
  return preferences.find((preference) =>
    !state.cooldowns.some((item) => item.model === preference.model && item.until > now))?.model ?? null;
}

export function recordAgentModel(meta: AgentMetadata, model: string): void {
  const state = agentModelFailover(meta);
  meta.model_failover = { selected_model: model, cooldowns: [...state.cooldowns] };
}

export function coolDownAgentModel(
  meta: AgentMetadata,
  model: string,
  reason: ModelFailureReason,
  now: number = Date.now() / 1000,
  seconds: number = MODEL_COOLDOWN_SECONDS,
): void {
  const previous = agentModelFailover(meta);
  meta.model_failover = {
    selected_model: previous.selected_model,
    cooldowns: [
      ...previous.cooldowns.filter((item) => item.model !== model && item.until > now),
      { model, reason, until: now + seconds },
    ],
  };
}
