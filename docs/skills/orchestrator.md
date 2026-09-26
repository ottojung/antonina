# Antonina board orchestrator

Use this skill for a recurring orchestrator that selects, continues, and hands off work through an Antonina board.

The Antonina CLI is the orchestration interface. Read and mutate the board through `antonina board ...`; do not bypass it with direct Skrynia access, browser automation, or a second private queue.

## Operating model

Treat each invocation as a fresh reconciliation pass. Conversation history is optional context; the board, referenced agent state, repository state, branches, pull requests, tests, and durable host resources are the sources of truth.

The orchestrator has four jobs:

1. reconcile the board with objective execution state;
2. continue useful work already in progress when possible;
3. build the largest clearly safe and useful parallel frontier from the board queue;
4. leave append-only board updates that make later passes able to continue safely.

Do useful work and then return. Do not keep an invocation alive merely to wait for a long-running agent or external event. A later invocation should be able to reconstruct the state from the board and the durable artifacts named there.

## Board access

Use JSON output for orchestration decisions.

```sh
antonina board access --json
antonina board queue list --json
antonina board list --state open --json
antonina board show NUMBER --json
```

The board trust anchor and credential come from Antonina's config directory. Never print, copy into comments, or otherwise expose credentials, private keys, tokens, or other secrets.

Comments need an author. Prefer one stable identity for the orchestrator, configured with `ANTONINA_BOARD_AUTHOR`, for example `openclaw@marceline-dev`. Passing `--author` explicitly is also valid.

If the board is readable but not editable, do not pretend to claim or complete work. Read enough state to diagnose the problem, then stop without making unrecorded substantive changes.

## Queue semantics

The board queue is the shared priority order of all open issues. The first issue is the highest priority.

Queue order and execution continuity are deliberately different concepts:

- **Queue order** expresses shared priority.
- **Continuity** says that useful work which is already genuinely in progress should normally be resumed instead of abandoned and restarted.

Do not move an issue merely because you started working on it. Do not demote a blocked issue merely because it is blocked. Do not reorder the queue to encode local scheduler state.

Use `antonina board queue reorder ...` only when a human instruction, issue requirement, or explicit queue-management task actually changes shared priority. When the orchestrator creates a follow-up issue, let the normal create operation append it unless there is an explicit reason to change priority.

Closing an issue removes it from the queue. Reopening it appends it. Treat both as meaningful queue mutations.

## Work-selection algorithm

At the beginning of every pass:

1. Verify board access.
2. Read the queue.
3. Inspect enough queued issues, in queue order, to classify ongoing work, ownership, blockers, and actionability.
4. Reconcile any referenced agent, worktree, branch, pull request, job, or other durable artifact before trusting an old status comment.
5. Build a portfolio of useful concurrent work rather than stopping after one issue.

Selection proceeds in phases:

1. **Recoverable ongoing work.** Reconcile and continue every issue whose existing work can usefully continue now: a live subordinate agent to inspect or steer, a handoff with a clear next step, a branch or pull request awaiting the next local action, or interrupted work whose durable state is recoverable.
2. **Breadth scan.** Scan the queue from front to back. For each actionable unclaimed issue, ask whether it is clearly safe and useful to execute concurrently with the work already admitted into this pass. Admit it when the answer is yes; otherwise defer it and keep scanning.
3. **Prefer obvious independence.** Issues from clearly unrelated projects or repositories should normally be admitted concurrently unless they share an explicit dependency, deployment target, mutable external resource, or other concrete conflict. Do not stop scanning merely because an earlier issue is already being worked on.
4. **Be conservative within one project.** When two issues appear to belong to the same project, defer additional work unless there is positive evidence that the fronts are independent. The same repository is not proof of conflict: monorepos may contain independent packages, apps, services, or subsystems that can safely progress in separate worktrees.
5. **Depth scan.** After establishing broad cross-project parallelism, revisit deferred same-project issues in queue order and admit additional work when independence is evident.
6. **Intra-issue parallelism.** For substantial issues, consider complementary agents with genuinely different roles, such as implementation, independent review, verification/testing, or focused research/design. Do not spawn duplicate agents merely to increase concurrency.
7. **No further safe work.** Stop expanding the frontier when additional work would be blocked, duplicate existing work, or rely on uncertain independence.

Queue order still expresses shared priority. The orchestrator should preserve that priority while exploiting concurrency; do not reorder the queue merely to encode scheduler state.

Useful evidence of independence includes disjoint repositories, separate monorepo packages/apps, unrelated subsystems, separate worktrees, distinct deployment targets, or clearly non-overlapping implementation areas. Potential conflict domains include the same source files, shared core APIs under active redesign, one database/schema migration path, the same mutable deployment environment, or another shared external resource.

Development can often proceed concurrently even when integration must later serialize. Separate branches or worktrees may be safe to implement in parallel and then merge into a shared release branch one at a time.

Do not manufacture work merely to stay busy.

## Actionability

An issue is actionable when there is a concrete next action the orchestrator or one of its agents can perform now.

Before classifying an issue as blocked or abandoned, inspect objective state when possible. A stale-looking comment is weaker evidence than a live agent, existing worktree, updated branch, open review, completed job, or other inspectable artifact.

If a blocker has cleared, resume the issue rather than leaving the stale blocker comment authoritative. Append a new status comment describing the new state.

## Claims and concurrency

Board comments are append-only coordination records, not locks.

Before starting new substantive work on an unowned issue:

1. read the issue;
2. append a `working` orchestrator comment;
3. immediately read the issue again;
4. if a later conflicting `working` claim from another orchestrator now exists, yield before launching duplicate work.

The latest coordination comment in the issue history is the current declared status, but objective state can prove that declaration stale.

Treat a fresh `working` claim by another orchestrator as active. After roughly ten minutes without a newer update, investigate rather than blindly stealing it. If the referenced execution is still demonstrably live, leave it alone. If it is terminal, missing, or otherwise no longer progressing, recover the work by appending a new `working` comment that says what was inherited.

Elapsed time alone is not proof that useful live work is abandoned.

## Append-only status comments

Never edit or replace an earlier progress comment. Never use the issue description as a mutable status field. Preserve the history and append the next fact.

Use this compact shape for orchestrator-authored status comments:

```text
[orchestrator]
state: working | handoff | blocked | completed
owner: <stable orchestrator identity>
run: <short run identifier>
summary: <what materially changed or what is being continued>
artifacts: <agent IDs, host paths, branches, PRs, jobs, or "none">
validation: <relevant checks already established, or "pending">
next: <single concrete next action, or "none">
```

The fields are a coordination convention, not a reason to add a parser or schema to Antonina.

Use comments for outcomes and durable handoff facts, not narration. Good times to append one are:

- claiming or recovering an issue;
- reaching a meaningful implementation or investigation milestone;
- discovering or clearing a real blocker;
- handing work to a later pass;
- finishing the issue.

Do not comment after every command, poll, test, or scheduler tick. Do not report worker counts, capacity saturation, routine process bookkeeping, or other mechanics that do not help the next decision.

If older history uses another status format, read it as ordinary human-readable history and continue with the format above. Do not add compatibility machinery for old comment conventions.

## Ongoing agents and subprocess work

Inspect existing subordinate agents before spawning replacements. Continue or steer a useful live agent when that is cheaper and safer than restarting the same work.

When Antonina's managed agent runtime is appropriate, use the CLI:

```sh
antonina agent list
antonina agent status --id ID
antonina agent log --id ID
antonina agent prompt --id ID '...'
antonina agent new --id ID --cwd /absolute/worktree
```

Record a new agent ID and its worktree in the issue comment before relying on them for handoff. Use separate worktrees for materially independent repository work.

Parallel agents are useful for genuinely independent fronts and for complementary roles on the same substantial issue. Favor broad, clearly independent work first; then add proven same-project or intra-issue parallelism. Do not spawn duplicates just to fill capacity.

Do not wait idly for long-running agents. Inspect what is available now, steer if useful, record durable state when it materially changes, and let a later orchestrator pass continue.

## Progress, blockers, and handoff

A handoff comment should let a fresh orchestrator continue without reconstructing the entire history. State:

- what was actually accomplished;
- the current durable artifact to inspect;
- what remains;
- the next concrete action;
- any blocker that prevents that action.

Prefer factual state such as a branch name, commit, PR, test result, agent ID, or host path over prose about effort.

A blocked issue stays open. Name the blocker precisely and, when possible, the event that would clear it. Once the blocker is recorded, continue with the next actionable queued issue rather than repeatedly rediscovering the same block.

Do not create a follow-up issue for work that is merely the unfinished remainder of the current issue. Create a new issue only when it is a distinct durable task that deserves independent priority, lifecycle, or ownership.

## Durable host resources

When work depends on a durable host path, follow [resources.md](resources.md).

Register and verify the dependency before relying on the path for handoff. When moving a resource dependency to a follow-up issue, add and verify the new dependency before removing the old one or closing the old issue.

Never perform resource collection merely as part of routine orchestration.

## Completion

Do not equate "agent stopped", "tests passed", "PR opened", or "code written" with issue completion.

Derive the completion predicate from the issue plus the target repository's instructions. It normally includes the requested result, required validation, required review/integration state, and absence of unresolved blockers.

Before closing an issue:

1. reconcile the claimed result with objective repository/execution state;
2. make any required resource handoff safe;
3. append a `completed` comment naming the result and validation;
4. close the issue with `antonina board close NUMBER`;
5. verify that the issue is closed and no longer appears in the queue.

If the implementation is ready but a human-only action is still required, use `handoff`, leave the issue open, and name that action explicitly.

## Failure behavior

A failed command is not progress. Diagnose failures from objective state and avoid writing optimistic comments.

If one issue is blocked by an external service, unavailable host, review dependency, or other recoverable condition, record the blocker once and continue with other actionable queue work.

If board trust, write access, or board availability itself is broken, stop board-mutating work rather than creating untracked state elsewhere.

Never put secrets in issue bodies, comments, branch names, logs quoted into comments, or command examples recorded on the board.

## Minimal command reference

```sh
# inspect
antonina board access --json
antonina board queue list --json
antonina board list --state open --json
antonina board show NUMBER --json

# append coordination state
antonina board comment NUMBER BODY
antonina board comment NUMBER BODY --author NAME

# issue lifecycle
antonina board create TITLE --body BODY
antonina board close NUMBER
antonina board reopen NUMBER

# shared priority, only when priority really changed
antonina board queue reorder N1 N2 N3

# durable resource dependencies
antonina board resource list --issue NUMBER
antonina board resource add NUMBER HOST PATH
antonina board resource remove NUMBER HOST PATH
```

The board is the durable coordination memory. Keep it concise, factual, append-only, and sufficient for the next fresh pass.
