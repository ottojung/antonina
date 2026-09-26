# Antonina

Antonina manages long-running local AI coding-agent sessions through a small command-line interface. It also provides the Antonina board, a shared issue and durable-resource registry backed by Skrynia.

Antonina uses TypeScript/Node.js for its CLI, managed-agent runtime, shared board core, and web application. OpenCode remains an external executable.

## Requirements

- Node.js 22 or later
- `opencode` available on `PATH`

Normal execution uses precompiled JavaScript. A TypeScript compiler is only a development/build dependency.

## Install

Build and pack the CLI from a development checkout:

```sh
npm run bootstrap
npm run typecheck
npm run pack:cli
npm install -g ./antonina-cli-*.tgz
```

This installs the `antonina` executable. Release artifacts should ship the already-built package, so execution hosts do not compile TypeScript.

## Basic usage

```sh
antonina agent new --id a13f09c2 --cwd /workspace/project
antonina agent prompt --id a13f09c2 'Investigate the issue and implement the fix.'
antonina agent status --id a13f09c2
antonina agent log --id a13f09c2
antonina agent wait --id a13f09c2 --timeout 3600
```

Lifecycle controls are available through `stop`, `kill`, `delete`, and `clean`. The board is available as `antonina board`; set `ANTONINA_BOARD_CAPABILITY` for writes.

State is stored under `$XDG_STATE_HOME/antonina`, defaulting to `$HOME/.local/state/antonina`.

## Web board

The web board is under `web/` and imports the shared board/Skrynia implementation from `packages/core`.

```sh
cd web
npm ci
npm test
npm run build
```

## Development

```sh
npm run bootstrap
npm run typecheck
npm test
npm run build
```

The repository contains one supported Antonina runtime: the precompiled TypeScript/Node.js implementation described above.

## License

Antonina is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).
