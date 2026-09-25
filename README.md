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
antonina new --id a13f09c2 --cwd /workspace/project
antonina prompt --id a13f09c2 'Investigate the issue and implement the fix.'
antonina status --id a13f09c2
antonina log --id a13f09c2
antonina wait --id a13f09c2
```

Lifecycle controls are available through `stop`, `kill`, `delete`, and `clean`. Use `antonina --help` or `antonina <command> --help` for the complete CLI.

State is stored under `$XDG_STATE_HOME/antonina`, defaulting to `$HOME/.local/state/antonina`.

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
