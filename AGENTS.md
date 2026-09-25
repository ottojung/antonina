# Antonina contributor guidance

Antonina is a Python 3.12+ command-line runtime for long-lived local coding-agent sessions. The public executable is `antonina`; OpenCode is the current external backend.

## Architecture

- `src/antonina/agent.py` owns the CLI and managed-session lifecycle.
- `src/antonina/board.py` owns the stdlib board/resource client and `antonina board` commands.
- `web/` is the Antonina-owned Node/Vite board app; its Skrynia namespace is `antonina` and key is `board-v1`.
- `src/antonina/_exact_signal.py` and `_process_group.py` provide exact process identity/signalling primitives.
- `src/antonina/durable.py` provides crash-durable local state writes.
- Durable user state lives under `$XDG_STATE_HOME/antonina` (default `$HOME/.local/state/antonina`).
- `docs/intent-records/` records durable product constraints and `docs/skills/` contains agentic operating guidance.

## Non-negotiable constraints

- `project.dependencies` stays empty. Antonina's Python runtime uses only the standard library and its own package.
- OpenCode is an external executable, not a Python dependency.
- Process-control code must fail closed when exact ownership cannot be proven. Never replace exact PID/start-time/process-group checks with process-name matching.
- Lifecycle changes must preserve durable accepted work and deterministic stop/kill/delete/steer authority.
- Do not add compatibility aliases or legacy paths unless an issue explicitly requires them.

## Test safety

Tests must never read or mutate ambient Antonina state. The autouse test fixture redirects `XDG_STATE_HOME` to a pytest-owned temporary directory. Any test that spawns a process must own it exactly and converge/reap it before returning.

Do not run manual lifecycle experiments against a real `$XDG_STATE_HOME/antonina`. Use an explicit temporary `XDG_STATE_HOME` or a disposable environment.

## Development

Use the locked development environment:

```sh
uv sync --frozen --extra dev
uv run ruff format --check .
uv run ruff check .
uv run mypy .
uv run pytest
```

Before committing, also inspect `git diff --check` and verify that generated caches or local state are not tracked.
