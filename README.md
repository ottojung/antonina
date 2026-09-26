# Antonina

Antonina is a coordination system for shared software work. Its core is the Antonina board, a shared issue and durable-resource registry backed by Skrynia, together with compatible hosts that can inspect the board and participate in coordinated work.

An Antonina host is a provisioned execution environment that can access the board and run whatever tools are appropriate there: human-operated commands, scripts, coding agents, or other automation. Antonina is not defined by any particular agent runtime, model provider, or coding harness.

## Current implementation

The board is available through the `antonina board` CLI and the web application under `web/`. The repository also currently contains a local managed-agent runtime built around OpenCode. That runtime is an implementation available to hosts, not the product boundary of Antonina.

## Requirements

- Python 3.12 or later for the Python CLI
- Node.js for building the web board
- `opencode` on `PATH` only for the current managed-agent commands

## Install

```sh
python -m pip install .
```

This installs the `antonina` executable.

## Board

The Antonina board stores issues and durable resources in Skrynia. Set `ANTONINA_BOARD_CAPABILITY` for writes.

```sh
antonina board --help
```

The web board is a Node/Vite app under `web/` and stores canonical schema version 2 in the `antonina` Skrynia namespace with key `board-v1`.

```sh
cd web
npm ci
npm test
npm run build
```

The deployed web app supports Issues and Resources views, issue bodies separate from comments, writable open-issue bodies, and resource dependency protection. The Python board CLI is stdlib-only and uses ETag compare-and-swap.

## Current managed-agent commands

The existing local runtime remains available while Antonina's host model evolves:

```sh
antonina new --id a13f09c2 --cwd /workspace/project
antonina prompt --id a13f09c2 'Investigate the issue and implement the fix.'
antonina status --id a13f09c2
antonina log --id a13f09c2
antonina wait --id a13f09c2
```

Lifecycle controls are available through `stop`, `kill`, `delete`, and `clean`. Local runtime state is stored under `$XDG_STATE_HOME/antonina`, defaulting to `$HOME/.local/state/antonina`.

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
