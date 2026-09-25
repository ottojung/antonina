# Durable host resources

Use this skill when scheduled or agentic work creates, uses, or hands off a durable host filesystem location. A resource is a host and canonical absolute POSIX path, such as `lubko://phoebe-dev` plus `/workspace/project-worktree`; the path may be a file or directory.

Resource registration is dependency and liveness metadata, not exclusive ownership or a lock. Multiple open Antonina issues may depend on one resource. Every number in these commands is an **Antonina BOARD issue number**, never a GitHub issue number.

## Garbage collection semantics

A deterministic garbage collector runs regularly on hosts, but it is deliberately opaque to agents. Agents do not know when a collection pass will happen and must never plan around cadence or timing.

Any path not protected by at least one open Antonina board issue may disappear at any time. A resource is protected while any dependent issue is open and collectible when all dependents are closed. Closing the last open dependent issue can make the resource collectible immediately; do not rely on a grace period.

## Commands

```sh
antonina board resource list [--host HOST] [--issue NUMBER]
antonina board resource add ISSUE HOST PATH
antonina board resource remove ISSUE HOST PATH
```

`--host` and `--issue` narrow inspection; verify registrations rather than assuming a command succeeded.

## Safe handoff

1. Inspect the old issue's resources.
2. Add the follow-up open issue dependency first.
3. Verify the resource list output includes the follow-up dependency and shows it protected.
4. Only then close the old issue or remove the old dependency.

For example, hand off `/workspace/project-worktree` from Antonina board issue `412` to open follow-up issue `419`:

```sh
antonina board resource list --issue 412
antonina board resource add 419 lubko://phoebe-dev /workspace/project-worktree
antonina board resource list --issue 419
antonina board resource remove 412 lubko://phoebe-dev /workspace/project-worktree
```

Unregister a path when no issue needs it:

```sh
antonina board resource remove 419 lubko://phoebe-dev /workspace/project-worktree
```

Host values are `lubko://<server>` with no trailing slash; paths are canonical absolute POSIX paths.
