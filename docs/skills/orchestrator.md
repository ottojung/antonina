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

Do useful orchestration work and then return. Do not keep an invocation alive merely to wait for a long-running agent or external event. A later invocation should be able to reconstruct the state from the board and the durable artifacts named there.

## Delegation boundary

The orchestrator is a coordinator, never an implementation worker. It must not implement issue work itself.

All substantive repository work must be delegated to Antonina agents. This includes source, test, documentation, configuration, migration, or generated-file edits; committing; merging or rebasing; cherry-picking; pushing repository refs; release integration; deployments; and substantial build/test/validation work. Independent review, verification, research, and integration are agent roles too: launch or steer an agent for them instead of doing them in the orchestrator process.

The orchestrator may perform bounded coordination operations needed to delegate safely: inspect board and agent state; inspect repository metadata and small diffs read-only; fetch refs; inspect host resources; create or register worktrees/branches as agent reservations; write board comments; launch, steer, stop, or harvest Antonina agents; and close/reopen/reorder board issues when the durable evidence warrants it. These coordination actions must not become a back door for implementing the issue.

Once a useful agent has been launched and its real ID/resources are durably recorded, do not remain alive to supervise it command-by-command or wait for it to finish. Continue only long enough to fill other clearly safe frontier slots and record coordination state, then return. A future invocation will reconcile the results.

## Board access

Use JSON output for orchestration decisions.

```sh
antonina board access --json
antonina board queue list --page 1 --json
antonina board list --state open --page 1 --json
antonina board show --id NUMBER --json
```

Collection reads never choose a page implicitly. The following commands require a 1-based `--page N`: `board queue list`, `board list`, `board feed`, `board resource list`, `board target list`, `board collect list`, and `agent list`. Page 1 is the start of each collection; for issues it contains the highest-priority open issues first. The default page size is 50. `board feed --limit N` and `agent list --limit N` change their page size without making `--page` optional.

When a pass needs more than the first page, increment the page number explicitly until enough state has been read or an empty page is reached. If the pass mutates queue membership or order while scanning — for example by closing, reopening, creating, or reordering issues — restart any priority-sensitive scan at page 1 before making further scheduling decisions. Single-record reads such as `board show --id NUMBER`, `board target show --id ID`, and `agent status --id ID` are deliberately unpaginated and return the whole record.

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

At the beginning of every pass:

1. Verify board access.
2. Read the queue plus compact agent/resource state.
3. Inspect only enough queued state, in queue order, to identify the first clearly actionable, non-conflicting front.
4. Claim and launch that front promptly; do not finish an exhaustive queue audit first.
5. Continue scanning and launching additional independent fronts, reconciling only the durable artifacts needed for each scheduling decision.
6. Build a portfolio of useful concurrent work rather than stopping after one issue.

Use a **launch-early** policy. Full issue-history or repository investigation is not a prerequisite to delegation when a safe agent can perform that investigation itself. Large append-only issue histories are especially unsuitable as serial orchestrator work: prefer compact queue/list/feed/resource/agent state for scheduling, and delegate deep history reading, code archaeology, diagnosis, review, or research to an Antonina agent. Read a full issue record in the orchestrator only when its exact content is needed to avoid a concrete ownership, safety, or scope mistake.

A live Antonina agent with a known issue/worktree is already reconciled enough for frontier accounting. Count it as occupied capacity and do not deep-read its issue, re-review its work, or supervise it before filling clearly safe empty slots. If an old handoff or stale reservation needs substantial investigation before it can resume, delegate that reconciliation to an agent (read-only when appropriate) instead of turning it into serial orchestrator work. Uncertainty about an issue's internals is a reason to launch a bounded reconnaissance/review agent when that can be done safely, not a reason to stall the whole frontier.

When enough clearly independent actionable work exists and host resources permit it, aim to establish several concurrent fronts quickly; roughly five active Antonina agents is a useful operating target, not a quota. Fill obvious empty slots before doing deep harvest, review, or recovery work on already represented fronts. Do not delay the first launch merely to prove that all later slots are also safe.

Selection proceeds in phases:

1. **Recoverable ongoing work.** Reconcile and continue every issue whose existing work can usefully continue now: a live subordinate agent to inspect or steer, a handoff with a clear next step, a branch or pull request awaiting the next local action, or interrupted work whose durable state is recoverable. Deep recovery work belongs to an agent; the orchestrator should establish ownership and launch/steer it.
2. **Breadth scan.** Scan the queue from front to back. As soon as an actionable unclaimed issue is clearly safe and useful, claim and launch it before continuing the scan. For each later issue, ask whether it is clearly safe and useful to execute concurrently with the work already admitted into this pass. Admit it when the answer is yes; otherwise defer it and keep scanning.
3. **Prefer obvious independence.** Issues from clearly unrelated projects or repositories should normally be admitted concurrently unless they share an explicit dependency, deployment target, mutable external resource, or other concrete conflict. Do not stop scanning merely because an earlier issue is already being worked on.
4. **Be conservative within one project.** When two issues appear to belong to the same project, defer additional work unless there is positive evidence that the fronts are independent. The same repository is not proof of conflict: monorepos may contain independent packages, apps, services, or subsystems that can safely progress in separate worktrees.
5. **Depth scan.** After establishing broad cross-project parallelism, revisit deferred same-project issues in queue order and admit additional work when independence is evident.
6. **Intra-issue parallelism.** For substantial issues, consider complementary agents with genuinely different roles, such as implementation, independent review, verification/testing, or focused research/design. Do not spawn duplicate agents merely to increase concurrency.
7. **No further safe work.** Stop expanding the frontier when additional work would be blocked, duplicate existing work, or rely on uncertain independence.

Queue order still expresses shared priority. The orchestrator should preserve that priority while exploiting concurrency; do not reorder the queue merely to encode scheduler state.

Useful evidence of independence includes disjoint repositories, separate monorepo packages/apps, unrelated subsystems, separate worktrees, distinct deployment targets, or clearly non-overlapping implementation areas. Potential conflict domains include the same source files, shared core APIs under active redesign, one database/schema migration path, the same mutable deployment environment, or another shared external resource.

Execution resources are also a conflict domain. Before adding new heavy workers to a host, inspect objective resource headroom when it is readily available: CPU load/run-queue pressure and active fan-out subprocesses as well as hard memory/cgroup limits and recent OOM evidence. Repeated compiler, test, mutation, validator, or build subprocesses are heavy work even when each individual child is small; separate worktrees do not make them CPU-independent.

Memory admission is host-global, not repository-local. On a cgroup-limited host, use the cgroup's own current usage, hard limit, and OOM events (for cgroup v2, `memory.current`, `memory.max`, and `memory.events`, or the platform equivalent); physical RAM outside that cgroup is not usable headroom. Admit another genuinely heavy front only when the remaining cgroup headroom covers a conservative working-set budget derived from recent observed peak usage of comparable healthy fronts plus room for the supervisor and work already running. Cross-project independence never overrides this host memory budget. If reliable peak/headroom evidence is unavailable after a memory-pressure event, serialize genuinely heavy fronts across the whole host.

Do not classify Lean itself as a heavy workload or impose a static host-usage gate such as “do not start Lean above 8 GiB/14 GiB of usage.” A normal warm incremental Lean/Lake build should reuse dependency artifacts and is expected to have a modest working set. If a Lean front unexpectedly starts rebuilding a large dependency tree such as Mathlib or fans out into many `lean` processes, treat that as a cache/build-setup fault first: stop or bound the runaway rebuild and repair the cache arrangement instead of teaching later agents that ordinary Lean requires that memory budget. Lake build traces can encode absolute source paths; copying a `.lake/build` or dependency build tree from one absolute worktree root to another is not a valid warm-cache strategy unless the cache mechanism is explicitly relocation-safe. Separately, an individual Lean elaboration can become pathological because of a particular proof computation (for example an expensive `by decide`); diagnose and isolate that theorem/tactic from observed per-process growth rather than refusing all Lean work based on ambient host memory.

On a persistent host, also serialize genuinely heavy validation/build/mutation fronts for the same repository or package unless measured CPU headroom shows that overlap is clearly safe. If a front is killed under resource pressure, an OOM event advances, or several independent fronts die in the same pressure window, do not immediately refill the vacated slots: record the host-resource blocker and keep at most one genuinely heavy front running on that host until objective measurements demonstrate that overlap is safe. If a front is observed creating runaway subprocess fan-out, fix or bound the fan-out before relaunching. Prefer sequential or explicitly bounded gate/test concurrency in delegated prompts. This is a feasibility constraint, not a fairness quota.

Heavy-front serialization is not host-wide agent serialization. One heavy or potentially heavy front must not by itself reduce the host to one or two total agents when there is ample headroom for light work. Continue filling safe slots with low-memory work such as read-only reconciliation/research/review, UI or documentation work, or ordinary code work whose prompt forbids heavy builds. If a candidate's resource class is uncertain, launch a bounded reconnaissance/implementation front that explicitly must not start a heavy build or high-fan-out validation until it has classified the cost and reported back. Apply resource limits to the expensive operation, not indiscriminately to the existence of an agent.

Development can often proceed concurrently even when integration must later serialize. Separate branches or worktrees may be safe to implement in parallel and then merge into a shared release branch one at a time.

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

Always declare `--cwd` on `run`. A front's working directory is the one declared there, never the directory the orchestrator happened to run the command from, and `agent status`/`agent list` report exactly that declared directory or an explicit `null`. A reported `cwd` is therefore the directory the front runs in, not an observation of where the front has since worked: to learn that, read `agent log`. An agent created without `--cwd` has no working directory and `run` refuses to launch it, so declare one at launch.

Launch newly delegated work with `--detach`; do not keep the orchestrator attached to a subordinate agent while it works.

Record a new agent ID/name and its worktree in the issue comment's `resources:` field before relying on them for handoff. Use separate worktrees for materially independent repository work.

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

A blocked issue stays open. Name the blocker precisely and, when possible, the event that would clear it. When a queue scan newly discovers a blocker, append that fact on the blocked issue itself; mentioning it only in another issue's comment does not count as recording the blocker. Once the blocker is recorded, continue with the next actionable queued issue rather than repeatedly rediscovering the same block.

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
4. close the issue with `antonina board close --id NUMBER`;
5. verify that the issue is closed and no longer appears in the queue.

Use `handoff` for a human-only action only when the remaining action genuinely cannot be delegated — for example, the issue explicitly reserves the decision to a human, required credentials or permissions are unavailable to agents, a physical/third-party action is required, or a material ambiguity has no governing criteria. Name the exact human action and why an agent cannot perform it. If you cannot name such a reason, continue the issue instead of inventing an approval step.

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
antonina board show --id NUMBER --json

# append coordination state
antonina board comment --id NUMBER --body BODY
antonina board comment --id NUMBER --body BODY --author NAME

# issue lifecycle
antonina board create --title TITLE --body BODY
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
