# ADR 0002: Managed-agent steering is hard preemption

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deciders:** Antonina maintainers
- **Related issue:** #597
- **Supersedes / Superseded by:** none

## Context

`antonina prompt --steer` is an operator/orchestrator control operation for a
managed coding-agent session that is already running. There are two plausible
meanings for such a control:

1. graceful steering, in which the current tool batch or model turn finishes
   before the new instruction is injected; and
2. hard preemption, in which Antonina may terminate the currently executing native
   invocation and its owned process tree so that the new instruction takes
   precedence immediately enough for operational control.

Some coding-agent backends provide a native safe-boundary steer mechanism. That
can produce clean transcript history, but it also makes intervention latency
backend-dependent and can force Antonina to let an expensive, stuck, or known-wrong
tool continue merely to reach a polite agent-loop boundary.

Antonina treats managed-process ownership as lifecycle metadata rather than
inferring it from process names. Steering should therefore have a
backend-independent product meaning at the process boundary rather than inherit
whichever semantics a particular coding-agent harness happens to expose.

## Decision

When `--steer` is accepted for a running managed agent, the new instruction
**supersedes the current invocation**. Antonina may terminate the exact currently
owned native invocation, including an in-progress owned tool subprocess, instead
of waiting for the current tool call or model turn to finish.

Steering is therefore stronger than "enqueue this after the current work". It is
a control-plane preemption request for the current logical managed-agent session.

This is **preemption, not rollback**. Antonina does not promise transactional undo of
work performed before interruption. Files already written may remain; external
requests already sent may complete independently; generated artifacts may be
partial; and other side effects already committed may survive. The continuation
must inspect and reconcile real repository/system state after the interrupted
invocation rather than assume the interrupted tool did nothing.

The public steering contract is backend-independent. A backend-native steer API
may be used as an implementation technique only when it preserves the contract
below; the existence or absence of such an API must not change what callers can
rely on.

## Linearization and convergence

The lifecycle linearization point is the durable acceptance of the steer while
the running invocation still belongs to the managed agent and no stronger
lifecycle authority has already won. At that point:

- the steer becomes durable pending work for the logical session;
- the old invocation becomes superseded and must converge toward termination;
- ordinary continuation of the old work is no longer an acceptable steady state;
- a replacement/continuation invocation starts after Antonina has terminated the
  recorded process group using its persisted PID/start-time/agent/invocation
  metadata as a best-effort ownership check.

The TypeScript runtime intentionally does not provide a kernel-level guarantee
against the narrow race where a PID/PGID is recycled between the final metadata
check and a normal Node signal syscall. That risk is accepted in exchange for a
small portable runtime without a native pidfd addon.

The termination policy is SIGTERM-first with bounded escalation to SIGKILL.
Antonina should validate recorded process identity before signalling when
practical, but ordinary Node/POSIX signalling is the product requirement.

## Required invariants

### Durable acceptance

Once a steer command reports success, the instruction must remain durably
accepted until it is delivered to the continuing logical agent session or is
explicitly blocked by stronger lifecycle authority. Killing the superseded
invocation must never also discard the steer that motivated the kill.

### Recorded target

Antonina interrupts the invocation recorded in durable managed-agent metadata.
It must not use process-name matching or broad host-wide process discovery.
PID/start-time and agent/invocation markers should be checked when available;
the remaining numeric-signal race described above is accepted.

### Supersession

After a steer wins the lifecycle race, the superseded invocation must not be
allowed to continue indefinitely while the steer merely waits behind it. The
system must converge either to proven retirement followed by continuation, or to
a fail-closed state that exposes unresolved convergence.

### Session continuity

A steer preserves one logical Antonina managed-agent session. Durable history that
was safely committed before interruption remains part of that session. Antonina
must not invent a successful tool result for work that was killed before a
trustworthy result existed.

When the backend supports safe continuation of the same native session after an
interrupted turn, Antonina should use it. When special recovery is required, the
implementation must represent the interrupted/incomplete turn honestly and
resume from durable history plus observed repository/system state.

### Lifecycle priority

Destructive lifecycle controls outrank steering:

- an accepted stop or kill cannot be overwritten by a later steer;
- steer cannot resurrect an agent after successful stop or kill;
- delete remains authoritative;
- a steer racing with stop, kill, or delete must resolve to one deterministic
  lifecycle winner.

### Idle behavior

`antonina prompt --id <ID> --steer 'task'` on an idle, finished, or
never-started agent behaves like an ordinary prompt. There is no running
invocation to preempt.

## Multiple steers

Antonina preserves deterministic FIFO semantics for multiple accepted steers.
Every accepted steer is durable work in arrival order. A later steer does not
silently erase an earlier accepted steer.

If another steer arrives while the previous steer is still converging the old
invocation or while its continuation is starting, the newer steer is appended to
the durable queue. Once lifecycle authority reaches the next runnable point, the
queue is consumed in order. Implementations may optimize delivery internally,
but they may not reorder or coalesce accepted steers unless this ADR is
superseded.

## Alternatives considered

### Safe-boundary/native steering

A backend may inject a steer after the current tool batch and before the next
model call.

Advantages include cleaner backend history, no deliberately interrupted tool
execution, and less process churn. The decisive disadvantage is control latency:
a wrong or expensive tool may continue for an arbitrarily long time before the
safe boundary arrives. It also makes public semantics depend on backend-specific
agent-loop capabilities.

This is rejected as the product-level definition of `--steer`.

### Hard process preemption

Antonina terminates the exact running invocation/process tree and continues the
logical session under the new instruction.

This gives immediate operator control, remains meaningful across coding-agent
backends, and stops known-wrong or wasteful work promptly. The costs are accepted
partial side effects, interrupted-turn recovery complexity, and the need to keep
steer semantics strictly separate from terminal stop/kill semantics.

This is the chosen architecture.

### Hybrid/adaptive steering

A hybrid could use backend-native steering when available and hard preemption
otherwise. That is acceptable only as an implementation optimization if the
backend-native path satisfies the same bounded-control semantics and lifecycle
invariants. A hybrid that lets intervention latency vary materially by backend
would make the public contract unpredictable and is rejected.

## Consequences

- Orchestrators may rely on `--steer` as a real control operation rather than a
  polite queued suggestion.
- Steering may leave partial filesystem, process, network, or external-service
  side effects; continuation code and agents must inspect reality and reconcile.
- Managed-process metadata checks remain important, but kernel-level pidfd
  retirement guarantees are not required.
- Status and logs should make a "steer accepted, old invocation converging"
  state observable rather than falsely reporting an already-idle session.
- Implementations must preserve durable FIFO steering and deterministic
  stop/kill/delete priority.
- Backend-specific live-steer APIs are optional mechanisms, not the architectural
  contract.
- Any future change that makes running-agent steering wait indefinitely for a
  tool/model-turn boundary, silently coalesces accepted steers, or weakens exact
  process authority must explicitly supersede this ADR.

## Follow-up implementation work

Implementation changes should be split into focused issues after this decision.
In particular, follow-up work should verify that the current steer acceptance,
process interruption, continuation, status/log reporting, interrupted-turn
recovery, and multiple-steer races all satisfy the invariants above. The current implementation lives in the TypeScript managed-agent runtime.

## References

- Issue #597 — architectural request and acceptance criteria.
- `packages/agent-runtime/` — managed-agent prompt/steer lifecycle and durable
  steer queue.
- `packages/cli/` — `antonina agent prompt --steer` command surface.
- TypeScript lifecycle, process, and built-runtime integration tests under
  `packages/agent-runtime/test/` and `packages/cli/test/`.
