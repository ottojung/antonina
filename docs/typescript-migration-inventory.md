# TypeScript migration inventory

Issue #28 replaces Antonina's production Python implementation with one TypeScript/Node.js stack. This inventory is the compatibility contract for the staged migration. A stage may add TypeScript alongside Python, but it must not weaken these invariants, and Python remains authoritative until the corresponding TypeScript behavior is covered and the public executable is deliberately cut over.

## Public command surface

The eventual canonical executable remains `antonina` with two public namespaces:

- `antonina agent ...`
- `antonina board ...`

The current Python agent parser exposes these managed-agent operations, which must survive the cutover: `new`, `list`, `status`, `prompt`, `log`, `wait`, `stop`, `kill`, `delete`, and `clean`. `_runner` is an implementation-private entry point and must remain hidden from the public command surface.

The board namespace currently exposes `list`, `show`, `create`, `edit`, `comment`, `close`, `reopen`, plus `resource list`, `resource add`, and `resource remove`. JSON mode is deterministic and scripting-relevant. Board writes use `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_CAPABILITY`, and `ANTONINA_BOARD_AUTHOR`.

## Board protocol invariants

The shared TypeScript core must be the only authoritative implementation used by both CLI and web once this part is cut over.

- Canonical persisted schema is board schema version 2 at Skrynia `antonina/board-v1` until a later issue deliberately changes it.
- Reads require a valid ETag before state may become a mutation base.
- Writes require the 64-hex capability and use `If-Match`; a 412 must re-read and reapply the logical mutation, not blindly retry stale JSON.
- Malformed/incompatible documents fail closed.
- Issue numbers are positive JavaScript-safe integers and the next counter is greater than every existing issue number.
- Message order is chronological and mutation timestamps never move backward under caller clock skew.
- Resource identities are canonical `(lubko://host, absolute-normalized-posix-path)` pairs, dependencies reference existing issues, and dependency numbers are unique and sorted.
- A closed issue retains existing resource dependencies but cannot acquire a new one.
- Resource protection is derived from whether any dependent issue is open.
- CLI errors must not echo bearer capability material.

Primary parity sources: `tests/test_board.py`, `web/src/model.test.ts`, and `web/src/api.test.ts`.

## Agent durable-state and lifecycle invariants

The TypeScript runtime must port behavior, not merely command names.

### Durable authority

- Agent IDs are caller-supplied base-16 identifiers, canonicalized to lowercase at every input boundary; commands take IDs through `--id`.
- `$XDG_STATE_HOME/antonina` (default `$HOME/.local/state/antonina`) is durable authority for managed sessions.
- Metadata updates that establish or transfer lifecycle authority must be lock-serialized and crash-durable. Lock/open/write/fsync/rename failures must fail closed rather than allowing the caller to advance as though authority changed.
- The current metadata schema/version and every authoritative field need an explicit TypeScript validator. Old/malformed/unknown durable state must never silently gain execution or signalling authority.
- Accepted prompts, runner reservations/generations, deletion intent, and terminalization must survive process crashes without becoming ambiguous.

Primary sources: `src/antonina/durable.py`, `tests/test_pending_prompt_metadata.py`, `tests/test_prompt_count_authority.py`, `tests/test_runner_claim_generation_strict.py`, `tests/test_runner_generation_authority.py`, `tests/test_runner_reservation_mode.py`, `tests/test_runner_reservation_state.py`, and the preserved #7/#8 work at `af7bb216e9e38d84643fc190aa26c0cf6f8c13cb`.

### Process ownership and signalling

- Never infer ownership from process names.
- Persist PID, process start time, agent ID, and invocation ID, and check that evidence before signalling when it is available.
- The TypeScript migration does **not** preserve the old pidfd-level guarantee against the narrow race where a PID is recycled between the final identity check and Node's numeric signal syscall. This is an intentional simplification accepted for #28.
- Ordinary Node process signalling is sufficient. Keep checks conservative around malformed metadata, but do not add native addons solely to reproduce Python's pidfd guarantees.

Primary sources for behavior worth retaining: `tests/test_agent_id_liveness_authority.py`, `tests/test_agent_invocation_group_authority.py`, and lifecycle/convergence tests. The pidfd-specific delivery tests are not migration blockers.

### Runner reservation, prompting, and steering

- `new` creates durable managed state only; it does not launch the backend.
- A prompt establishes durable accepted work before runner execution and uses generation/reservation ownership so at most the authorized runner consumes it.
- The first prompt may create the native backend session; later prompts continue it.
- `--steer` is hard preemption: accepted steering survives races, interrupts the current invocation through exact authority, and resumes only through the authorized next invocation.
- Backend launch/session-discovery failures must leave coherent retryable or terminal durable state; no accepted work may disappear silently.

Primary sources: `tests/test_runner_exit_authority.py`, `tests/test_agent_backend_errors.py`, `tests/test_opencode_session_discovery.py`, `tests/test_steer_metadata.py`, `tests/test_steer_preemption.py`, and `docs/adr-0002-steering-is-hard-preemption.md`.

### Stop, kill, delete, and clean convergence

- `stop` and `kill` target the currently recorded invocation after validating its persisted identity as far as Node can reasonably observe it.
- Stop first uses graceful termination and may escalate to forced termination. Numeric PID/PGID signalling races are accepted; native pidfd machinery is out of scope.
- Stop/kill also cancel reserved-but-not-yet-started runner work; they may not report quiescence while accepted work could still execute.
- `delete` first records a durable deletion tombstone under the metadata lock, then converges every exact runner/invocation identity before removing state. Failure to prove convergence preserves retryable state.
- `clean` uses the same safe deletion machinery; dry-run is observation-only and races that make a candidate live cause it to be skipped, never killed by retention cleanup.

Primary sources: `tests/test_stop_convergence.py`, `tests/test_agent_stop_authority.py`, `tests/test_abort_convergence.py`, and `tests/test_agent_clean.py`.

## Staged cutover gates

1. Shared board model/storage semantics are extracted to `packages/core` and web imports them rather than owning copies.
2. TypeScript board CLI reaches behavioral parity while Python board tests remain green; only then may the public board path cut over.
3. Agent metadata/durable I/O and process-identity primitives are ported with direct invariant tests.
4. Runner/prompt/steer lifecycle is ported and exercised against a controllable fake backend plus real process-race tests.
5. Stop/kill/delete/clean convergence tests pass in Node for ordinary lifecycle behavior and malformed-state handling; pidfd-specific PID-reuse guarantees are not required.
6. The canonical `antonina` executable switches to built JavaScript. Python production code and packaging are removed in the same completion sequence rather than retained as an alternate runtime.
7. CI tests the built artifact itself, and ordinary execution hosts need Node.js plus intentionally external tools such as OpenCode, not Python or a TypeScript compiler.
