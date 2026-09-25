# Antonina scheduled-work itinerary

This itinerary is the entry point for scheduled ChatGPT tasks that maintain the Antonina repository. Read [`scheduled.md`](scheduled.md) for reusable ownership, recovery, liveness, and completion mechanics.

## Work selection

Prefer inheriting abandoned Antonina issues over selecting new work. If no abandoned work is available, select an actionable open issue that is neither actively owned nor already complete. Treat individual external blockers as recoverable; record enough durable state to continue other work.

## Integration

Scheduled work accumulates on the active `release/*` branch. A human promotes that branch into `main`. Start issue work from the active release branch in an isolated worktree, open the issue pull request against that branch, and merge only after implementation, validation, and review. Scheduled orchestrators must not merge into `main`.

## Completion

An issue is complete when its reviewed work is merged into the active release branch, that branch is reconciled with current `main`, repository verification passes on the exact resulting head, and no unresolved review blocker remains.
