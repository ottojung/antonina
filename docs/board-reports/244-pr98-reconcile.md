# Board 244: reconcile PR #98 against main

PR #98 (`release/2026-09-27-5`) was `dirty`: a real `git merge` against
`main` (50fdc13) conflicted in 39 files. This is the reconciliation that
landed on `release/2026-09-27-5`.

## Method

A real `git merge --no-commit --no-ff origin/main` was run in an isolated
clone of `ottojung/antonina` based on the release tip. The 39 conflicts
were resolved as a union of both lines where they do not contradict, and
toward the approved release-line intent where they do. The result was
typechecked, tested and built before it was pushed.

## Preserved behavior

- **LongCat 2.5 Preview Free, `--variant low`** is the sole managed-agent
  and scheduler model: `config/opencode-openclaw.json`,
  `packages/agent-runtime/src/backend.ts` (`AGENT_MODEL`),
  `packages/agent-runtime/src/metadata.ts` (`DEFAULT_VARIANT`),
  `packages/cli/src/agent.ts`, `scripts/antonina-orchestrator-turn`,
  `README.md`, `docs/openclaw-host-deployment.md`, and the intent records.
- **Topology-only full-frontier scheduler**: the scheduler does not
  provision worktrees or choose a `--cwd`; the agent owns repository and
  filesystem setup; the launcher revalidates board openness and live
  ownership. `skills/antonina-scheduler/SKILL.md`,
  `skills/antonina-orchestrator/SKILL.md`, `docs/skills/orchestrator.md`,
  `scripts/antonina-scheduler-launch`, `scripts/antonina-scheduler-snapshot`
  and `scripts/antonina-orchestrator-turn`.
- **Runner cwd and session ownership**: worktree-scoped OpenCode session
  discovery (`discoverSessionId(..., cwd)`), the per-invocation owner-token
  claim, and the launch-directory refusal with its displayable status note.
- **Board migrations**: `board-v3-store` keeps the closing-time closed
  order (board 179) and the last-activity All Issues order (board 180);
  `MAX_ISSUE_BODY_CHARACTERS` / `MAX_COMMENT_BODY_CHARACTERS` are 10,000.

## Superseded main-only material removed

The main-only worktree/breadth-barrier/Step 5 scheduler and its tests
(`scheduler-launch`, `scheduler-worktrees`, `scheduler-snapshot`,
`scheduler-running-inventory`, `orchestrator-turn`, `openclaw-config`,
`opencode-db-isolation`), the duplicate `docs/skills/scheduler.md`, and the
duplicate `DEFAULT_VARIANT = 'high'` are removed or reverted: the approved
release line replaced them.

## Gates on the reconciled result

Run in the isolated clone, on the reconciled tree:

| gate | command | exit |
| --- | --- | --- |
| typecheck | `npm run typecheck` | 0 |
| tests | `npm test` (core, runtime, daemon, cli, web, workflow, build-identity) | 0 |
| build | `npm run build` | 0 |

`npm test` also passed under Node 22.14.0 and under a single pinned CPU.
