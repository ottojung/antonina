# Antonina contributor guidance

Antonina is a TypeScript/Node.js command-line runtime for long-lived local coding-agent sessions. The public executable is `antonina`; OpenCode is the current external backend.

## Architecture

- `packages/agent-runtime/` owns durable managed-session state, process lifecycle, OpenCode invocation, logs, and recovery semantics.
- `packages/cli/` owns command parsing/output and packages the precompiled `antonina` executable.
- `packages/core/` owns shared board/domain/Skrynia behavior used by CLI and web.
- `web/` is the Antonina-owned React/Vite board app.
- Durable user state lives under `$XDG_STATE_HOME/antonina` (default `$HOME/.local/state/antonina`).
- `docs/intent-records/` records durable product constraints and `docs/skills/` contains agentic operating guidance.

## Non-negotiable constraints

- Production Antonina behavior is TypeScript compiled to JavaScript and runs on Node.js 22+.
- OpenCode is an external executable, not an imported runtime library.
- Do not add native addons merely to emulate the old Python pidfd/flock edge guarantees. Ordinary Node/POSIX process signalling after PID/start-time/marker checks is sufficient.
- Never infer process ownership from process names.
- Lifecycle changes must preserve accepted prompts, runner generation ownership, FIFO steer ordering, and coherent stop/kill/delete state.
- Shared board/domain behavior belongs in `packages/core`; do not duplicate it between CLI and web.

## Test safety

Tests must never read or mutate ambient Antonina state. Set `XDG_STATE_HOME` to a test-owned temporary directory. Any test that spawns a process must converge/reap it before returning.

Do not run manual lifecycle experiments against a real `$XDG_STATE_HOME/antonina`.

## Development

Use the repository's locked TypeScript toolchain:

```sh
npm run bootstrap
npm run typecheck
npm test
npm run build
```

There is no alternate Python runtime. Product behavior belongs in the TypeScript packages above.
