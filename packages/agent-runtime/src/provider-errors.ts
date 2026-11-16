/**
 * OpenCode V2 reports provider failures as typed top-level error events:
 *
 *   {"type":"error","sessionID":"ses_...","error":{"type":"provider.quota",
 *    "message":"OpenCode Go usage limit reached (weekly, resets in 2d 18h)...",
 *    "status":429,"retryAfterMs":71818000}}
 *
 * Before this module only `provider.no-route` and the legacy `APIError` shape
 * were understood. A quota or rate-limit event was therefore either invisible
 * (the watchdog saw an "unknown" phase) or classified by a prose marker with a
 * fixed 90-second backoff, while the provider itself was saying "come back in
 * twenty hours". The model returned to the pool almost immediately and the
 * agent spent its time on a provider that could not answer.
 *
 * Only the `error` object of a top-level event is ever passed in here. Text
 * inside a tool result is never classification authority.
 */
export type TypedProviderFailure =
  | 'model_quota_exhausted'
  | 'upstream_rate_limited'
  | 'model_unavailable'
  | 'transient_backend_server_error'
  | 'backend_authentication_failed'
  | 'backend_billing_required';

/** The provider's stated wait is honoured up to one week; beyond that it is a configuration problem. */
export const MAX_PROVIDER_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
const MIN_PROVIDER_COOLDOWN_SECONDS = 60;
/** Margin so the first request after a reset is not the one that trips it again. */
const PROVIDER_RESET_MARGIN_SECONDS = 30;

const USAGE_LIMIT = /usage limit (?:reached|exceeded|has been reached)|insufficient_quota|quota exhausted|reached your usage limit/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Classify one OpenCode V2 typed provider error object, or null when it is not one. */
export function typedProviderFailure(error: unknown): TypedProviderFailure | null {
  if (!isRecord(error) || typeof error.type !== 'string' || !error.type.startsWith('provider.')) return null;
  const type = error.type;
  const message = typeof error.message === 'string' ? error.message : '';
  const status = error.status;
  if (type === 'provider.no-route') return 'model_unavailable';
  if (status === 401) return 'backend_authentication_failed';
  if (status === 402) return 'backend_billing_required';
  // A usage limit is quota whichever typed envelope carries it: OpenCode Go
  // reports provider.quota, the free tier provider.free-limit, and an OAuth
  // subscription reports its limit as provider.invalid-request.
  if (type === 'provider.quota' || type === 'provider.free-limit' || USAGE_LIMIT.test(message)) {
    return 'model_quota_exhausted';
  }
  if (type === 'provider.rate-limit' || status === 429) return 'upstream_rate_limited';
  if (type === 'provider.internal' || type === 'provider.transport' || type === 'provider.invalid-output'
    || (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status < 600)) {
    return 'transient_backend_server_error';
  }
  // Any other typed provider error (an ordinary invalid request, a permission
  // failure) is not evidence that a different model would do better.
  return null;
}

function clampCooldown(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(MAX_PROVIDER_COOLDOWN_SECONDS,
    Math.max(MIN_PROVIDER_COOLDOWN_SECONDS, Math.ceil(seconds) + PROVIDER_RESET_MARGIN_SECONDS));
}

/**
 * How long the provider itself says to stay away, in seconds, or null when it
 * did not say. `retryAfterMs` is authoritative; failing that, the documented
 * "resets in 2d 18h" phrase in the message is read.
 */
export function providerRetryAfterSeconds(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const retryAfterMs = error.retryAfterMs;
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return clampCooldown(retryAfterMs / 1000);
  }
  const message = typeof error.message === 'string' ? error.message : '';
  const phrase = /resets in ((?:\d+\s*[dhms]\s*){1,4})/i.exec(message);
  if (phrase === null) return null;
  let seconds = 0;
  for (const part of phrase[1]!.matchAll(/(\d+)\s*([dhms])/gi)) {
    const amount = Number(part[1]);
    const unit = part[2]!.toLowerCase();
    seconds += amount * (unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1);
  }
  return clampCooldown(seconds);
}

/**
 * The `error` object of the last top-level OpenCode error event in a log
 * window, or null. Lines that are not a JSON object with `type: "error"` are
 * skipped, so prose and tool output cannot supply a retry hint.
 */
export function lastProviderErrorEvent(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRecord(parsed) || parsed.type !== 'error' || !isRecord(parsed.error)) continue;
    return parsed.error;
  }
  return null;
}
