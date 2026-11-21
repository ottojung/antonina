# Private prompt transport (board issue yBLxLryis9hNBuoatP4nLK-moaning)

`antonina agent run` accepts exactly one prompt source: `--prompt`,
`--prompt-file <absolute path>`, or `--prompt-stdin`. File/stdin prompts are read
inside the process and persisted in the agent's 0600 metadata. Their content is
never placed in argv or an environment variable. `--steer` with a file/stdin
source is refused, because a queued steer cannot carry the transport marker.

`readPromptFile` requires an absolute path, an openable regular file (no
symlink), ownership by the current uid, and no group/other permission bits.
Both sources reject empty, >8 MiB, and invalid UTF-8 prompts with stable error
messages that never echo prompt content. The 8 MiB bound admits 250 KiB work.

The runner marks accepted file/stdin prompts with optional metadata
`prompt_transport: 'stdin'`. `buildAgentCommand(..., viaStdin)` then omits the
trailing positional prompt, the runner drops `ANTONINA_PROMPT` from the backend
environment, and pipes the exact prompt to OpenCode's stdin. OpenCode's
noninteractive `run` reads stdin when no message argument is supplied. Recovery
prompts use the same pipe. Inline prompts keep their existing transport.

`host-integration/antonina-orchestrator-turn.prompt-file` is a **draft, not
installed**: it writes the full prompt (all ordered model comments and every
open issue) to a 0600 file under `$XDG_STATE_HOME/antonina/scheduler-prompts`,
passes `--prompt-file`, and removes the file on every exit path. The live
hotfix and operator configuration are untouched.

Coverage: `packages/cli/test/agent-prompt-file.test.mjs`,
`packages/cli/test/scheduler-prompt-file.integration.test.mjs` (240 KiB model
comment + 120 open issues, E2BIG control, private file deletion), and
`packages/agent-runtime/test/prompt-file-transport.test.mjs` (270 KiB from
metadata to backend stdin with no argv/env leak).
