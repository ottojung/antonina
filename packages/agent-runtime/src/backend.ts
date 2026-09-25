import { spawnSync } from 'node:child_process';

import { DEFAULT_VARIANT, persistedNativeSessionId, persistedVariant, requiredPersistedAgentId, type AgentMetadata } from './metadata.js';

export const AGENT_MODEL = 'opencode/space-bunny-free';
export const OPENCODE_TITLE_PREFIX = 'antonina-';
const SESSION_LIST_MAX_COUNT = 100;
const SESSION_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;

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
      '--dir', String(meta.cwd),
      prompt,
    ];
  }
  return [
    'opencode', 'run', '--auto',
    '--title', `${OPENCODE_TITLE_PREFIX}${agentId}`,
    '--model', AGENT_MODEL,
    '--variant', variant,
    '--thinking',
    '--dir', String(meta.cwd),
    prompt,
  ];
}
