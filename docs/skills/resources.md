# Durable host resources

Use this skill when scheduled or agentic work creates, uses, or hands off a durable host filesystem location. A resource is a host and canonical absolute POSIX path, such as `lubko://phoebe-dev` plus `/workspace/project-worktree`; the path may be a file or directory.

Resource registration is dependency and liveness metadata, not exclusive ownership or a lock. Multiple open Antonina issues may depend on one resource. Use Antonina board issue numbers, never GitHub issue numbers.

## Commands

```sh
antonina board resource list [--host HOST] [--issue NUMBER]
antonina board resource add ISSUE HOST PATH
antonina board resource remove ISSUE HOST PATH
```

`--host` and `--issue` narrow inspection; verify registrations rather than assuming a command succeeded.

## Rules

- Register a path before relying on it across steps, invocations, or leaving it behind.
- A resource is protected while any dependent Antonina issue is open and collectible when all are closed.
- Before closing an issue, inspect its resources. Add and verify the open follow-up dependency before removing the old one.
- Remove dependencies when genuinely no longer needed. Never plan around a grace period.
- Host values are `lubko://<server>` with no trailing slash; paths are canonical absolute POSIX paths.
