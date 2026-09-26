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

That mapping is the current area being verified.

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

Progress so far:

- Gateway startup: successful.
- ACPX plugin loading: successful.
- OpenCode ACP process startup: successful after removing the unsupported
  `--model` argument.
- ACPX backend initialization: successful.
- OpenClaw ACP spawn admission: reached successfully after giving the temporary
  loopback test caller the host-mutation capabilities OpenClaw requires for ACP.
- Child session creation: reached.
- Final child dispatch: still being verified; the last concrete blocker was the
  missing OpenClaw agent entry named `opencode`.

This document should be updated when the first complete child run succeeds.

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
[ ] an OpenClaw-controlled ACP child can complete a trivial task
[ ] the completed child actually used the desired OpenCode/Space Bunny path
[ ] daemon/service survives a host/session restart
```

## Open questions

The experiment still needs to settle:

- the cleanest OpenClaw agent/session mapping for ACP-backed OpenCode children;
- the minimal production Gateway tool policy needed for ACP orchestration;
- the final daemon/service mechanism on a Guix Antonina host;
- the exact boundary between shared immutable configuration and host-local mutable
  OpenClaw state;
- how Antonina board access should be exposed to OpenClaw once basic spawning is
  proven;
- whether OpenClaw configuration itself should be generated wholesale or composed
  from a small shared base plus host-specific overlays.

The next milestone is deliberately small: complete one trivial ACP child task through
OpenClaw, then install the Gateway as a persistent daemon without broadening the
design prematurely.
