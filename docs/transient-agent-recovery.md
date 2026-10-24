# Recovery after temporary model and provider failures

A transient OpenCode error describes **backend availability**, not whether the
previous model turn already committed external actions. The field
`backend_error.automatic_retry_safe` is consequently about **literal replay**
of that turn. A false value must not prevent safe continuation of a managed
agent.

## Recovery policy

1. Classify explicit 5xx, endpoint outages, rate limits and quota exhaustion
   separately from provider authentication, billing, missing models, external
   signals and unrecognized non-transient errors.
2. On a recoverable failure, terminate any verified surviving invocation
   descendants and checkpoint the native OpenCode session ID where possible.
   The next model receives a **new reconciliation instruction**, not the
   original prompt again. It must inspect conversation, files, Git and durable
   task state before completing only unfinished work.
3. Where the native session is unavailable, launch a fresh reconciliation
   instruction with the original task quoted **as context**, never silently
   resend the original user prompt as an executable command. Do not claim
   exactly-once execution: truly ambiguous external side effects require
   inspection or explicit review.
4. Prefer eligible configured models; a model encountering transient errors
   gets a short soft penalty. If every nonexcluded model has failed, make a
   fresh randomized pass through that soft pool. Transient errors never turn
   into an unconditional per-invocation exhaustion halt. Retry delay grows
   exponentially but is capped at 30 seconds plus bounded jitter.
5. A verified silent model step with a durable native session and no active tool subprocess is also recoverable on its **original model** when alternatives are unavailable. Silence with unresolved tools or an unverifiable process tree is not proof of safe interruption.
6. Quota/rate-limit cooldowns are respected; when *only* timed exclusions
   remain, await expiry while periodically checking for changed configuration,
   stop and steer. Genuine unsupported models, authentication failures and
   billing exclusions are not retried with the same invalid credentials.
6. Every backoff remains under the existing runner ownership and stop/steer
   checks. Recovery is observable as running status with a backend-error record
   and explicit `recovering from ...` diagnostic, rather than a failed dead
   appointment. Success clears the transient diagnostic.

**Limitations:** A model-generated reconciliation cannot prove exactly-once
external effects. The native backend must durably record session state for
precise continuity. If it cannot, the new task is deliberately conservative.
Permanent/configuration errors stay visible, and host signal deaths are not
misclassified as server outages.

Regression coverage: multiple consecutive server errors (including after the
whole soft model pool is exhausted), continuing the same native session,
missing-session recovery, operator stop during backoff, permanent backend
errors and attached CLI exit semantics. No OpenCode model catalog discovery
is introduced and no change to model-preference priority is made.
