# Scheduled Antonina agent work

This document is the reusable operating guide for recurring agents that work on Antonina-managed repositories. It defines ownership, recovery, liveness, and completion for agentic work. The calling project itinerary supplies the target repository, work-selection policy, branch policy, and completion predicate.

## Contract

Keep these resources distinct:

- **Antonina** — the preferred coding-agent runtime used to perform substantive repository work. Antonina is a capable agent and should be used for work that benefits from judgment, context, iteration, or multiple steps.
- **Coordinating agent** — the agent following this document. It selects work, launches subprocesses, observes progress, and keeps the overall loop moving.
- **Target repository** — the repository, issues, branches, pull requests, and validation requirements selected by the itinerary.

The coordinating agent should use Antonina by launching `antonina agent ...` commands as subprocesses. The coordinating agent coordinates; Antonina agents do the substantive agentic work. Do not replace Antonina with ad-hoc direct model calls when an Antonina agent is appropriate.

Every invocation of the coordinating agent is disposable and should assume no useful conversational continuity from prior invocations. Durable issue status, Antonina agent state and logs, repository state, and other explicit host state are the sources of truth; conversation memory is only context.

## Coordinator pass

Treat each invocation as a fresh reconciliation pass, not as a long-lived supervisor.

Inspect durable state, existing Antonina agents, worktrees, branches, reviews, and blockers; take useful coordination actions; then exit promptly. Useful actions include claiming or recovering work, splitting work into independent fronts, starting or prompting agents, reviewing completed work, integrating validated work, and recording durable handoff state.

Do not keep the coordinating invocation alive merely to wait for long-running Antonina agents. In particular, avoid multi-minute sleeps or long `antonina agent wait` calls whose only purpose is to poll later. Leave running agents running and let the next scheduled invocation inspect them afresh. A short wait is fine when a result is expected within seconds and immediately affects the current coordination decision.

The recurring scheduler should be able to start a fresh coordinating invocation at its intended cadence. If an invocation approaches that cadence, prefer recording state and returning over continuing to supervise existing agents.

## Startup

1. Read the project itinerary and this document.
2. Identify the concrete work item.
3. Read the canonical issue status comment before claiming work.
4. Claim only work that is not actively owned; recover abandoned work according to the issue's timestamp and owner.
5. Use a preassigned base-16 Antonina agent ID and an explicit target worktree cwd.
6. Launch and control Antonina agents through subprocesses.
7. Take the useful coordination actions available in this pass, record durable state, and return without waiting for unrelated long-running work to finish.

## Issue ownership

For issue-tracked work, maintain one marked status comment. Record the state (`working` or `completed`), a fresh owner ID, and concrete resources such as agent IDs, worktrees, branches, pull requests, and job handles. Update the comment at least every five minutes while working, re-reading it before each update and yielding if another owner has taken over.

Treat work as abandoned for coordination purposes only after its marked comment has been unchanged for ten minutes. On inheritance, replace the owner, re-read the comment, inspect the referenced agent and repository state, and continue from objective state. Do not put credentials or secret values in the comment.

## Agent operation

Use Antonina for work requiring judgment, context, iteration, or multiple steps. The normal pattern is for the coordinating agent to spawn Antonina CLI subprocesses such as:

```sh
antonina agent new --id <agent-id> --cwd <worktree>
antonina agent prompt --id <agent-id> '<task>'
antonina agent status --id <agent-id>
antonina agent log --id <agent-id>
```

Exploit parallelism whenever useful. If several investigations, implementations, reviews, or other work items are materially independent, prefer running multiple Antonina agents concurrently in separate worktrees rather than serializing them without reason. Look for opportunities to split work into independent fronts, but avoid spawning agents that would merely duplicate the same work or contend on the same files.

Use direct shell only for tiny deterministic observations or coordination glue. Record the Antonina agent ID before invocation, retain durable logs, and inspect status and logs while work is nonterminal. Never treat a progress message or green test as completion by itself.

Before relying on a durable host path, follow [resources.md](resources.md): register it with `antonina board resource add`, verify it, and preserve open dependencies until handoff or completion.

## Completion

Define the completion predicate from the calling itinerary. It must include the requested repository result, required validation, review expectations, and no unresolved blockers. Mark the issue completed only after those conditions are objectively verified.

A single coordinating invocation does not need to reach that predicate. It is successful when it makes useful progress or a useful coordination decision and leaves enough durable state for a later fresh invocation to continue safely.
