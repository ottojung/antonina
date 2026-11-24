import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Operator-maintained, ordered model preferences. Never supplied by a built-in default. */
export interface ModelPreference {
  /** Canonical `provider/model` identifier. Never carries a `#variant` suffix. */
  model: string;
  comment: string;
  /**
   * Optional launch-time variant. A single OpenCode variant token such as
   * `low`, kept separate from the canonical model so failover, cooldowns and
   * observations stay keyed on `model` alone.
   */
  variant?: string;
}

/** Variant tokens are a single suffix of `--model`, never a second model ID. */
const MODEL_VARIANT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const HOST_XDG_CONFIG_HOME_ENV = 'ANTONINA_HOST_XDG_CONFIG_HOME';
const OPENCODE_XDG_CONFIG_HOME_ENV = 'ANTONINA_OPENCODE_XDG_CONFIG_HOME';

export function modelConfigPath(env: Record<string, string | undefined> = process.env): string {
  const inheritedServiceHome = Boolean(env[OPENCODE_XDG_CONFIG_HOME_ENV])
    && env.XDG_CONFIG_HOME === env[OPENCODE_XDG_CONFIG_HOME_ENV];
  const base = inheritedServiceHome && env[HOST_XDG_CONFIG_HOME_ENV]
    ? env[HOST_XDG_CONFIG_HOME_ENV]
    : env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
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
    const variant = record.variant;
    if (variant !== undefined && (typeof variant !== 'string' || !MODEL_VARIANT.test(variant))) {
      throw new Error(`Invalid models[${index}].variant in ${path}: expected a single OpenCode variant token without '#'`);
    }
    if (seen.has(model)) throw new Error(`Duplicate model ${model} in ${path}`);
    seen.add(model);
    return variant === undefined
      ? { model, comment: record.comment }
      : { model, comment: record.comment, variant };
  });
}

/**
 * The exact `--model` reference for one configured preference. A variant is
 * appended only when this model was configured with one: forcing `#low` on
 * models that do not support it makes otherwise healthy models fail with
 * `provider.no-route`.
 */
export function modelReference(preference: ModelPreference): string {
  return preference.variant === undefined ? preference.model : `${preference.model}#${preference.variant}`;
}
