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

### OpenClaw orchestrator skill

The OpenClaw skill used by Antonina hosts is versioned in this repository at `skills/antonina-orchestrator/`. Deploy that directory as a unit so the skill and its companion resource instructions stay on the same revision as the CLI:

```sh
mkdir -p "$HOME/.openclaw/skills"
rm -rf "$HOME/.openclaw/skills/antonina-orchestrator"
cp -a skills/antonina-orchestrator "$HOME/.openclaw/skills/"
```

The versioned skill is mechanically checked against `docs/skills/orchestrator.md` and `docs/skills/resources.md` in CI so the human-readable documentation and installed OpenClaw skill cannot silently drift.

## Board

The Antonina board stores issues and durable resources in Skrynia as a signed operation log under `antonina/board-v2`. The CLI is available as `antonina board`. Command and subcommand words are positional, but every data argument is an explicit named option: for example, `antonina board show --id 12`, `antonina board create --title "Fix it" --body "Details"`, and `antonina board comment --id 12 --body "Done"`. Every public command and subcommand supports `-h` and `--help`. It reads its trust anchor from `$XDG_CONFIG_HOME/antonina/trust.json` and its credential from `$XDG_CONFIG_HOME/antonina/credential.json`, falling back to `$HOME/.config/antonina` when `XDG_CONFIG_HOME` is unset. Those two files are the only source: there is no environment override for either, so a fresh shell needs nothing exported. Unrelated settings — `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_HEAD`, `ANTONINA_BOARD_AUTHOR` — remain environment variables.

Reading the board never creates it. Creation is deliberate and has a single path, `BoardApi.initialize()`, reached either from the web board's first-run **Initialize board** action or from `antonina board initialize`; there is no second or fallback creation path, and a second initializer is refused with a non-zero exit instead of taking the trust root. The initializer keeps the board's root signing credential and its public trust anchor, both copyable from the web board's Settings; share the anchor with readers and the credential with editors.

`antonina board initialize` creates the board and prints both values for a human: the trust anchor under `Trust anchor (public):` and the root credential under `Root credential (secret; store securely):`. Run it once and save each printed value into its own file:

```sh
config="${XDG_CONFIG_HOME:-$HOME/.config}/antonina"
mkdir -p "$config" && chmod 700 "$config"
antonina board initialize     # copy the anchor into trust.json, the credential into credential.json
chmod 600 "$config/"*.json
```

Initialization is single-use, so this is a one-time setup: a second `initialize` is refused with a non-zero exit and prints nothing. A script that must not involve copying values by hand can capture both from that one run and split them:

```sh
config="${XDG_CONFIG_HOME:-$HOME/.config}/antonina"
mkdir -p "$config" && chmod 700 "$config"
initialized=$(antonina board initialize --json)
jq -r .trustAnchor <<<"$initialized" > "$config/trust.json"
jq -r .credential  <<<"$initialized" > "$config/credential.json"
chmod 600 "$config/"*.json
```

`--credential` and `--trust-anchor` exist for the cases where you already hold the other value from somewhere else and want exactly one serialized value on stdout; each is a separate invocation of `initialize`, so neither is a second step after initializing.

`credential.json` holds a private key, so the directory is not readable by other users. A file that is present but unparseable is reported by path with a non-zero exit rather than ignored; a file that is absent simply configures nothing, so a reader needs only `trust.json` and an editor needs only `credential.json`.

`antonina board credential delegate --capability CAPABILITY` mints attenuated credentials; repeat `--capability` to delegate more than one.

The board's issue queue is durable shared state, not a browser-local sort. The queue is exactly the set of currently open issues, each once: creating an issue appends it, closing or deleting one removes it, and reopening one adds it back. `antonina board queue list` prints that order as `#1 #3 #2`, or as a bare JSON array with `--json`. `antonina board queue reorder --id 3 --id 1 --id 2` replaces the whole order with a permutation of the open issues; it is rejected, without writing anything, if the list is partial, repeats an issue, or names a closed or unknown issue. Both commands need only the board's trust anchor to read, and reordering additionally needs a credential holding the `queue.reorder` capability, which `antonina board credential delegate --capability queue.reorder` can mint.

`antonina board feed` is the board's chronological activity stream: one line per recorded operation, newest first, in the order the signed log committed them. Every line is a real event the log recorded — `created`, `edited`, `commented by <author>`, `closed`, `reopened`, `deleted` — so an edit, a comment, a closure and a reopen are four distinguishable lines rather than one "last changed" line. `--json` emits the same page as a machine-readable object. The page holds 50 entries by default, `--limit N` changes that (up to 500), and when a board is longer than one page a `next: <token>` line is printed; pass that token back as `--cursor <token>` for the entries after it. Paging is lossless across operations that share a timestamp. Like `queue list`, the feed needs only the board's trust anchor to read and never writes.

A credential's Skrynia storage capability can go stale: setup accepts it, the first real mutation is refused, and that client then stays read-only until it is given a freshly copied credential.

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
antonina agent run --id a13f09c2 --prompt 'Investigate the issue and implement the fix.'
antonina agent status --id a13f09c2
antonina agent log --id a13f09c2
antonina agent wait --id a13f09c2 --timeout 3600
```

Lifecycle controls are available through `stop`, `kill`, `delete`, and `clean`. Local runtime state is stored under `$XDG_STATE_HOME/antonina`, defaulting to `$HOME/.local/state/antonina`. That is a different tree from the board configuration above: `clean` sweeps runtime state and never touches your board trust anchor or credential.

## Host daemon

A persistent hardware host can run a long-lived Antonina daemon. It keeps a stable identity for the host, publishes a heartbeat and host telemetry -- memory, filesystem and workspace capacity, CPU count, load, uptime -- and stops there: it is a host-local observer, not a second transport to a host. Lubko remains the transport for a Lubko-managed host, and the daemon never executes a command.

```sh
antonina daemon identity          # the stable name this host answers to
antonina daemon start             # publish heartbeats until signalled
antonina daemon status [--json]   # the last report, and whether it is fresh
```

`start` runs in the foreground on purpose: a host's most persistent process should be the one a supervisor already knows how to restart, not a detached process with no exit status. Run it from a systemd unit, a launchd plist, or whatever your host already uses.

The host is named by `hostId` in `$XDG_CONFIG_HOME/antonina/daemon.json` when you set one, and otherwise from a machine fact -- `/etc/machine-id`, else `/var/lib/dbus/machine-id`, else the hostname -- recorded once under `$XDG_STATE_HOME/antonina/daemon`. That record is what keeps a host the same host after a reinstall, a clone or a rename. No process name is ever consulted.

`daemon.json` also configures which paths are reported and how fresh a report has to be:

```json
{
  "hostId": "phoebe-dev",
  "workspaces": ["/workspace/project-worktree"],
  "heartbeatIntervalMs": 30000,
  "staleAfterMs": 180000
}
```

A report is read, never written, through `BoardApi.daemonHosts(reports, { nowMs })`, which joins host reports with the execution-target catalog and reports each host as `online`, `stale` or `offline`. It requires no board credential and appends nothing to the signed board.

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
