# Antonina board orchestrator

Use this skill for a recurring orchestrator that selects, continues, and hands off work through an Antonina board.

Model constraint: use only `opencode-go/step-5-preview-free` (Step 5 Preview Free); never silently fall back. See `docs/intent-records/agent.md`.

The Antonina CLI is the orchestration interface. Read and mutate the board through `antonina board ...`; do not bypass it with direct Skrynia access, browser automation, or a second private queue.

## Operating model

Treat each invocation as a fresh reconciliation pass. Conversation history is optional context; the board, referenced agent state, repository state, branches, pull requests, tests, and registered coordination paths are the sources of truth.

The orchestrator has four jobs:

1. reconcile the board with objective execution state;
2. continue useful work already in progress when possible;
3. launch every distinct board front that is topologically ready and non-conflicting;
4. leave append-only board updates that make later passes able to continue safely.

Do useful orchestration work and then return. Do not keep an invocation alive merely to wait for a long-running agent or external event. A later invocation should be able to reconstruct the state from the board and the durable artifacts named there.

## Delegation boundary

The orchestrator is a coordinator, never an implementation worker. It must not implement issue work itself.

All substantive repository work must be delegated to Antonina agents. This includes source, test, documentation, configuration, migration, or generated-file edits; committing; merging or rebasing; cherry-picking; pushing repository refs; release integration; deployments; and substantial build/test/validation work. Independent review, verification, research, and integration are agent roles too: launch or steer an agent for them instead of doing them in the orchestrator process.

The orchestrator may perform bounded coordination operations needed to delegate safely: inspect board and agent state; inspect repository metadata and small diffs read-only; fetch refs; create or register worktrees/branches as agent reservations; write board comments; launch, steer, stop, or harvest Antonina agents; and close/reopen/reorder board issues when the durable evidence warrants it. These coordination actions must not become a back door for implementing the issue.

Once a useful agent has been launched and its real ID/resources are durably recorded, do not remain alive to supervise it command-by-command or wait for it to finish. Continue only long enough to fill other clearly safe frontier slots and record coordination state, then return. A future invocation will reconcile the results.

## Board access

Use JSON output for orchestration decisions.

```sh
antonina board access --json
antonina board queue list --page 1 --json
antonina board list --state open --page 1 --json
antonina board show --id NUMBER --page 1 --json
```

Collection reads never choose a page implicitly. The following commands require a 1-based `--page N`: `board queue list`, `board list`, `board feed`, `board resource list`, `board target list`, `board collect list`, and `agent list`. Page 1 is the start of each collection; for issues it contains the highest-priority open issues first. The default page size is 50. `board feed --limit N` and `agent list --limit N` change their page size without making `--page` optional.

When a pass needs more than the first page, increment the page number explicitly until enough state has been read or an empty page is reached. `board show --id NUMBER --page 1` returns the issue description plus the newest comment page; increment `--page` to read older comments when the current state is not yet clear. If the pass mutates queue membership or order while scanning — for example by closing, reopening, creating, or reordering issues — restart any priority-sensitive scan at page 1 before making further scheduling decisions. Other single-record reads such as `board target show --id ID` and `agent status --id ID` remain unpaginated.

New issue bodies and new comments are capped at 1,000 Unicode characters. Keep orchestrator comments compact and put large diagnostics, reviews, transcripts, or generated reports in a durable artifact, then link or name that artifact from the comment instead of pasting it into the board. Historical oversized content is still returned in full by single-record reads.

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

The canonical board queue is the operator priority order. Dispatch open
issues in queue order whenever useful isolated work can run concurrently.
Do not block independent higher-priority fronts behind a compulsory
cross-project breadth barrier. Distinct tasks should get distinct worktrees,
without worker-count quotas, ceilings or resource-awareness.

The scheduler snapshot includes all open issues, not a six-per-project limit.
Agents on closed issues are orphaned ownership, not valid representation of
open work. Before launch read the issue state, body and recent comments;
the atomic launcher must independently reject closed issues.

If a worthwhile issue has no registered worktree, invoke
antonina-scheduler-provision --issue N --json to create a separate Git
worktree and register it, then dispatch. If the trusted repository root is
unknown, record the concrete blocker rather than silently skipping the issue.

Preserve uncommitted work and transfer its resource dependency to an open
handoff issue before stopping old agents or collecting old directories.
After one successful launch, return so the supervised loop can immediately
start another turn with fresh state. Launch independent work whenever marginal
speedup is positive; do not examine CPU/RAM or other runtime capacity.

## Release-branch authority

When the target repository instructions designate an active release or integration branch, treat that branch as agent-owned unless those instructions explicitly say otherwise. After required implementation, validation, and review, the orchestrator must integrate the work into that branch and push the resulting branch state to its remote. Do not invent a human approval step between a reviewed issue branch and its release branch.

A pull request can be used as a review mechanism when tooling and credentials are available, but it is not itself an authority boundary. Missing GitHub PR/API credentials do not make release integration human-only when normal Git credentials can merge and push the designated release branch.

A repository may reserve promotion from its release branch into its default branch for a human. That restriction applies only to the default-branch promotion; never reinterpret it as a prohibition on agents merging or pushing the release branch itself.

Do not manufacture work merely to stay busy.

## Actionability

An issue is actionable when there is a concrete next action an Antonina agent can perform now, or a bounded coordination action the orchestrator can perform to delegate or reconcile that work.

Treat judgment already delegated by the issue as actionable work, not as a blocker. When an issue gives goals, constraints, examples, or a quality bar and asks the worker to choose, prefer, diversify, review, improve, or otherwise exercise judgment, make a reasonable choice within those bounds. A research or audit result should normally feed the next implementation or review step; do not invent a human approval gate, numerical quota, editorial target, or other decision the issue did not require.

Before classifying an issue as blocked or abandoned, inspect objective state when possible. A stale-looking comment is weaker evidence than a live agent, existing worktree, updated branch, open review, completed job, or other inspectable artifact.

If a blocker has cleared, resume the issue rather than leaving the stale blocker comment authoritative. Append a new status comment describing the new state.

## Claims and concurrency

Board comments are append-only coordination records, not locks.

Before starting new substantive work on an unowned issue:

1. read the issue;
2. append a `working` orchestrator comment;
3. immediately read the issue again;
4. if a later conflicting `working` claim from another orchestrator now exists, yield before launching duplicate work.

A `working` claim must declare the resources this work is taking ownership of or reserving in its `resources:` field. Before launch, name the concrete path/worktree or other reservation already chosen; after launch, append a fresh status comment with the real agent IDs/names and any other resources that became concrete.

After a claim survives that reread, perform the concrete launch promptly. Do not spend the rest of the pass scouting while an admitted issue exists only as a promise to create a worktree or agent later. Once the agent is launched, append its real ID and worktree before relying on it for handoff. If execution cannot actually be launched this pass, record the issue as `handoff` or `blocked` rather than leaving a misleading execution claim.

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
artifacts: <durable outputs such as branches, commits, PRs, jobs, or "none">
resources: <resources currently owned/reserved by this work, or "none">
validation: <relevant checks already established, or "pending">
next: <single concrete next action, or "none">
```

The `resources:` field is required in every orchestrator status comment. It is a concise collision-avoidance and handoff declaration, not a rigid taxonomy. The orchestrator should name the resources that matter for concurrent work, choosing the useful level of detail for the task.

For `working` comments, include at minimum:

- the exact working directory or worktree being used or reserved;
- every agent ID/name or other subordinate-worker handle currently being used for the issue;
- any shared or exclusive dependency that another worker could collide with or must deliberately share, such as a branch/checkout, deployment slot, long-lived service, test environment, database namespace, device, or other scarce mutable state.

Use `resources: none` only when the work genuinely owns or reserves nothing relevant. When the resource set materially changes — for example an agent is launched, a worktree changes, or a shared dependency is released — append a new status comment with the current resource declaration.

This comment-level declaration does not replace Antonina's durable host-resource registry. A durable host path that needs board-level protection or handoff must still be registered through `antonina board resource ...`; the status comment should identify it as part of the work's current resource set as well.

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
antonina agent list --page 1
antonina agent status --id ID
antonina agent log --id ID
antonina agent run --id ID --cwd /absolute/worktree --prompt '...' --detach
antonina agent new --id ID --cwd /absolute/worktree
```

Always declare `--cwd` on `run`, on every run. A front's working directory is the one named there, never the directory the orchestrator happened to run the command from. `--cwd` is run-scoped: it names the directory *that invocation* runs in, and it is accepted on a live front too. A steer **kills the current invocation and starts the next one in the same conversation**, so `agent run --steer --cwd PATH` relocates live work into `PATH`; a steer without `--cwd` continues in the directory the previous invocation ran in. Never steer with a `--cwd` you have not checked, because that is how live work silently changes directory.

**The move is permanent.** Any accepted `--cwd` — on `new`, on `run`, or on a steer — also rewrites that agent's declared default, and the default is what every later invocation inherits when it names no directory of its own. So one unchecked `--cwd` relocates *every* subsequent run of that agent: the next one, the one an hour from now, and the one a different orchestrator issues tomorrow who never ran the command that moved it. This is true for a long-lived, shared board front. Before you name a directory, decide that you mean it for the whole life of the agent, not just for this invocation.

Two reported facts, not one: `cwd` is the declared default and `invocation_cwd` (`ran in:` in human `agent status`) is the directory the current or most recent invocation launched in. Neither is an observation of where the front has since worked: to learn that, read `agent log`. An agent created without `--cwd` has no working directory and `run` refuses to launch it, so declare one at launch.

Launch newly delegated work with `--detach`; do not keep the orchestrator attached to a subordinate agent while it works.

Record a new agent ID/name and its worktree in the issue comment's `resources:` field before relying on them for handoff. Use separate worktrees for materially independent repository work.

### Parallelism follows the work topology

Maximize useful parallel progress across the board. The generic orchestrator is a **topology-only scheduler**. Its decision procedure is based only on the topology of the available work: dependencies, ownership, write-surface overlap, branch/worktree collisions, reconciliation structure, and explicit project/issue workflow constraints. It has no fixed worker target, floor, or ceiling.

Never encode project-, repository-, issue-, branch-, theorem-, or domain-specific quotas or requirements in this generic skill. Read such constraints from the issue's recent comments, registered resources, and the project's own AGENTS.md or other project documentation, and apply them only to that work.

Before deciding ownership or concurrency for an issue, perform a **project-policy preflight**: read the issue body and at least its most recent comment page, identify the relevant project/worktree from registered resources, and read the nearest project AGENTS.md plus any project orchestration document it directly points to. The absence of a quota, fence, or workflow rule from this generic skill is never evidence that the project has no such local rule. If a recent board comment conflicts with current project documentation, record the discrepancy and follow the current project-owned instruction unless a newer explicit user instruction overrides it.

Every pass has a **frontier-first phase** before deep archaeology. Inspect the live-agent set and enough of the queue prefix to identify independent actionable work. For each candidate, understand the issue well enough to define a non-overlapping packet — including reading its recent comments — but do not spend most of the pass reconstructing deep history while clearly safe useful fronts remain unowned. Once a packet is clear, delegate deep branch archaeology, proof search, review, or implementation to that worker and continue filling the frontier.

For each orchestration pass:

1. Harvest terminal agents and incorporate their durable results before deciding what is still open.
2. Sweep enough of the queue to discover independent actionable fronts instead of serializing unrelated work behind the first issue.
3. For every distinct front, ask only whether topology permits useful independent execution now: is it unblocked, sufficiently understood, non-duplicative, and isolated from conflicting ownership/write surfaces? If yes, launch it.
4. Ignore runtime capacity completely. Topology alone determines whether a front is launchable.
5. Preparing a worktree, branch, registered path, prompt, or handoff is not delegation. If a front is ready to run, complete agent new / agent run --detach in the same pass and verify the resulting live handle. Do not end a pass with next: launch for work that is already prepared and unblocked.
6. After harvesting completed or failed agents, refill newly exposed useful work in the same pass. Avoid batch behavior in which a pool drains to zero and waits for a later invocation.
7. Before ending the pass, every actionable front you identified should either have a live owner or have a precise recorded topological blocker/dependency/collision reason.

Give every newly delegated agent a descriptive title and an explicit working directory so later passes can identify ownership reliably.

Coordination comments are control-plane records, not essays. Keep them comfortably within the board comment limit; put detailed evidence in durable artifacts and name those artifacts from the comment. If a comment is too long, shorten it rather than spending orchestration time repeatedly reformatting prose. Comment formatting must never delay launching an otherwise ready front.

Do not wait idly for long-running agents. Inspect what is available now, steer if useful, record durable state when it materially changes, and continue launching other independent useful work during the same pass. A later orchestrator pass should be needed because the remaining work genuinely depends on future results, not because ready delegation was deferred.

## Progress, blockers, and handoff

A handoff comment should let a fresh orchestrator continue without reconstructing the entire history. State:

- what was actually accomplished;
- the current durable artifact to inspect;
- what remains;
- the next concrete action;
- any blocker that prevents that action.

Prefer factual state such as a branch name, commit, PR, test result, agent ID, or host path over prose about effort.

A blocked issue stays open. Name the blocker precisely and, when possible, the event that would clear it. When a queue scan newly discovers a blocker, append that fact on the blocked issue itself; mentioning it only in another issue's comment does not count as recording the blocker. Once the blocker is recorded, continue with the next actionable queued issue rather than repeatedly rediscovering the same block.

Do not create a follow-up issue for work that is merely the unfinished remainder of the current issue. Create a new issue only when it is a distinct durable task that deserves independent priority, lifecycle, or ownership.

## Durable coordination paths

When work depends on a durable host path, follow [resources.md](resources.md). Treat registered paths only as coordination/ownership metadata: they may reveal topology such as shared write surfaces or handoff dependencies, but they are never capacity or load signals.

Register and verify the dependency before relying on the path for handoff. When moving a path dependency to a follow-up issue, add and verify the new dependency before removing the old one or closing the old issue.

Never inspect or infer host capacity from the resource registry, and never perform resource collection merely as part of routine orchestration.

## Completion

Do not equate "agent stopped", "tests passed", "PR opened", or "code written" with issue completion.

Derive the completion predicate from the issue plus the target repository's instructions. It normally includes the requested result, required validation, required review/integration state, and absence of unresolved blockers.

Record a review verdict on the board when a review of the issue's work has concluded, with `antonina board review --id NUMBER --verdict request-changes|approve --rationale TEXT [--commit SHA] [--reviewer NAME]`. The verdict names the exact commit it is about, because it is what a later read compares against, and that commit must be the full 40-character lowercase object id: an abbreviation, a digest in another case, or a branch name is refused as malformed at record time rather than stored as some other commit. A `request-changes` verdict is a blocker: it stops the issue from being closed, and the refusal names the blocker. It can only be cleared by an approval naming a commit no `request-changes` on that issue has named, since a fix is a new commit and a re-reading of the same one is not a fix; the board keeps every commit a block named, so no ordering of approvals and re-blocks can launder one out. A block that named no commit is cleared by the first approval that names one. An approval that itself names no commit clears nothing and is refused while a block is outstanding. An issue with no recorded verdict is not blocked, which is a different statement from being approved.

Before closing an issue:

1. reconcile the claimed result with objective repository/execution state;
2. make any required resource handoff safe;
3. append a `completed` comment naming the result and validation;
4. close the issue with `antonina board close --id NUMBER`;
5. verify that the issue is closed and no longer appears in the queue.

Use `handoff` for a human-only action only when the remaining action genuinely cannot be delegated — for example, the issue explicitly reserves the decision to a human, required credentials or permissions for every permitted completion path are unavailable to agents, a physical/third-party action is required, or a material ambiguity has no governing criteria. Missing credentials for an optional mechanism such as creating a GitHub pull request do not qualify when the required repository state can still be reached through ordinary Git integration and push. Name the exact human action and why an agent cannot perform it. If you cannot name such a reason, continue the issue instead of inventing an approval step.

## Failure behavior

A failed command is not progress. Diagnose failures from objective state and avoid writing optimistic comments.

If one issue is blocked by an external service, unavailable host, review dependency, or other recoverable condition, record the blocker once and continue with other actionable queue work.

If board trust, write access, or board availability itself is broken, stop board-mutating work rather than creating untracked state elsewhere.

Never put secrets in issue bodies, comments, branch names, logs quoted into comments, or command examples recorded on the board.

## Minimal command reference

```sh
# inspect
antonina board access --json
antonina board queue list --page 1 --json
antonina board list --state open --page 1 --json
antonina board show --id NUMBER --page 1 --json

# append coordination state
antonina board comment --id NUMBER --body BODY
antonina board comment --id NUMBER --body BODY --author NAME

# issue lifecycle
antonina board create --title TITLE --body BODY
antonina board review --id NUMBER --verdict VERDICT --rationale TEXT --commit SHA
antonina board close --id NUMBER
antonina board reopen --id NUMBER

# shared priority, only when priority really changed
antonina board queue reorder --id N1 --id N2 --id N3

# durable resource dependencies
antonina board resource list --issue NUMBER --page 1
antonina board resource add --issue NUMBER --host HOST --path PATH
antonina board resource remove --issue NUMBER --host HOST --path PATH
```

The board is the durable coordination memory. Keep it concise, factual, append-only, and sufficient for the next fresh pass.
