# TypeScript migration completion record

Issue #28 replaced Antonina's Python production stack with one TypeScript/Node.js implementation. This is a historical cutover inventory, not a claim that every interface remains unchanged. **Current post-issue-320 contract:** board issue IDs and managed-agent IDs are single, case-sensitive, opaque strings. The shared generator chooses a random 22-character base62 prefix and an independently random word for new identities. Legacy digit-only issue IDs are converted to strings when old persisted data is read; old signed operation bytes are still verified unchanged. There is no caller-chosen agent ID or second internal numeric issue identity. See `docs/intent-records/identifiers.md`.

## Canonical runtime

The public executable is `antonina`, shipped as precompiled JavaScript for Node.js 22 or later. OpenCode remains an intentionally external executable.

The supported command namespaces are:

- `antonina agent ...`: `new`, `list`, `status`, `run`, `log`, `wait`, `stop`, `kill`, `delete`, and `clean`;
- `antonina board ...`: `list`, `show`, `create`, `edit`, `comment`, `close`, `reopen`, and resource operations.

`_runner` is an implementation-private entry point. Public CLI syntax reserves positional words for command/subcommand selection only. Every data argument is a named `--option`, and every public command level supports both `-h` and `--help`. Board issue IDs are generated and returned by `board create` as strings; callers do not assign them. The issue model's `number` property is the *string ID* despite its historical name.

## Shared board contract

`packages/core` is the authoritative board/domain implementation consumed by both the CLI and web application. Live board state is stored as materialized snapshots split across Skrynia keys: paged issue summaries, per-issue bodies and comment pages, queue, catalog, feed, directories, and metadata. The one shared board credential supplies the board-wide storage key, and mutations commit atomically by CAS-updating the small board pointer. Normal v3 reads and writes do not replay history; the old signed board-v2 log is retained only as a one-time migration input for existing boards.

Important current invariants include strict schema parsing, opaque string issue IDs and queue/resource references, exact verification of legacy signed numeric wire data before conversion to strings, chronological messages, canonical resource identities, existing-issue dependency checks, summary-only list reads, localized issue mutation reads, and ETag-based mutation retries after HTTP 412. Historical `nextIssueNumber` fields are compatibility metadata, never the identity allocator for new issues.

## Managed-agent runtime contract

`packages/agent-runtime` owns durable state and execution semantics; `packages/cli` owns command parsing and presentation.

Durable state lives under `$XDG_STATE_HOME/antonina`, falling back to `$HOME/.local/state/antonina`. Metadata is written by atomic replacement with fsync, and concurrent metadata changes are serialized by a stale-reclaimable Node lockfile protocol. Both reads and writes validate the complete version-4 schema; there is no legacy metadata compatibility mode.

The runtime preserves the important high-level lifecycle invariants from the retired implementation:

- Antonina generates IDs when creating agents; existing and generated IDs are preserved exactly as supplied in references, with no case normalization or format-dependent consumer logic;
- accepted prompts, runner generations/reservations, FIFO steers, deletion tombstones, and terminal states are persisted;
- the first prompt creates an OpenCode session and later prompts continue it;
- a lost durable native-session ID is recovered from the Antonina OpenCode session title when possible;
- ordinary prompts reject genuinely busy agents while `--steer` is hard preemption followed by FIFO continuation;
- stop/kill cancel running or reserved work and converge metadata;
- delete records a tombstone before converging live work, and clean rechecks candidates under the metadata lock;
- managed-agent metadata is exact schema version 4; old, incomplete, extended, or malformed records fail closed at the persistence boundary;
- recognized backend failures are stored as bounded structured diagnostics, and retries require explicit replay-safety evidence.

## Deliberate process-control simplification

The TypeScript runtime does not reproduce the retired Python pidfd/flock edge machinery. Antonina checks persisted PID/start-time/agent/invocation markers where practical and then uses ordinary Node/POSIX signalling, including negative-PGID signalling for process groups.

A narrow PID-reuse race between the final identity check and the signal syscall is accepted. Native addons solely to reproduce pidfd/flock guarantees are out of scope unless a future requirement explicitly changes that tradeoff.

## Verification

CI typechecks the shared core, agent runtime, and CLI; runs their Node test suites; packs and installs the precompiled CLI; executes an installed-package managed-agent lifecycle against a fake OpenCode; and runs the web tests/build.

Execution hosts require Node.js plus external tools such as OpenCode. They do not require Python or a TypeScript compiler.
