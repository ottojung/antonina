# Antonina

Antonina is a local command-line manager for durable, long-running OpenCode agent sessions. It provides stable agent IDs, crash-durable lifecycle metadata, append-only logs, attached or detached prompts, and exact process-group control for steering, stopping, and cleanup.

## Requirements

- Linux with a readable `/proc` filesystem and process-signaling support
- Python 3.12 or later
- [`uv`](https://docs.astral.sh/uv/) for the recommended installation and development workflow
- `opencode` on `PATH`, configured for the `opencode/space-bunny-free` model

OpenCode is Antonina's current execution backend. It is an external subprocess, not a Python package dependency; Antonina's own runtime imports only the standard library and Antonina modules.

## Installation

From a checkout:

```sh
uv tool install .
antonina --help
```

Standard `python -m pip install .` installation is also supported.

## Quick start

```sh
antonina new --id a13f09c2 --cwd /path/to/project
antonina prompt --id a13f09c2 'Investigate the issue and implement the fix.'
antonina status --id a13f09c2
```

`new` creates an idle record; it does not start a backend invocation. `prompt` follows the invocation and streams output by default. Add `--detach` to return after the work is durably reserved.

Common lifecycle commands:

- `antonina list` lists local agents and filters by lifecycle state.
- `antonina status --id ID` reports observed state and metadata.
- `antonina log --id ID [--follow]` reads or follows output.
- `antonina wait --id ID --timeout SECONDS` waits and maps the agent result to an exit code.
- `antonina prompt --id ID --steer TEXT` interrupts active work and queues a replacement instruction.
- `antonina stop --id ID` requests termination; `antonina kill --id ID` forces convergence.
- `antonina delete --id ID` removes state after process ownership is safe.
- `antonina clean [--days N] [--dry-run]` removes old terminal records.

Run `antonina COMMAND --help` for command-specific options.

## State

Antonina stores lifecycle data under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/antonina
```

Each agent has a directory under `agents/<id>/` containing durable metadata, output, lock files, and temporary files used by atomic state updates. Uninstalling the Python package does not remove this state.

## Development

```sh
uv sync --frozen --extra dev
uv run ruff format --check .
uv run ruff check .
uv run mypy .
uv run pytest
```

Tests must use pytest-owned temporary XDG directories and must never read or mutate ambient user state. Development dependencies are isolated in the `dev` extra; `project.dependencies` remains empty.

## License

Antonina is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [`LICENSE`](LICENSE).
