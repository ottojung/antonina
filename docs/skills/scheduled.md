# Scheduled Antonina agent work

This document is the reusable operating guide for a recurring ChatGPT invocation that uses Antonina's optional agent runtime. It defines ownership, recovery, liveness, and completion for agentic work. The calling project itinerary supplies the target repository, work-selection policy, branch policy, and completion predicate.

## Contract

Keep these resources distinct:

- **Antonina** — the standalone agent runtime and its durable agent state.
- **Target repository** — the repository, issues, branches, pull requests, and validation requirements selected by the itinerary.

Every scheduled invocation is disposable. Durable issue status, agent metadata, logs, and repository state are the sources of truth; conversation memory is only context.

## Startup

1. Read the project itinerary and this document.
2. Identify the concrete work item.
3. Read the canonical issue status comment before claiming work.
4. Claim only work that is not actively owned; recover abandoned work according to the issue's timestamp and owner.
5. Use a preassigned base-16 agent ID and an explicit target worktree cwd.
6. Continue until the itinerary's completion condition is verified; do not silently stop with an outstanding agent.

## Issue ownership

For issue-tracked work, maintain one marked status comment. Record the state (`working` or `completed`), a fresh owner ID, and concrete resources such as agent IDs, worktrees, branches, pull requests, and job handles. Update the comment at least every five minutes while working, re-reading it before each update and yielding if another owner has taken over.

Treat work as abandoned for coordination purposes only after its marked comment has been unchanged for ten minutes. On inheritance, replace the owner, re-read the comment, inspect the referenced agent and repository state, and continue from objective state. Do not put credentials or secret values in the comment.

## Agent operation

Use Antonina for work requiring judgment, context, iteration, or multiple steps. Use direct shell only for tiny deterministic observations. Record the agent ID before invocation, retain durable logs, and poll or inspect status and logs while work is nonterminal. Never treat a progress message or green test as completion by itself.

For work that creates or relies on durable host filesystem paths, read and follow [`resources.md`](resources.md). Register paths before relying on them across work and hand off dependencies before closing the last open Borys issue.

## Completion

Define the completion predicate from the calling itinerary. It must include the requested repository result, required validation, review expectations, and no unresolved blockers. Mark the issue completed only after those conditions are objectively verified.
