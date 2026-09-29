$id-1773008474150624
title: Following an attached agent run is not bounded
date: 2026/09/27
source: @ottojung
kind: constraint

When `antonina agent run` is invoked in the foreground, the command follows the attached run until that run reaches a terminal state, and that follow is not bounded. It must not acquire a deadline, a default timeout, or any other elapsed-time limit, and it must not be changed to acquire one. A foreground follow ends because the run ended, not because a clock ran out.

The follow exists to carry the run's output to the operator who asked for it in the foreground. An agent run legitimately outlives any particular expectation about how long it should take, so a time bound on the follow would end the observation while the run it observes is still the work that was requested, discarding exactly the output the foreground was chosen to see. The operator who wants a bound has one, and it is explicit: the separate wait surface carries an opt-in timeout, and detach is available for callers who must not block at all. Absent an explicit request from that direction, silence about duration is not a request for a duration limit.

This is a statement about the attached foreground follow alone. It is not a claim that every wait in the command surface is unbounded, and it does not forbid a bound where one was deliberately asked for.

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

Agent IDs entering `antonina` at every input boundary are canonicalized to lowercase via the shared runtime ID normalizer. All subcommands of the public `agent` and `board` command surface that accept an agent ID use the `--id <ID>` option; no public command accepts the ID positionally. The sole positional form of an agent ID is the private `_runner` spawn seam, an internal managed-runner hand-off that is not a user command and is not reachable from the public command surface. The canonical form is stored, compared, and dispatched in lowercase. Mixed-case spellings such as `ABCD1234` and `abcd1234` identify the same agent.

$id-6028741935162408
title: Agent launch is not host-capacity policy
date: 2026/09/27
source: @ottojung
kind: constraint

The public `antonina agent` command is responsible for launching and managing an agent, not for deciding whether the host has enough memory, CPU, disk, or other capacity to run it. It must not refuse, delay, or suppress an otherwise valid launch based on host-capacity heuristics or preflight resource thresholds. If an agent dies because the host runs out of resources, it dies.

Antonina may improve observation, failure classification, and diagnostics around resource exhaustion — for example, reporting available operating-system evidence that an invocation was OOM-killed — but such diagnostics must not turn the agent command into a host scheduler or admission controller.
