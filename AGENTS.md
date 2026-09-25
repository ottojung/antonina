# Antonina repository guide

## What Antonina is

Antonina is a local CLI manager for durable, long-running OpenCode agent sessions. It owns stable agent IDs, lifecycle metadata, output logs, prompt delivery, steering, termination, cleanup, and exact process-group convergence. OpenCode is an external backend subprocess; the current managed model is `opencode/space-bunny-free`.

## Architecture

- `src/antonina/agent.py` defines the CLI, metadata schema, runner, prompt/steer dispatch, observation, and lifecycle control.
- `src/antonina/durable.py` provides crash-durable atomic state updates and same-path serialization.
- `src/antonina/_exact_signal.py` provides pidfd-based signalling and `/proc` process identity.
- `src/antonina/_process_group.py` checks exact process-group membership.
- `tests/` contains lifecycle, recovery, metadata, backend-error, and real subprocess tests.
- `docs/intent-records/` and `docs/adr-*.md` record durable product and safety decisions.

## Non-negotiable constraints

- `project.dependencies` must remain exactly `[]`; runtime modules may import only the standard library and Antonina modules.
- Do not add third-party runtime packages, compatibility aliases for old names, or implicit backend state.
- State and process authority are safety boundaries. Persist intent before irreversible actions, use exact process identity, fail closed when ownership is ambiguous, and converge owned processes before cleanup.
- Runtime state belongs under `$XDG_STATE_HOME/antonina` or `$HOME/.local/state/antonina`. Never point local experiments or tests at ambient production-like state.
- Every test must isolate `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `HOME`, and Antonina control variables in pytest-owned temporary paths. Tests that spawn processes must own and converge them.

## Development workflow

Use `uv` and Python 3.12 or later. Keep `uv.lock` synchronized after dependency changes.

```sh
uv sync --frozen --extra dev
uv run ruff format --check .
uv run ruff check .
uv run mypy .
uv run pytest
```

Before committing, search tracked files for stale product names, inspect `git diff --check`, and review `git status` plus the complete diff for generated artifacts. Keep runtime, tests, docs, and tooling changes scoped to the requested behavior.
