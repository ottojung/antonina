# OpenClaw deployment on Antonina hosts

This document records the first OpenClaw deployment experiment on `marceline-dev`.
It is intentionally an implementation log and reproducibility sketch rather than the
final host-provisioning contract.

The immediate goals are:

- run OpenClaw on an Antonina-compatible host;
- use the existing OpenCode installation as the coding-agent runtime;
- constrain OpenCode to `opencode/space-bunny-free`;
- prove that OpenClaw can spawn and manage OpenCode work through ACP/ACPX;
- later turn the successful procedure into a deterministic provisioning script.

The longer-term split should be:

- **o-channel** owns installable software such as OpenClaw and suitable Node runtime
  packages;
- **Antonina** owns host provisioning and the desired OpenClaw configuration;
- secrets remain outside Git;
- mutable OpenClaw runtime/session state is distinct from declarative host
  configuration.

See `ottojung/o-channel#2` for the future Guix packaging work.

## Current experimental host

Host: `lubko://marceline-dev`

Observed working OpenClaw version:

```text
OpenClaw 2026.9.6 (eb377ac)
```

Current executable:

```text
/home/lubko/.local/bin/openclaw
```

This is an experimental local installation. It is not yet the desired permanent
installation mechanism.

## Installation performed so far

The upstream Linux installer was tried first. `marceline-dev` is a minimal Guix
environment, and several ordinary FHS assumptions did not hold:

- Bash was initially absent.
- `grep`, `awk`, and `gzip` were not initially available on PATH.
- the upstream Node/npm launcher expected `/usr/bin/env`;
- the Guix-provided Node at the time was too old for current OpenClaw requirements.

The installer successfully downloaded a private recent Node runtime, but its npm
launcher could not execute normally because of the `/usr/bin/env` assumption.

The working experimental installation therefore uses OpenClaw's downloaded private
Node runtime directly and invokes npm through its JavaScript entry point rather than
through the npm shebang launcher. OpenClaw was installed under:

```text
/home/lubko/.openclaw
```

A small wrapper was added at:

```text
/home/lubko/.local/bin/openclaw
```

The wrapper directly runs OpenClaw with the private Node binary.

This is useful for experimentation, but it is not the desired final deployment.
The target is a normal Guix package in `o-channel` so a host can eventually obtain
OpenClaw through ordinary host provisioning.

## OpenCode integration

The preferred integration path is:

```text
OpenClaw
  -> ACPX
  -> OpenCode ACP server
  -> opencode/space-bunny-free
```

This is preferable to making Antonina own another long-running coding-agent process
manager.

The `@openclaw/acpx` plugin is installed and enabled. The OpenClaw Gateway has
successfully reported:

```text
embedded acpx runtime backend ready
```

The initially attempted direct `@openclaw/opencode-provider` route showed version
skew relative to the installed OpenClaw version, so ACPX plus the existing OpenCode
executable is currently the more useful path.

## Space Bunny model restriction

OpenCode already has working authentication on `marceline-dev`.

A dedicated OpenCode configuration is used for OpenClaw:

```text
~/.config/opencode/openclaw.json
```

Its intent is:

- primary model: `opencode/space-bunny-free`;
- small model: `opencode/space-bunny-free`;
- the OpenCode provider whitelist contains only `space-bunny-free`.

A dedicated wrapper is used:

```text
~/.local/bin/opencode-openclaw
```

It sets `OPENCODE_CONFIG` to that dedicated configuration before invoking the
host's OpenCode executable.

The dedicated config and wrapper were made read-only as useful friction against
accidental agent modification. This is **not** a strong security boundary while the
agent runs as the same Unix user and has unrestricted filesystem/shell authority.

OpenClaw agent entries used for this experiment also have a model policy containing
only:

```text
opencode/space-bunny-free
```

There are therefore two useful layers:

1. OpenClaw policy admits only Space Bunny for the configured agent.
2. The OpenCode process launched by OpenClaw sees a dedicated config in which only
   Space Bunny is available.

The eventual deterministic deployment should create these files from declarative
Antonina-owned inputs rather than mutate them interactively.

## ACPX configuration

The ACPX plugin is configured with an `opencode` harness whose command is:

```text
/home/lubko/.local/bin/opencode-openclaw
```

The correct argument list for the installed OpenCode version is currently:

```json
["acp"]
```

An earlier experiment attempted:

```json
["acp", "--model", "opencode/space-bunny-free"]
```

but the installed OpenCode ACP command does not accept `--model`. The model lock
must therefore come from the dedicated OpenCode configuration, not that CLI flag.

OpenClaw's ACP configuration is currently intended to allow only the OpenCode ACP
agent, using ACPX as the backend.

## OpenClaw agent entries

The experiment currently defines ACP-backed OpenClaw agent entries for the
OpenCode harness. Their important shape is:

```json
{
  "runtime": {
    "type": "acp",
    "acp": {
      "agent": "opencode",
      "backend": "acpx",
      "mode": "persistent"
    }
  },
  "modelPolicy": {
    "allow": ["opencode/space-bunny-free"]
  }
}
```

Worker entries are not intended to recursively spawn arbitrary additional workers.

An explicit OpenClaw agent entry named `opencode` was added after
`sessions_spawn(runtime="acp")` successfully initialized the ACP backend but then
failed dispatch with:

```text
Unknown agent id "opencode"
```

That explicit mapping resolved the dispatch problem. The first complete ACP child run
was then accepted and executed successfully.

## Gateway experiment

The OpenClaw Gateway can run successfully on `marceline-dev` in the foreground.
It has reached the `ready` state, starts its heartbeat, loads plugins, and initializes
the ACPX backend.

The Gateway has **not yet been installed as a permanent daemon/service**. The current
Gateway is intentionally a foreground smoke-test instance.

For the smoke test it is bound to loopback. Some temporary HTTP tool exposure was
enabled solely to drive `sessions_spawn` directly while debugging. That broad
temporary tool allowlist is not intended to become the production configuration.

A normal daemon deployment should use authenticated local Gateway access and should
not expose more host tools through the HTTP surface than are actually required.

## Delegation smoke test: current status

The delegation test is intentionally trivial:

```text
Ask OpenClaw to spawn an ACP OpenCode child that replies with an exact short string.
```

Progress:

- Gateway startup: successful.
- ACPX plugin loading: successful.
- OpenCode ACP process startup: successful after removing the unsupported
  `--model` argument.
- ACPX backend initialization: successful.
- OpenClaw ACP spawn admission: successful after giving the temporary loopback test
  caller the host-mutation capabilities OpenClaw requires for ACP.
- Child session creation: successful.
- Child dispatch through the explicit `opencode` OpenClaw agent entry: successful.
- The child completed the requested task and the Gateway log contained exactly:

  ```text
  LIVE-ACP-SPAWN-OK
  ```

The smoke test therefore proves the important execution path:

```text
Gateway -> sessions_spawn -> ACPX -> OpenCode ACP -> task completion
```

The temporary HTTP caller did not receive the child completion as a normal wake-up:
OpenClaw logged that the active requester session could not be woken and fell back
to requester-agent handoff. That is a property of the ad-hoc HTTP smoke-test caller,
not a failure of the ACP child itself. It remains relevant when deciding how Antonina
should invoke or subscribe to OpenClaw work.

## Important unsuccessful paths

These failures are useful because they should not be repeated in the final script.

### Treating `openclaw agent --local` as the ACP smoke test

This path used OpenClaw's embedded/default model routing rather than the configured
ACP runtime and attempted to use an OpenAI model. It is not the right test for the
OpenCode ACP deployment.

### Passing `--model` to `opencode acp`

The installed OpenCode ACP command does not accept that flag. Model selection belongs
in the dedicated OpenCode config for this deployment.

### Depending on the upstream installer as the permanent Guix-host mechanism

It was useful for discovering requirements and bootstrapping the experiment, but its
FHS assumptions make it a poor long-term host-provisioning primitive here.

### Treating read-only files as a security boundary

They prevent casual/accidental edits. They do not prevent a same-user agent with
general shell access from changing permissions and rewriting them.

## Desired deterministic deployment

The eventual Antonina host setup should be closer to a program than to a sequence of
interactive commands.

Conceptually:

```text
install software
  -> materialize declarative OpenClaw config
  -> materialize locked OpenCode config
  -> install/enable required OpenClaw plugins
  -> inject credentials from a non-Git source
  -> verify Space Bunny-only model view
  -> verify ACPX/OpenCode probe
  -> install/start authenticated loopback Gateway daemon
  -> run delegation smoke test
```

A future provisioning script should be idempotent: running it repeatedly should
converge the host toward the same desired configuration.

It should also separate:

### Software

Prefer Guix packages from `o-channel`:

- OpenClaw;
- a compatible Node runtime if OpenClaw still requires one separately;
- OpenCode;
- ordinary host utilities required by the runtime.

### Declarative shared configuration

Version-controlled in or alongside Antonina host provisioning:

- desired OpenClaw plugin set and versions;
- ACP/ACPX configuration;
- allowed ACP agents;
- model policy;
- the dedicated OpenCode model/provider configuration;
- Gateway bind/auth/service policy.

This is the configuration that should be easy to share across multiple Antonina
hosts and, where useful, make immutable on an individual host.

### Secrets

Never commit provider tokens or Gateway credentials to the repository.

The deployment should obtain secrets from an explicit host secret source and
materialize them with restrictive permissions.

### Mutable state

OpenClaw sessions, memory, logs, local databases, and other runtime state should be
treated separately from the shared configuration. Whether each part survives host
recreation should be an explicit policy decision rather than an accidental
consequence of persisting the whole OpenClaw home directory.

## Verification checklist for the future script

A deployment should not be considered complete merely because `openclaw --version`
works.

At minimum verify:

```text
[ ] openclaw executable works
[ ] expected OpenClaw version is installed
[ ] required plugins load
[ ] ACPX backend initializes
[ ] OpenCode authentication is available
[ ] dedicated OpenCode config exposes Space Bunny as intended
[ ] OpenClaw agent policy allows only Space Bunny
[ ] OpenCode ACP process starts through the configured wrapper
[ ] Gateway reaches ready state
[ ] Gateway is loopback-bound unless explicitly intended otherwise
[ ] Gateway authentication is configured
[x] an OpenClaw-controlled ACP child can complete a trivial task
[ ] the completed child actually used the desired OpenCode/Space Bunny path
[ ] daemon/service survives a host/session restart
```

## Open questions

The experiment still needs to settle:

- the cleanest production requester/session handoff for ACP-backed OpenCode children;
- the minimal production Gateway tool policy needed for ACP orchestration;
- the final daemon/service mechanism on a Guix Antonina host;
- the exact boundary between shared immutable configuration and host-local mutable
  OpenClaw state;
- how Antonina board access should be exposed to OpenClaw once basic spawning is
  proven;
- whether OpenClaw configuration itself should be generated wholesale or composed
  from a small shared base plus host-specific overlays.

The next milestone is deliberately small: install the Gateway as a persistent daemon,
remove the broad temporary HTTP smoke-test tool exposure, and verify that the same
ACP child path still works without broadening the design prematurely.


## Later findings from the same experiment

The first ACP child smoke test eventually completed successfully. OpenClaw accepted
the spawn, created an ACP child session, initialized the OpenCode ACP backend, and
the Gateway log contained exactly:

```text
LIVE-ACP-SPAWN-OK
```

This proves the execution path:

```text
Gateway -> sessions_spawn -> ACPX -> OpenCode ACP -> task completion
```

The ad-hoc HTTP requester did not receive the child completion as a normal wake-up;
OpenClaw logged a requester handoff warning after the child itself had completed.
That is a requester/session integration issue, not an ACP execution failure.

The broad temporary Gateway tool allowlist used to drive the HTTP smoke test was
subsequently removed.

### Native service installation is unavailable in this container

`marceline-dev` currently has `docker-init` as PID 1. OpenClaw reports:

```text
Service: no supported service manager detected
```

There is no usable systemd user service manager (and no Shepherd service manager)
inside this container, so `openclaw gateway install` cannot provide its normal Linux
daemon installation here.

A long-running Lubko command can keep a Gateway process alive for continued
experimentation, but that is a stopgap. The desired deterministic deployment should
make Gateway startup part of the Antonina host/container lifecycle rather than add a
new process supervisor to Antonina.

### Embedded OpenClaw model routing is not solved yet

The successful ACP worker path is separate from OpenClaw's own embedded/system-agent
model route.

On the current installation:

```text
openclaw models list --provider opencode
```

returns no models, and an explicit embedded run using
`opencode/space-bunny-free` fails as an unknown model.

This explains why the foreground Gateway's default heartbeat attempted the built-in
OpenAI default even though the ACP agents were restricted to Space Bunny.

Until the direct provider route is resolved or intentionally replaced, recurring
heartbeats are disabled with `agents.defaults.heartbeat.every = "0m"`. OpenClaw's
documentation defines `0m` as disabling recurring heartbeat cadence while still
allowing targeted event-driven wakes.

The desired final deployment therefore has two model-related checks:

1. ACP workers must continue to launch OpenCode with the dedicated Space Bunny-only
   OpenCode configuration.
2. Any OpenClaw embedded/system-agent route that is enabled must also be constrained
   to the intended model rather than silently falling back to another provider.


### Direct OpenCode provider catalog versus OpenCode CLI catalog

A later check clarified why the embedded OpenClaw route cannot currently be pinned to
Space Bunny even though ACP workers can use it.

When the OpenCode credential is explicitly exported into the process environment,
OpenClaw's direct provider discovery works:

```sh
set -a
. ~/.openclaw/.env
set +a
openclaw models list --refresh --provider opencode
```

but the current direct OpenClaw/OpenCode catalog contains models such as
`opencode/gpt-5.6-sol`, `opencode/claude-opus-5`, and
`opencode/big-pickle`; it does **not** contain
`opencode/space-bunny-free`.

By contrast, the dedicated OpenCode CLI configuration used by ACP reports exactly:

```text
opencode/space-bunny-free
```

This is an important architectural distinction:

- Space Bunny is available through the OpenCode CLI/ACP path we are using.
- Space Bunny is not presently available through OpenClaw's direct OpenCode provider
  catalog on this host/account.
- Therefore OpenClaw's embedded/system-agent model cannot currently be set to Space
  Bunny through the direct provider, while ACP workers can be.

Do not work around this by silently choosing a different direct-provider model. If
the product requirement remains Space Bunny-only, keep the embedded recurring agent
path disabled and use the ACP/OpenCode path until a supported direct route exists.
