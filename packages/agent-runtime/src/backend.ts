import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

import { DEFAULT_VARIANT, persistedAgentCwd, persistedNativeSessionId, persistedVariant, requiredPersistedAgentId, type AgentMetadata } from './metadata.js';

export const AGENT_MODEL = 'opencode/space-bunny-free';
export const OPENCODE_TITLE_PREFIX = 'antonina-';
const SESSION_LIST_MAX_COUNT = 100;
const SESSION_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;
export const BACKEND_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
export const BACKEND_RETRY_MAX_ATTEMPTS = 2;
export const BACKEND_RETRY_BASE_MS = 500;
const BACKEND_CLASSIFICATION_MAX_CHARS = 80;
const BACKEND_FIELD_MAX_CHARS = 200;

export interface BackendError {
  classification: string;
  provider?: string | null;
  model?: string | null;
  request_boundary?: 'fresh_session' | 'continuation' | null;
  reference?: string | null;
  transient?: boolean;
  automatic_retry_safe?: boolean;
  fresh_session_useful?: boolean | null;
  backend_scope?: string | null;
  diagnostic_bytes?: number;
}

interface BackendFailureRule {
  marker: string;
  classification: string;
  provider: string;
  transient: boolean;
  automaticRetrySafe: boolean;
}

const BACKEND_FAILURE_RULES: readonly BackendFailureRule[] = [
  {
    marker: 'Unexpected server error',
    classification: 'transient_backend_server_error',
    provider: 'opencode',
    transient: true,
    automaticRetrySafe: false,
  },
];

interface SessionRow {
  id: string;
  title: string;
  created: number;
}

function parseSessionRows(value: unknown): SessionRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: SessionRow[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== 'string'
      || record.id.length === 0
      || typeof record.title !== 'string'
      || typeof record.created !== 'number'
      || !Number.isFinite(record.created)
    ) return null;
    rows.push({ id: record.id, title: record.title, created: record.created });
  }
  return rows;
}

export function discoverSessionId(
  agentId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const result = spawnSync(
    'opencode',
    ['session', 'list', '--format', 'json', '--max-count', String(SESSION_LIST_MAX_COUNT)],
    {
      encoding: 'utf8',
      timeout: SESSION_LIST_TIMEOUT_MS,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const rows = parseSessionRows(value);
  if (rows === null) return null;
  const title = `${OPENCODE_TITLE_PREFIX}${agentId}`;
  const matches = rows.filter((row) => row.title === title);
  matches.sort((left, right) => right.created - left.created || right.id.localeCompare(left.id));
  return matches[0]?.id ?? null;
}

export function configuredModelAvailable(
  env: Record<string, string | undefined> = process.env,
): boolean | null {
  const result = spawnSync('opencode', ['models'], {
    encoding: 'utf8',
    timeout: MODEL_LIST_TIMEOUT_MS,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).includes(AGENT_MODEL);
}

export function buildAgentCommand(
  meta: AgentMetadata,
  prompt: string,
  isContinue: boolean,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const agentId = requiredPersistedAgentId(meta);
  const cwd = persistedAgentCwd(meta);
  const variant = persistedVariant(meta) || DEFAULT_VARIANT;
  if (isContinue) {
    const recorded = persistedNativeSessionId(meta);
    const sessionId = recorded ?? discoverSessionId(agentId, env);
    if (sessionId === null) return null;
    return [
      'opencode', 'run', '--auto',
      '--session', sessionId,
      '--model', AGENT_MODEL,
      '--variant', variant,
      '--thinking',
      '--dir', cwd,
      prompt,
    ];
  }
  return [
    'opencode', 'run', '--auto',
    '--title', `${OPENCODE_TITLE_PREFIX}${agentId}`,
    '--model', AGENT_MODEL,
    '--variant', variant,
    '--thinking',
    '--dir', cwd,
    prompt,
  ];
}


export function classifyBackendFailure(
  path: string,
  start: number,
  exitCode: number,
  isContinue = false,
): BackendError | null {
  if (exitCode === 0 || !Number.isSafeInteger(start) || start < 0) return null;
  let data: Buffer;
  let size: number;
  try {
    size = statSync(path).size;
    const begin = Math.max(start, size - BACKEND_DIAGNOSTIC_MAX_BYTES);
    data = readFileSync(path).subarray(begin, size);
  } catch {
    return null;
  }
  const text = data.toString('utf8');
  const rule = BACKEND_FAILURE_RULES.find((candidate) => text.includes(candidate.marker));
  if (!rule) return null;
  const match = /"ref"\s*:\s*"([^"\r\n]+)"/.exec(text);
  return {
    classification: rule.classification,
    provider: rule.provider,
    model: AGENT_MODEL,
    request_boundary: isContinue ? 'continuation' : 'fresh_session',
    reference: match?.[1] ?? null,
    transient: rule.transient,
    automatic_retry_safe: rule.automaticRetrySafe,
    fresh_session_useful: isContinue ? null : false,
    backend_scope: 'unknown',
    diagnostic_bytes: Math.min(Math.max(0, size - start), BACKEND_DIAGNOSTIC_MAX_BYTES),
  };
}

export function backendRetryDelay(error: BackendError | null, attempt: number): number | null {
  if (
    error === null
    || !Number.isSafeInteger(attempt)
    || attempt < 0
    || attempt >= BACKEND_RETRY_MAX_ATTEMPTS
    || error.transient !== true
    || error.automatic_retry_safe !== true
  ) return null;
  return BACKEND_RETRY_BASE_MS * (2 ** attempt);
}

export function sanitizeBackendError(value: unknown): BackendError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const classification = record.classification;
  if (
    typeof classification !== 'string'
    || classification.length === 0
    || classification.length > BACKEND_CLASSIFICATION_MAX_CHARS
  ) return null;

  const result: BackendError = { classification };
  for (const key of ['provider', 'model', 'request_boundary', 'reference', 'backend_scope'] as const) {
    const item = record[key];
    if (item === null) result[key] = null;
    else if (typeof item === 'string' && item.length <= BACKEND_FIELD_MAX_CHARS) {
      if (key === 'request_boundary' && item !== 'fresh_session' && item !== 'continuation') continue;
      result[key] = item as never;
    }
  }
  for (const key of ['transient', 'automatic_retry_safe'] as const) {
    const item = record[key];
    if (typeof item === 'boolean') result[key] = item;
  }
  const fresh = record.fresh_session_useful;
  if (fresh === null || typeof fresh === 'boolean') result.fresh_session_useful = fresh;
  const bytes = record.diagnostic_bytes;
  if (
    typeof bytes === 'number'
    && Number.isSafeInteger(bytes)
    && bytes >= 0
    && bytes <= BACKEND_DIAGNOSTIC_MAX_BYTES
  ) result.diagnostic_bytes = bytes;
  return result;
}
