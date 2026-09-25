# Antonina

Antonina manages long-running local AI coding-agent sessions through a small command-line interface. It keeps durable session metadata and logs, preserves working-directory and native-session identity, and provides explicit controls for prompting, steering, waiting, stopping, killing, deleting, and cleaning sessions.

Antonina currently uses OpenCode as its coding-agent backend. OpenCode is an external executable; Antonina itself has no third-party Python runtime dependencies.

## Requirements

- Python 3.12 or later
- `opencode` available on `PATH`

## Install

```sh
python -m pip install .
```

This installs the `antonina` executable.

## Basic usage

```sh
antonina agent new --id a13f09c2 --cwd /workspace/project
antonina agent prompt --id a13f09c2 'Investigate the issue and implement the fix.'
antonina agent status --id a13f09c2
antonina agent log --id a13f09c2
antonina agent wait --id a13f09c2
```

Lifecycle controls are available through `antonina agent stop`, `antonina agent kill`, `antonina agent delete`, and `antonina agent clean`. Antonina also owns the Borys board CLI under `antonina board`; see `antonina board --help`. Use `antonina --help` or `antonina agent --help` for agent command details.

State is stored under `$XDG_STATE_HOME/antonina`, defaulting to `$HOME/.local/state/antonina`.

## Borys board

Antonina provides the board client and CLI directly. Configure it only with `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_CAPABILITY`, and `ANTONINA_BOARD_AUTHOR`:

```sh
antonina board list --state open
antonina board create 'Implement board support' --body 'Use the v2 schema.'
antonina board resource add 1 lubko://host /workspace/project
antonina board --json
```

The board protocol remains at `borys/board-v1`; accepted and written documents use schema v2.

## Development

```sh
uv sync --frozen --extra dev
uv run ruff format --check .
uv run ruff check .
uv run mypy .
uv run pytest
```

Runtime Python dependencies must remain empty; development-only tooling belongs in the `dev` extra.

## License

Antonina is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).
