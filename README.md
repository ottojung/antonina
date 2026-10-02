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

The Antonina board starts as a signed operation log under `antonina/board-v2`. On the first mutation made by a v3-capable client, that verified history is materialized into sharded Skrynia objects: bounded signed-log chunks, one current issue record per issue, 50-entry issue-list pages, 50-message comment pages, feed pages, and small queue/catalog/authority records. The old `board-v2` object is kept unchanged as the migration source rather than dual-written forever. The signed operation history remains canonical; the sharded issue/list/feed objects are repairable projections used to make ordinary reads small. During this temporary storage phase board data is plaintext. Authentication is deliberately simple: the shared board key carried in existing Antonina credentials grants full access, and without that key the board cannot be read or changed. Historical capability scopes and revocations are not live authorization; an already-issued credential remains full-access. V3 object names are derived from the shared board key, while the shard objects themselves use ordinary public-write Skrynia storage.

The CLI is available as `antonina board`. Command and subcommand words are positional, but every data argument is an explicit named option: for example, `antonina board show --id 12 --page 1`, `antonina board create --title "Fix it" --body "Details"`, and `antonina board comment --id 12 --body "Done"`. Paginated reads require an explicit 1-based `--page N`; there is no implicit page 1. `board show --page 1` returns the issue description plus the newest 50 comments; higher pages walk backward through older comments, while preserving chronological order within each page. New issue bodies and new comments are limited to 1,000 Unicode characters; existing larger historical content remains readable in full. Every public command and subcommand supports `-h` and `--help`. It reads its board credential from `$XDG_CONFIG_HOME/antonina/credential.json`, falling back to `$HOME/.config/antonina` when `XDG_CONFIG_HOME` is unset. `trust.json` may still hold the public integrity anchor for compatibility and verification, but it grants no board access. Existing credential files are unchanged by the v3 migration. There is no environment override for either file, so a fresh shell needs nothing exported. Unrelated settings — `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_HEAD`, `ANTONINA_BOARD_AUTHOR` — remain environment variables.

Reading the board never creates it. Creation is deliberate and has a single path, `BoardApi.initialize()`, reached either from the web board's first-run **Initialize board** action or from `antonina board initialize`; there is no second or fallback creation path, and a second initializer is refused with a non-zero exit instead of taking the trust root. The initializer keeps the board credential and its public integrity anchor. Share the credential only with browsers or agents that should have full board access; the public anchor alone grants nothing.

`antonina board initialize` creates the board and prints the public integrity anchor plus the board credential. The credential is the only access secret. Run it once and save the credential securely:

```sh
config="${XDG_CONFIG_HOME:-$HOME/.config}/antonina"
mkdir -p "$config" && chmod 700 "$config"
antonina board initialize     # save the credential in credential.json; trust.json is optional metadata
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

`credential.json` contains the shared board key and private signing material, so the directory must not be readable by other users. A file that is present but unparseable is reported by path with a non-zero exit rather than ignored. Without a valid credential, neither reads nor writes are allowed.

The board's issue queue is durable shared state, not a browser-local sort. The queue is exactly the set of currently open issues, each once: creating an issue appends it, closing or deleting one removes it, and reopening one adds it back. `antonina board queue list --page 1` prints the first page of that order as `#1 #3 #2`, or as a bare JSON array with `--json`. `antonina board queue reorder --id 3 --id 1 --id 2` replaces the whole order with a permutation of the open issues; it is rejected, without writing anything, if the list is partial, repeats an issue, or names a closed or unknown issue. Both commands require the board credential. There is no separate queue permission or delegated role.

`antonina board feed --page N` is the board's chronological activity stream: one line per recorded operation, newest first, in the order the signed log committed them. Every line is a real event the log recorded — `created`, `edited`, `commented by <author>`, `closed`, `reopened`, `deleted` — so an edit, a comment, a closure and a reopen are four distinguishable lines rather than one "last changed" line. `--json` emits the same numbered page as a machine-readable object. The page holds 50 entries by default and `--limit N` changes the page size (up to 500). The CLI intentionally exposes numbered pages rather than feed cursors: start with `--page 1`, then increment the page number when more history is needed. Paging is lossless across operations that share a timestamp. Like every other board read, the feed requires the board credential and never writes.

The board uses one shared board key carried by its existing credentials. Before migration, the legacy `board-v2` Skrynia capability proves possession of that key. After migration, the same secret derives the v3 shard names. A wrong board key cannot locate the shards and cannot fall back to the frozen v2 snapshot after migration. There is no second authentication mechanism.

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
antonina agent run --id a13f09c2 --cwd /workspace/project --prompt 'Investigate the issue and implement the fix.'
antonina agent status --id a13f09c2
antonina agent log --id a13f09c2
antonina agent wait --id a13f09c2 --timeout 3600
```

A managed front runs in a working directory an operator declares with `--cwd`; it never inherits the directory of the shell that created it. `agent new` without `--cwd` records no working directory, `agent run` without `--cwd` refuses to launch such an agent, and `agent status` and `agent list` report `cwd: null` for it rather than naming a directory nobody chose. `--cwd` may be repeated on `run` to correct or declare the directory, and only while the agent owns no work: a live front's directory is never rewritten underneath it. The reported `cwd` is the directory the front runs in, which is not the same thing as wherever the front has since worked -- read `agent log` for that.

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

A report is read, never written, through `BoardApi.daemonHosts(reports, { nowMs })`, which joins host reports with the execution-target catalog and reports each host as `online`, `stale` or `offline`. It requires the board credential to join reports with board state and appends nothing to the signed board.

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
