$id-20261008-step5only
title: Step 5 Preview Free is Antonina's sole permitted OpenCode model
date: 2026/10/08
source: @ottojung
kind: constraint

Antonina managed agents and the OpenClaw orchestrator must use **only** Step 5 Preview Free, by StepFun, through OpenCode Go, with the exact identifier `opencode-go/step-5-preview-free`. Do not substitute other models, switch providers, or silently fall back to LongCat, Muse Spark, Space Bunny, or any other model, even if Step 5 is temporarily unavailable. Fail visibly instead; changing this model requires a new explicit user decision and an updated intent record. The runtime model constant, CLI status/availability diagnostics, scheduler launcher, OpenCode provider whitelist, tests, and deployment documentation must agree on this exact identifier. This decision supersedes all earlier model-selection intent records.

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

$id-8255170639024174
title: One flag has one meaning, and a backend limitation is a capability error
date: 2026/10/03
source: issue-178
kind: constraint

An option on the public command surface means the same thing on every path that accepts it. A flag whose meaning depends on the state the command happens to find — rewritten configuration while the agent is idle, a refusal while it is busy — is two flags wearing one name, and an operator cannot predict it. Where the previous behaviour was exactly that, it is deleted rather than preserved: `agent run --cwd PATH` names the directory *that invocation* runs in, on every run, including `agent run --steer`, and is accepted while a front is live.

A steer kills the current invocation and starts the next one in the same conversation. Naming a directory on a steer therefore relocates live work into that directory, and an operator who steers with a `--cwd` they have not checked has moved work; this is stated in the orchestrator skill rather than left to be discovered.

A backend that cannot honour a request is represented as an explicit capability or error — never as a different meaning for the same flag, and never by silently running somewhere other than the directory the record names. Antonina's CLI stays backend-agnostic by exposing one stable abstraction and asking the backend what it can do, not by branching on which backend is configured. A capability that cannot be honoured refuses before any state is written. That refusal keys on the *effective* launch directory, not on whether the flag was typed on this invocation: a directory can reach a launch from durable state or by inheritance from a forked record just as well as from argv, and gating on the flag alone would leave `--cwd` meaning whatever the configured backend can honour. Every route that can put a directory in front of a launch consults the capability first — `new --cwd`, `run --cwd`, `run --steer`, a `run` that inherits the declaration, and `new --fork`, which inherits the source's declared directory.

The working directory is not inherited from the invoking shell under any circumstance, including when a directory is omitted and one was observed earlier: the launch directory is resolved from durable state alone, and when no durable value exists the launch is refused by name.

A reported working directory is where the front ran, never where it was going to run. The declaration (`cwd`) is what the launch directory is resolved from, and it is written in the same durable transaction that accepts the prompt. The observation (`invocation_cwd`, `ran in:`) is a separate fact, it is written by the runner in the same durable write that publishes the spawned process identity, and nothing on the accepting side writes it. A value there is therefore only ever a directory a real front was actually launched in: an invocation that is accepted and then never launches leaves the previous observation in place rather than reporting the directory it failed to enter, and a fork reports `never ran` rather than inheriting the source's last launch directory. A pre-launch write here is a lie that outlives the invocation, because the record it leaves is terminal.
