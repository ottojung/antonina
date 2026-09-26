# TypeScript migration completion record

Issue #28 replaced Antonina's Python production stack with one TypeScript/Node.js implementation. The migration is complete when this document is read on the cutover branch: Python source, Python packaging, Python CI, and the duplicate Python test suite have been removed.

## Canonical runtime

The public executable is `antonina`, shipped as precompiled JavaScript for Node.js 22 or later. OpenCode remains an intentionally external executable.

The supported command namespaces are:

- `antonina agent ...`: `new`, `list`, `status`, `prompt`, `log`, `wait`, `stop`, `kill`, `delete`, and `clean`;
- `antonina board ...`: `list`, `show`, `create`, `edit`, `comment`, `close`, `reopen`, and resource operations.

`_runner` is an implementation-private entry point.

## Shared board contract

`packages/core` is the authoritative board/domain implementation consumed by both the CLI and web application. It owns schema validation, resource semantics, Skrynia ETag/CAS behavior, deterministic mutation replay, capability handling, and common errors.

Important invariants include strict schema version 2 parsing, JavaScript-safe issue counters, chronological messages, canonical resource identities, existing-issue dependency checks, and ETag-based mutation retries after HTTP 412.

## Managed-agent runtime contract

`packages/agent-runtime` owns durable state and execution semantics; `packages/cli` owns command parsing and presentation.

Durable state lives under `$XDG_STATE_HOME/antonina`, falling back to `$HOME/.local/state/antonina`. Metadata is written by atomic replacement with fsync, and concurrent metadata changes are serialized by a stale-reclaimable Node lockfile protocol.

The runtime preserves the important high-level lifecycle invariants from the retired implementation:

- caller-supplied hexadecimal IDs are canonicalized to lowercase at input boundaries;
- accepted prompts, runner generations/reservations, FIFO steers, deletion tombstones, and terminal states are persisted;
- the first prompt creates an OpenCode session and later prompts continue it;
- a lost durable native-session ID is recovered from the Antonina OpenCode session title when possible;
- ordinary prompts reject genuinely busy agents while `--steer` is hard preemption followed by FIFO continuation;
- stop/kill cancel running or reserved work and converge metadata;
- delete records a tombstone before converging live work, and clean rechecks candidates under the metadata lock;
- status/list sanitize malformed persisted fields rather than copying corrupt authority into output;
- recognized backend failures are stored as bounded structured diagnostics, and retries require explicit replay-safety evidence.

## Deliberate process-control simplification

The TypeScript runtime does not reproduce the retired Python pidfd/flock edge machinery. Antonina checks persisted PID/start-time/agent/invocation markers where practical and then uses ordinary Node/POSIX signalling, including negative-PGID signalling for process groups.

A narrow PID-reuse race between the final identity check and the signal syscall is accepted. Native addons solely to reproduce pidfd/flock guarantees are out of scope unless a future requirement explicitly changes that tradeoff.

## Verification

CI typechecks the shared core, agent runtime, and CLI; runs their Node test suites; packs and installs the precompiled CLI; executes an installed-package managed-agent lifecycle against a fake OpenCode; and runs the web tests/build.

Execution hosts require Node.js plus external tools such as OpenCode. They do not require Python or a TypeScript compiler.
