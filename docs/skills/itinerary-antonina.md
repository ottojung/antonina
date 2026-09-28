# Antonina scheduled-work itinerary

This itinerary contains Antonina-specific execution, integration, and completion policy. For queue selection, ownership, recovery, append-only progress reporting, handoff, and board lifecycle, read and obey [`orchestrator.md`](orchestrator.md) first.

The Antonina board is the coordination authority. Work selected by an orchestrator must come from the board; do not use GitHub issue order, a private task list, or a mutable status comment as a second queue.

Target repository:

<https://github.com/ottojung/antonina>

## Work selection

Use the board-selection algorithm from `orchestrator.md`. When the selected board issue represents a GitHub issue, treat the GitHub issue as problem/specification context and the Antonina board issue as the coordination record.

Continue recoverable ongoing Antonina work before starting duplicate work. If the selected issue is blocked, append the blocker and let the generic orchestrator select another actionable board issue.

## Integration

Scheduled work accumulates on one current active `release/*` branch. A human promotes that branch into `main`.

The active release branch is the newest `release/*` branch on `origin` that still holds commits `main` lacks, measured as `git rev-list --count origin/main..BRANCH` being greater than zero, always against `origin/main` rather than a local `main` that a worktree may hold stale. A branch that holds no such commit has been promoted and is retired, because a human promotes a release branch by merging it into `main`. A branch freshly cut from `main` holds nothing `main` lacks, so it is active, and it stays active until `main` catches up with it; when branches exist but none holds a commit `main` lacks, a pass must reuse the newest of them rather than cut another. Newest means last in branch-name order, because a `release/*` branch created today can share a commit with every other branch created today and then commit dates cannot order them. Only when `origin` carries no `release/*` branch at all does a pass create one from current `main`. Reuse the same active release branch across scheduled issues.

Start issue work from the active release branch in an isolated worktree, open the issue pull request against that branch, and merge only after implementation, validation, and review. Scheduled orchestrators must not merge into `main`.

## Completion

An Antonina board issue is complete when its requested repository result is implemented, reviewed work is merged into the active release branch, that branch is reconciled with current `main`, repository verification passes on the exact resulting head, and no unresolved review blocker remains.

Then append the completed board comment, close the Antonina board issue, and verify that it has left the queue, as required by `orchestrator.md`.
