import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateRoot, type StatePathsOptions } from './store.js';

/**
 * Shared, time-limited evidence of an *unrecognized backend* failure.
 * Immutable per-attempt files avoid a global write lock and prevent one
 * failing agent from rewriting another agent's observation.
 */
export const MODEL_HEALTH_WINDOW_SECONDS = 10 * 60;
export const MODEL_HEALTH_DISTINCT_AGENTS = 2;
const MODEL_HEALTH_RETENTION_SECONDS = 60 * 60;
const MAX_EVENTS_TO_READ = 1500;
const MODEL_ID = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const AGENT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const EVENT_FILENAME = /^(\d{13})-[a-f0-9]{16}\.json$/;

type ModelFailureEvent = {
  agent_id: string;
  model: string;
  at: number;
};

function healthDir(options: StatePathsOptions): string {
  return join(stateRoot(options), 'model-health');
}

function eligibleEvent(value: unknown, now: number): value is ModelFailureEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.agent_id === 'string' && AGENT_ID.test(record.agent_id)
    && typeof record.model === 'string' && MODEL_ID.test(record.model)
    && typeof record.at === 'number' && Number.isFinite(record.at)
    && record.at >= now - MODEL_HEALTH_WINDOW_SECONDS
    && record.at <= now + 5;
}

/** One immutable, private observation per genuinely failed backend invocation. */
export function recordUnrecognizedBackendFailure(
  agentId: string, model: string, options: StatePathsOptions = {}, now = Date.now() / 1000,
): void {
  if (!AGENT_ID.test(agentId) || !MODEL_ID.test(model) || !Number.isFinite(now)) {
    throw new Error('Invalid Antonina model-health observation');
  }
  const dir = healthDir(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = readdirSync(dir);
  // Prune only very old immutable observations. Readers ignore stale events
  // regardless, so concurrent pruning never changes an active decision.
  for (const file of files) {
    const match = EVENT_FILENAME.exec(file);
    if (match !== null && Number(match[1]) / 1000 < now - MODEL_HEALTH_RETENTION_SECONDS) {
      try { unlinkSync(join(dir, file)); } catch { /* Another writer may have pruned it. */ }
    }
  }
  const file = `${Math.floor(now * 1000)}-${randomBytes(8).toString('hex')}.json`;
  writeFileSync(join(dir, file), JSON.stringify({ agent_id: agentId, model, at: now }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

/**
 * Two distinct agents failing on the same model within a bounded window
 * constitute a *soft* fleet-wide penalty, never a permanent provider ban.
 * If all models are unhealthy, per-agent selection may still probe the soft
 * pool with its ordinary randomized/backoff policy.
 */
export function sharedUnreliableModels(
  options: StatePathsOptions = {}, now = Date.now() / 1000,
): Set<string> {
  const dir = healthDir(options);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => EVENT_FILENAME.test(file)
        && Number(file.slice(0, 13)) / 1000 >= now - MODEL_HEALTH_WINDOW_SECONDS)
      .sort().reverse().slice(0, MAX_EVENTS_TO_READ);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    // Shared health is advisory. A damaged/unreadable cache must not break
    // ordinary per-agent execution, which retains its own durable cooldowns.
    return new Set();
  }
  const agentsByModel = new Map<string, Set<string>>();
  for (const file of files) {
    try {
      const path = join(dir, file);
      if (statSync(path).size > 1024) continue;
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!eligibleEvent(value, now)) continue;
      const observed = agentsByModel.get(value.model) ?? new Set<string>();
      observed.add(value.agent_id);
      agentsByModel.set(value.model, observed);
    } catch { /* Malformed or concurrently pruned observations carry no authority. */ }
  }
  return new Set([...agentsByModel]
    .filter(([, agents]) => agents.size >= MODEL_HEALTH_DISTINCT_AGENTS)
    .map(([model]) => model));
}
