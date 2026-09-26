# Antonina

Antonina is a coordination system for shared software work. Its core is the Antonina board, a shared issue and durable-resource registry backed by Skrynia, together with compatible hosts that can inspect the board and participate in coordinated work.

An Antonina host is a provisioned execution environment that can access the board and run whatever tools are appropriate there: human-operated commands, scripts, coding agents, or other automation. Antonina is not defined by any particular agent runtime, model provider, or coding harness.

## Current implementation

Antonina uses TypeScript/Node.js for its CLI, managed-agent runtime, shared board core, and web application. The repository currently includes a local managed-agent runtime built around OpenCode. That runtime is an implementation available to hosts, not the product boundary of Antonina.

## Requirements

- Node.js 22 or later
- `opencode` on `PATH` for the current managed-agent commands

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

## Board

The Antonina board stores issues and durable resources in Skrynia as a signed operation log under `antonina/board-v2`. The CLI is available as `antonina board`; set `ANTONINA_BOARD_TRUST` to read it and `ANTONINA_BOARD_CREDENTIAL` to write to it.

The board is created deliberately, not by reading it: open the web board and use its first-run **Initialize board** action. That browser becomes the initial editor and keeps the board's root signing credential and its public trust anchor, both copyable from Settings; share the anchor with readers and the credential with editors. No CLI command and no page load creates a missing board, and a second initializer is refused instead of taking the trust root.

`antonina board initialize` prints the same trust anchor and root credential for an agent, and `antonina board credential delegate` mints attenuated credentials.

```sh
antonina board --help
```

The web board is under `web/` and imports the shared board/Skrynia implementation from `packages/core`.

```sh
cd web
npm ci
npm test
npm run build
```

## Current managed-agent commands

The current local runtime is available through the `antonina agent` namespace:

```sh
antonina agent new --id a13f09c2 --cwd /workspace/project
antonina agent prompt --id a13f09c2 'Investigate the issue and implement the fix.'
antonina agent status --id a13f09c2
antonina agent log --id a13f09c2
antonina agent wait --id a13f09c2 --timeout 3600
```

Lifecycle controls are available through `stop`, `kill`, `delete`, and `clean`. Local runtime state is stored under `$XDG_STATE_HOME/antonina`, defaulting to `$HOME/.local/state/antonina`.

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
