# Antonina

Antonina is a coordination system for shared software work. Its core is the Antonina board, a shared issue board backed by Skrynia. Execution environments and agents use its ordinary issue text to coordinate work.

An Antonina host is a provisioned execution environment that can access the board and run whatever tools are appropriate there: human-operated commands, scripts, coding agents, or other automation. Antonina is not defined by any particular agent runtime, model provider, or coding harness.

**Execution placement is an autonomous process responsibility, not a board feature.** The board has no execution-target registry, selection mechanism, or dispatch records. An orchestrator discovers suitable hosts, tools, and capabilities through whatever mechanisms it chooses, while retaining task-level requirements such as a mandated host. Generic agent lifecycle, host telemetry, and the board never stores host ownership or resource/deletion registrations.

## Current implementation

Antonina uses TypeScript/Node.js for its CLI, managed-agent runtime, shared board core, and web application. The repository currently includes a local managed-agent runtime built around OpenCode. Managed agents select the first non-cooled-down model per agent from the ordered, host-local `~/.config/antonina/config.json` `models` array. Each `{ "model": "provider/id", "comment": "..." }` entry may be reordered and annotated by orchestrators as reliability evidence changes. Comments should record dated successes, error modes, counts or duration where known, evidence sources, and uncertainty rather than just a preference label. There is no compiled-in model or fallback when configuration is missing; `antonina agent model list` shows preferences and `antonina agent model select` prints the first configured model without probing availability. Managed-agent quota exhaustion, rate limiting and model unavailability trigger six-hour per-agent model cooldowns; transient endpoint/server failures retry twice first. A cooldown expires opportunistically at the next invocation boundary. Unknown, authentication, billing and tool failures do not cause blind retries. Fresh OpenCode invocations emit structured JSONL so Antonina can durably checkpoint their native session IDs as soon as the backend announces them; recovery resumes that session, not a guessed or untracked fresh invocation. The OpenCode V2 model variant remains `low` and is passed as `provider/id#low`; V2 uses `--standalone` so each invocation owns its private server, with the working directory supplied by the launcher. That runtime is an implementation available to hosts, not the product boundary of Antonina. The authoritative constraint is `docs/intent-records/agent.md`.

## Requirements

- Node.js 22 or later
- **OpenCode V2** (`@opencode/cli` 2.2.x or newer compatible V2) as `opencode` on `PATH`. OpenCode V1 is not supported.
- Configure only models actually offered by your installed V2 provider catalog (`opencode models --standalone`). V1 `opencode-go/...` identifiers are not automatically converted to V2 `opencode/...` identifiers.
- Every new agent owns a dedicated V2 SQLite database; V1 databases/agent records are unsupported and **are not migrated**. Authenticate supported V2 providers against the agent database if they need credentials, using `OPENCODE_DB=<antonina-state>/opencode/<agent-db-key>.db opencode auth login --standalone` (inspect the agent record for the actual database key; forks can share it). Anonymous/free V2 models do not require provider credentials. Antonina does not import old credentials or perform format conversions.

For an explicit, isolated real-V2 session creation/continuation smoke test during development: `ANTONINA_OPENCODE_V2_BIN=/absolute/path/to/opencode npm run test:opencode-v2-smoke`. This makes two model requests and uses temporary XDG roots and a dedicated SQLite file; it does not install or deploy anything.

Normal execution uses precompiled JavaScript. A TypeScript compiler is only a development/build dependency.

## Install

Build and pack the CLI from a development checkout:

```sh
npm run bootstrap
npm run typecheck
npm run pack:cli
npm install -g ./antonina-cli-*.tgz
```

This installs the `antonina` executable. Release artifacts should ship the already-built package, so execution hosts do not compile TypeScript. **Verify the executable you will actually run**, not just the package that was installed: `command -v antonina` and `antonina --version` must identify the intended release commit. On hosts with multiple Node/npm prefixes, an older `antonina` may be earlier on `PATH`. For a host-local install, use `npm install --global --prefix "$HOME/.local" ./antonina-cli-*.tgz` and verify `"$HOME/.local/bin/antonina" --version`; make that directory take precedence on `PATH`. See [build identity and rollback](docs/build-identity-and-rollback.md) for a worked example.

## Board

The Antonina board starts as a signed operation log under `antonina/board-v2`. On the first mutation made by a v3-capable client, that verified history is materialized into sharded Skrynia objects: bounded signed-log chunks, one current issue record per issue, 50-entry issue-list pages, 50-message comment pages, feed pages, and small queue/catalog/authority records. The old `board-v2` object is kept unchanged as the migration source rather than dual-written forever. The signed operation history remains canonical; the sharded issue/list/feed objects are repairable projections used to make ordinary reads small. During this temporary storage phase board data is plaintext. Authentication is deliberately simple: the shared board key carried in existing Antonina credentials grants full access, and without that key the board cannot be read or changed. Historical capability scopes and revocations are not live authorization; an already-issued credential remains full-access. V3 object names are derived from the shared board key, while the shard objects themselves use ordinary public-write Skrynia storage.

The CLI is available as `antonina board`. Command and subcommand words are positional, but every data argument is an explicit named option: for example, `antonina board show --id ISSUE_ID --page 1`, `antonina board create --title "Fix it" --body "Details"`, and `antonina board comment --id ISSUE_ID --body "Done"`. **An issue has exactly one opaque, case-sensitive string ID.** New issues get a 22-character random base62 prefix and an independently selected word from the shared generator; an existing issue such as `"320"` remains an equally valid string ID. Consumers must not parse either form, cast IDs to numbers, or use the word alone. `board create` prints only the new ID on stdout; with `--json` it returns the created issue object whose `number` property is that same string ID (a historical field name, not an integer). For example, `issue_id=$(antonina board create --title "Fix it" --body "Details")` followed by `antonina board show --id "$issue_id" --page 1`. Paginated reads require an explicit 1-based `--page N`; there is no implicit page 1. `board show --page 1` returns the issue description plus the newest 50 comments; higher pages walk backward through older comments, while preserving chronological order within each page. New issue bodies and new comments are limited to 10,000 Unicode characters; existing larger historical content remains readable in full. Every public command and subcommand supports `-h` and `--help`. It reads its board credential from `$XDG_CONFIG_HOME/antonina/credential.json`, falling back to `$HOME/.config/antonina` when `XDG_CONFIG_HOME` is unset. `trust.json` may still hold the public integrity anchor for compatibility and verification, but it grants no board access. Existing credential files are unchanged by the v3 migration. There is no environment override for either file, so a fresh shell needs nothing exported. Unrelated settings — `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_HEAD`, `ANTONINA_BOARD_AUTHOR` — remain environment variables.

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

The board's issue queue is durable shared state, not a browser-local sort. The queue is exactly the set of currently open issues, each once: creating an issue appends it, closing or deleting one removes it, and reopening one adds it back. `antonina board queue list --page 1` prints the first page as `#ISSUE_A #ISSUE_C #ISSUE_B` (substituting actual complete IDs), or as a JSON array of strings with `--json`. `antonina board queue reorder --id "$c" --id "$a" --id "$b"` replaces the whole order with a permutation of the open issues; it is rejected, without writing anything, if the list is partial, repeats an issue, or names a closed or unknown issue. Both commands require the board credential. There is no separate queue permission or delegated role.

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
id=$(antonina agent new --cwd /workspace/project)   # prints the generated id
antonina agent run --id "$id" --cwd /workspace/project --prompt 'Investigate the issue and implement the fix.'
antonina agent status --id "$id"
antonina agent log --id "$id"
antonina agent wait --id "$id" --timeout 3600
```

`agent new` assigns the agent's id itself and prints exactly that bare id and a newline on stdout, so a shell captures it directly; `--json` emits the same id in the structured object. There is no caller-supplied `--id` on `agent new` (passing one is a usage error), and `agent new --fork <source>` mints a fresh id for the clone the same way while the `--fork` value still names the source. `run`, `status`, `log`, `wait`, `stop`, `kill` and `delete` accept the complete agent ID via `--id`; `list` filters the inventory, while `new --fork SOURCE_ID` takes the source ID through `--fork`. All agent ID references are case-sensitive opaque strings, including older hexadecimal IDs. Never lowercase, abbreviate, or parse their contents.

> **Migration complete (issue #320).** The repository's scheduler and deployment callers now capture newly generated IDs. External scripts still using `agent new --id <id>` must switch to `id=$(antonina agent new ...)` or read `.id` from `agent new --json`. Board creation likewise returns the ID on ordinary stdout, or a full issue object under `--json`. IDs are public labels, not credentials; legacy numeric values occur only at verified persistence boundaries and are exposed to consumers as strings.

A managed front runs in a working directory an operator declares with `--cwd`; it never inherits the directory of the shell that created it. `agent new` without `--cwd` records no working directory, `agent run` without `--cwd` refuses to launch such an agent, and `agent status` and `agent list` report `cwd: null` for it rather than naming a directory nobody chose.

`agent run --cwd PATH` names **the directory this invocation runs in**, and it means exactly that on every path, including `agent run --steer`: a steer kills the current invocation and starts the next one in the same conversation, and `--cwd` chooses where that next invocation runs. It is accepted while a front is live, and it also becomes the agent's declared default for later runs. **That default is sticky: one run or steer that names `--cwd` permanently moves every later invocation of that agent into that directory, including runs issued by a different orchestrator hours later, and including runs that name no `--cwd` at all.** `agent run` without `--cwd` continues the conversation in the directory the previous invocation ran in, which is what makes a steer without `--cwd` a continuation rather than a relocation. A backend that cannot launch an invocation in a named directory refuses by name, before anything is written, at every entry point that can put a directory in front of a launch: `agent new --cwd`, `agent run --cwd`, `agent run --steer --cwd`, and `agent new --fork`, which inherits the source's declared directory. The refusal follows the *effective* launch directory rather than the flag, so a directory declared while the backend could honour it is still refused on every later run that names no `--cwd` of its own, instead of being launched ungated. `--cwd` never quietly means something else depending on which backend is configured.

Two different facts are reported, and they are not interchangeable: `cwd` is the declared default, and `invocation_cwd` is the directory the current or most recent invocation was launched in (`ran in:` in human `agent status`, `never ran` when no invocation has been launched). Neither is an observation of where the front has since worked -- read `agent log` for that.

`antonina agent status` prints `created`, `started`, and `finished` as local date/time followed by a relative age (the same formatting as `antonina --version`). Missing dates show `-`. `agent status --json` intentionally retains numeric epoch-second timestamps. An OpenCode exit code of zero is reported as **`clearexit`**, not `succeeded`: it proves the backend process exited cleanly, not that the requested task was completed correctly. The terminal filter is `antonina agent list --page 1 --clearexit`; historical persisted `succeeded` records are read as `clearexit` and rewritten to that state on their next ordinary update.

`agent status` reports only **observed backend model launches**: `model` in JSON is the most recently launched model (or `null` when none can be established), and `models_used` lists distinct witnessed models, in order of last use. The human output shows `model` and, after a switch, `models used`. The saved model preference and failover selection are not evidence of an actual launch. Older agent records lacking this observation report `not observed` rather than guessing; only subsequent runs populate it. Forks start their own empty model history, even when they inherit a backend session.

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

A report is read, never written, through `BoardApi.daemonHosts(reports, { nowMs })`, which reports each observed host as `online`, `stale` or `offline` independently of any central catalog. It requires no board credential and appends nothing to the signed board.

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
