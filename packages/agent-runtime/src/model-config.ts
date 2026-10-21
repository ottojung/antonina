import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Operator-maintained, ordered model preferences. Never supplied by a built-in default. */
export interface ModelPreference {
  model: string;
  comment: string;
}

export function modelConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'antonina', 'config.json');
}

export function configuredModels(env: Record<string, string | undefined> = process.env): ModelPreference[] {
  const path = modelConfigPath(env);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Antonina models are not configured: create ${path} with a non-empty "models" array (model and comment per entry)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Invalid Antonina model configuration JSON: ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || !('models' in parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error(`Antonina models are not configured: ${path} must contain a non-empty "models" array`);
  }
  const seen = new Set<string>();
  return parsed.models.map((entry: unknown, index: number): ModelPreference => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Invalid models[${index}] in ${path}: expected { "model": "...", "comment": "..." }`);
    }
    const record = entry as Record<string, unknown>;
    const model = record.model;
    if (typeof model !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model)) {
      throw new Error(`Invalid models[${index}].model in ${path}: expected an OpenCode provider/model identifier`);
    }
    if (typeof record.comment !== 'string') {
      throw new Error(`Invalid models[${index}].comment in ${path}: expected free-form text`);
    }
    if (seen.has(model)) throw new Error(`Duplicate model ${model} in ${path}`);
    seen.add(model);
    return { model, comment: record.comment };
  });
}

/** A preference is eligible only if OpenCode advertises that exact identifier. */
export function firstAvailableConfiguredModel(
  available: ReadonlySet<string>,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return configuredModels(env).find((item) => available.has(item.model))?.model ?? null;
}
