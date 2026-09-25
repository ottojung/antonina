$id-9448585901481383
title: antonina uses OpenCode Space Bunny Free
date: 2026/09/23
source: @ottojung
kind: constraint

`antonina` must use Space Bunny Free through OpenCode, identified as `opencode/space-bunny-free`. This is the configured `antonina` model and supersedes the previous Muse Spark 1.3 Contributor requirement.

$id-8612645784701677
title: Agent IDs are case-insensitive and use --id uniformly
date: 2026/09/15
source: issue-777
kind: requirement

Agent IDs entering `antonina agent` at every input boundary are canonicalized to lowercase via `normalize_agent_id()`. The public agent subcommands are `new`, `list`, `status`, `prompt`, `log`, `wait`, `stop`, `kill`, `delete`, and `clean`; they are reachable only through `antonina agent ...`, never directly at the root. All subcommands that accept an agent ID use the `--id <ID>` option; no command accepts the ID positionally. The canonical form is stored, compared, and dispatched in lowercase. Mixed-case spellings such as `ABCD1234` and `abcd1234` identify the same agent.
