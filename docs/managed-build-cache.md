# Managed disposable build cache

Agents that compile Rust commonly leave a large `target/` tree in every isolated
checkout. Those trees are regenerable, but they accumulate on a shared host and
have repeatedly consumed the free space needed by benchmarks and evidence.
Antonina therefore offers **one explicitly registered cache directory per
managed agent**. Nothing else is ever retired by this mechanism.

## Opt-in helper

An agent that wants a managed target directory asks for it:

```sh
# Prints the path, creating and registering it on first use (idempotent).
CACHE_DIR="$(antonina agent cache --id "$ANTONINA_AGENT_ID" --init)"

# The agent opts in explicitly. Antonina never overrides a project's own build
# settings and never exports CARGO_TARGET_DIR into unrelated work.
export CARGO_TARGET_DIR="$CACHE_DIR"
cargo test
```

`antonina agent cache --id <id>` without `--init` prints the registered path and
fails if no valid registration exists. `--init` is idempotent for the identical
marker; a preexisting unmarked target is never adopted, a marker that disagrees
with the agent, path or inode is an error and is never overwritten, and
symlinked root or agent-directory ancestors are rejected.

The directory is always

```
$XDG_STATE_HOME/antonina/build-cache/<agent-id>/target
```

with its identity marker at `.../<agent-id>/managed-cache.json`. It is **not**
derived from the agent's declared `cwd` and not discovered by walking any
workspace. A directory merely named `target` in a repository is never evidence
of ownership.

## What may live there

Only regenerable compiler output. Source, git state, unique binaries, receipts,
metrics, logs, frozen data, benchmark registries and OCI stores must remain
outside the managed cache. If a build product is needed after the agent is
gone, copy it to the worktree or an evidence directory before the agent ends.

## Automatic retirement

`antonina agent clean` retires a registered cache **inside the same metadata
lock that guards deletion of the agent record**, and only when all of these
hold:

- the freshly read record is in a terminal state and owns no invocation,
  runner, reservation, accepted prompt or pending deletion;
- the marker still names this exact agent and path and its recorded device and
  inode still match the directory (checked again immediately before removal);
- no other registration in the dedicated cache root points at the same path or
  inode;
- a **fresh** process and mount probe at deletion time finds no live reference
  under the cache path. The probe reads every process's `mountinfo` (including
  descendant mounts in that process's own namespace), decodes `/proc` octal path
  escapes and treats any unreadable evidence as unknown.

The directory's device/inode and live references are re-checked again after the
allocated-byte scan and immediately before removal. A pre-removal `intent`
manifest line is fsynced (record and directory) before deletion, with a distinct
fsynced `retired` completion line afterwards. A crash or removal failure leaves
the target and marker intact for a retry instead of a false completion.

The owner record is removed **only after** no registered cache remains. A cache
refusal, paused retirement or ambiguous cache evidence keeps the owner metadata
so a later `clean` can retry; `antonina agent delete` likewise refuses to
orphan a registered cache. On successful removal the target, marker and empty
agent directory are cleaned up so stale markers cannot block later claims. Any
refusal or unreadable/malformed/mismatched evidence, unreadable `/proc`,
`/proc/<pid>/mountinfo` or `/proc/mounts`, unknown process, changed inode, shared
claim, or failed removal retains the cache and leaves it retryable. Retirements
append JSON lines to `<state root>/managed-cache-retirements.jsonl`, outside the
removed tree.

`ANTONINA_AGENT_CACHE_RETIREMENT=0` pauses retirement for an operator who needs
to inspect a cache; it has no effect on launches or on benchmark guards.

## Non-goals

- No global or implicit `CARGO_TARGET_DIR` is set for any project.
- No declared `cwd`, workspace, repository or directory-name scan is performed.
- No launch is refused, delayed or capped on disk, cache or capacity state; see
  `docs/intent-records/agent.md` ("Agent launch is not host-capacity policy").
- No PX increment, benchmark guard, frozen artifact or production install is
  changed by this mechanism.
