# Durable host resources

## Purpose

Use this skill when scheduled or agentic work creates, uses, or hands off a durable host filesystem location. A resource is a host and an absolute path, such as `lubko://phoebe-dev` plus `/workspace/project-worktree`; the path may be a file or directory.

Resource registration is dependency and liveness metadata, not exclusive ownership or a lock. Multiple open Borys issues may depend on one resource. Use Borys issue numbers, never GitHub issue numbers.

## Commands

Inspect resources before relying on or closing work:

```sh
lubko-board resource list [--host HOST] [--issue NUMBER]
```

Register a dependency for an open Borys issue:

```sh
lubko-board resource add ISSUE HOST PATH
lubko-board resource add 412 lubko://phoebe-dev /workspace/project-worktree
```

Remove a dependency once it is genuinely no longer needed:

```sh
lubko-board resource remove 412 lubko://phoebe-dev /workspace/project-worktree
```

`--host` and `--issue` narrow inspection; use the output to verify registrations rather than assuming a command succeeded.

## Rules

- Register a path before relying on it across steps, invocations, or leaving it behind for later work.
- A resource is protected while any dependent Borys issue is open. It is collectible when all dependent issues are closed.
- Before closing an issue, inspect its resources. If a path must survive for follow-up work, add the open follow-up issue first, verify the registration, then close or remove the old dependency as appropriate. Do not close the last open dependent until the handoff is verified.
- Remove dependencies when they are genuinely no longer needed. Closing the last open dependent may make the path collectible immediately.
- Never plan around a grace period or garbage-collection cadence. The collector is deliberately opaque and runs regularly; treat an unprotected path as deletable immediately.
- The garbage collector implementation is out of scope; agents need only follow this registration and handoff protocol.

## Examples

Inspect the resources for a Borys issue:

```sh
lubko-board resource list --issue 412
```

Register a shared worktree for the current issue and a follow-up issue:

```sh
lubko-board resource add 412 lubko://phoebe-dev /workspace/project-worktree
lubko-board resource add 419 lubko://phoebe-dev /workspace/project-worktree
lubko-board resource list --host lubko://phoebe-dev
```

Hand off a path, remove the old dependency only after the new one is verified, and then close the old issue:

```sh
lubko-board resource add 419 lubko://phoebe-dev /workspace/project-worktree
lubko-board resource list --issue 419
lubko-board resource remove 412 lubko://phoebe-dev /workspace/project-worktree
```

Unregister a path when the issue no longer needs it:

```sh
lubko-board resource remove 419 lubko://phoebe-dev /workspace/project-worktree
```
