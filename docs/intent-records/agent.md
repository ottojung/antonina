$id-20261009-longcat-restoration
title: Switch Antonina to LongCat 2.5 Preview Free with low variant
date: 2026/10/09
source: @ottojung
kind: constraint

User explicitly directs immediate replacement of Step 5 Preview Free with `opencode-go/longcat-2.5-preview-free` for all Antonina managed agents and the OpenClaw orchestrator, with `--variant low`. This supersedes the 2026/10/08 Step 5-only constraint and the 2026/10/09 Step 5 low-variant constraint, while preserving the single authorized model policy. Deploy consistently across CLI runtime, scheduler launcher, OpenCode config, and existing agent records. No fallback models.

$id-20261009-step5-low-variant
title: Antonina uses Low reasoning effort with Step 5 Preview Free
date: 2026/10/09
source: @ottojung
kind: constraint

Antonina managed agents and its OpenClaw orchestrator must invoke the existing sole authorized model `opencode-go/step-5-preview-free` using `--variant low`, not `high`. Preserve the sole-model restriction; no fallback to another provider or model. Update source defaults, scheduler launcher, tests and deployment consistently. This supersedes prior high-variant instructions, without changing the model itself.

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
title: antonina uses OpenCode Muse Spark 1.3 Contributor Free
date: 2026/09/23
source: @ottojung
kind: constraint

`antonina` must use Muse Spark 1.3 Contributor Free through OpenCode, identified as `opencode/muse-spark-1.3-contributor-free`. This is the configured `antonina` model and supersedes the temporary LongCat requirement.

$id-5849903270418621
title: Antonina managed agents use the low OpenCode variant
date: 2026/10/05
source: @ottojung
kind: constraint

Every managed OpenCode invocation launched by `antonina agent` uses `--variant high`. The OpenClaw scheduler also uses `--variant high`. The variant is an Antonina runtime setting, not a caller-selectable per-agent tuning knob. Legacy durable agent records that still contain `variant: low` remain readable for compatibility, but they do not downgrade a newly launched invocation; once that child is published, the durable record is updated to `high` so status reflects what actually ran.

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

$id-7512745100523122386
title: Collecting a shared conversation database reads then unlinks, and the interval is stated
date: 2026/10/05
source: issue-198
kind: constraint

Removing a dedicated OpenCode database file is a two-step act: the inventory of agent records naming that key is read, and the `.db` and its `-wal` and `-shm` siblings are then unlinked only if that read was complete and named nothing. Between the read and the unlink there is an interval, and this implementation has no exclusive claim on the key across it. A record published inside that interval can name the very key whose unlink is already in flight, and the unlink then removes a conversation that a live record is about to name. This window is a property of the primitives, not of this implementation: POSIX offers no compare-and-unlink, so nothing in ordinary Node or POSIX can make the judgment and the removal one act, and no lock is held across the read and the unlink. Narrowing the interval — re-read the inventory as late as the removal decision, and refuse unless the read is complete and the key is absent from it — is the whole of what is available, and an implementation that keeps the interval is not thereby claiming it closed.

What bounds the interval is the surrounding lifecycle rather than any claim about the key. A fork that reads its source after the delete tombstone is refused, because a source marked `delete_pending` blocks a fork. The reachable case is therefore the narrower one: a fork that read its source and passed that check before the tombstone was written, and that publishes its clone after the unlink has already happened. That case is not closed here, and this statement is the reason: a reader must not come away believing the re-read guarantees no record names the key, because it guarantees only that no record named it at the instant it was read. The alternative considered and rejected is to hold a lock across the read and the unlink. It is worse rather than better, for the reason recorded for the stale-lock reclaim in `hosts.md`: naming the lock would not make the judgment and the removal atomic either, it would add a second unwitnessed step to a destructive path, and the residual interval would then be larger and no longer stated. Trading this interval for a longer unstated one is not an improvement.

This is a statement about the interval alone. It does not weaken what the read must establish before the unlink: an inventory that could not be enumerated, or a record whose metadata could not be read or did not validate, is not an inventory that licenses an unlink, and a key the read names is not collected.

$id-2026100923424621
title: Merges require independent review and green exact-head integration checks
date: 2026/10/09
source: @ottojung
kind: constraint

A completed implementation or an agent's terminal handoff is not approval to merge.
Before any PR, release-branch integration, rollback, or promotion, a maintainer
must read the actual diff against its current target and obtain a substantive
independent review of that exact proposed change. Every required CI/check run
for the exact current head, and for the tested integration candidate when
different, must finish successfully. Missing, failed, cancelled, pending, or
uninspectable required checks are blockers, never tacit success; an intentional
skip is accepted only when that check is demonstrably inapplicable. A local
test run or an agent's summary does not substitute for GitHub/host CI.

Review and CI are invalidated by any material code change or target advance:
refresh the diff and rerun the required checks. Record the reviewed commit,
target/base commit, reviewer verdict, required check names and outcomes, and
resulting merge commit so that release state is auditable. After merging,
verify the actual target tree and subsequent branch checks, and do not promote
or deploy a known failing merge. On discovering an earlier invalid merge,
stop promotion and prepare a reviewed, green-CI correction or exact-tree
rollback instead of insisting the merge already happened.

The orchestrator treats integration and review as actionable work when they
can safely run in parallel, but it cannot waive their evidence gates to
increase throughput or to keep an agent busy.
