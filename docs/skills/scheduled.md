# Scheduled Antonina agent work

This document is the reusable operating guide for recurring agents that work on Antonina-managed repositories. It defines ownership, recovery, liveness, and completion for agentic work. The calling project itinerary supplies the target repository, work-selection policy, branch policy, and completion predicate.

## Contract

Keep these resources distinct:

- **Antonina** — the preferred coding-agent runtime used to perform substantive repository work. Antonina is a capable agent and should be used for work that benefits from judgment, context, iteration, or multiple steps.
- **Coordinating agent** — the agent following this document. It selects work, launches subprocesses, observes progress, and keeps the overall loop moving.
- **Target repository** — the repository, issues, branches, pull requests, and validation requirements selected by the itinerary.

The coordinating agent should use Antonina by launching `antonina agent ...` commands as subprocesses. The coordinating agent coordinates; Antonina agents do the substantive agentic work. Do not replace Antonina with ad-hoc direct model calls when an Antonina agent is appropriate.

Every invocation or turn of the coordinating agent is disposable. Durable issue status, Antonina agent state and logs, repository state, and other explicit host state are the sources of truth; conversation memory is only context.

## Startup

1. Read the project itinerary and this document.
2. Identify the concrete work item.
3. Read the canonical issue status comment before claiming work.
4. Claim only work that is not actively owned; recover abandoned work according to the issue's timestamp and owner.
5. Use a preassigned base-16 Antonina agent ID and an explicit target worktree cwd.
6. Launch and control Antonina agents through subprocesses.
7. Continue until the itinerary's completion condition is verified; do not silently stop with an outstanding agent.

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
antonina agent wait --id <agent-id> --timeout <seconds>
```

Use direct shell only for tiny deterministic observations or coordination glue. Record the Antonina agent ID before invocation, retain durable logs, and poll or inspect status and logs while work is nonterminal. Never treat a progress message or green test as completion by itself.

Before relying on a durable host path, follow [resources.md](resources.md): register it with `antonina board resource add`, verify it, and preserve open dependencies until handoff or completion.

## Completion

Define the completion predicate from the calling itinerary. It must include the requested repository result, required validation, review expectations, and no unresolved blockers. Mark the issue completed only after those conditions are objectively verified.
