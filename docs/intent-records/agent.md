$id-20261022-reclaim-aware-headroom-diagnostics
title: Report memory pressure and reclaim-aware headroom, not only unused bytes
date: 2026/10/22
source: @ottojung
kind: constraint

Agent status and host-capacity diagnostics must not equate memory headroom with the raw subtraction memory.max minus memory.current. Cgroup memory.current includes inactive file cache and reclaimable kernel slabs; use cgroup-v2 memory.stat to report a bounded, explicitly approximate working-set and potential-reclaim estimate, keeping the exact raw unused bytes visible separately. Do not treat shmem/tmpfs, dirty or writeback pages as freely reclaimable. Report estimate as a percentage of the actual cgroup hard limit and prefer cgroup memory.pressure over host-wide pressure, labeling the scope. Missing or malformed counters mean the reclaim-aware estimate is unknown, not zero; retain the raw observation. Never use this estimate, PSI, or other host resources to refuse, delay or cap agent launches. Scheduler parallelism remains determined by work topology rather than a byte threshold.

$id-20261022-failure-scoped-soft-model-selection
title: Model errors classified by permanence and scope with soft transient fallback
date: 2026/10/22
source: @ottojung
kind: constraint

For managed agents and the supervised orchestrator, classify failures by their evidence and recoverability rather than treating all request errors as a six-hour model outage. Preserve the ordered configured list: choose the highest-ranked healthy configured model; if none is healthy, choose randomly among models with transient server failures, independently on each new run/turn. Such models are unreliable, not disqualified. Apply short backoffs with jitter before transient retries and never loop endlessly through models in a single accepted run. Definitive quota exhaustion remains excluded until its provider reset timestamp when reliable, otherwise the conservative six-hour fallback; rate limits use shorter temporary exclusion. A known absent/unsupported model and provider-specific authentication/billing failures are hard exclusions under unchanged configuration; provider-scoped errors apply to models sharing that exact provider identifier rather than unrelated providers. Ambiguous, request-specific, host, tool, or unclassified errors are NOT evidence for permanent model exclusions or unsafe replay. A hard exclusion is not an assertion that all services are permanently offline: changed model configuration or explicit operator repair can make another candidate eligible. Keep existing managed-agent metadata readable; old long transient cooldown records are soft evidence, not bans. The standalone orchestrator supervisor must follow the same reliability policy without reading an OpenCode model catalog, and model switching must preserve recorded native sessions and process identity safety checks. Do not add host-specific limits or fixed execution caps.

$id-20261022-managed-agent-model-step-stall
title: Conservative managed-agent liveness and safe model switching
date: 2026/10/22
source: @ottojung
kind: constraint

Detect a backend's process identity and kernel state, and observe actual OpenCode structured output at low cost. Do not equate process existence with progress or elapsed time alone with a backend failure. On a new managed-agent invocation, when a canonical step_start event is the last completed event for at least fifteen minutes, the backend process is the identical living interruptibly sleeping process, a genuine recorded native OpenCode session exists, and at least one alternate configured model is eligible, the runner may deliver a checked signal and use its existing session-preserving model-failover and cooldown path. Operator stop/kill/steer wins; never switch because of a tool or unstructured/partial log, unknown state, missing session, no alternative, or kernel D-state/disk I/O blockage. Never replay untracked tool effects. Implement inside the runtime, not as a resource gate or host-specific scheduler restriction. Existing agents are not interrupted merely by installing a new executable; liveness applies to invocations launched with the new runtime.

$id-20261022-recover-silent-startup-and-provider-error
title: Recover silent managed-agent invocations after launch and terminal API errors
date: 2026/10/22
source: @ottojung
kind: constraint

A managed-agent runner must not treat process survival as forward progress. In addition to unfinished model steps, independently detect (1) a silent new backend process with a durably recorded existing OpenCode session, and (2) a backend that emitted an authoritative terminal OpenCode APIError (such as HTTP 429 usage-limit exhaustion or HTTP 5xx) but did not exit. Use the existing per-agent configured-model cooldowns to move to the next eligible model and resume the exact native session after a bounded observation window. Accept the provider error only from a top-level structured event in the current invocation, not earlier sessions or arbitrary tool output; ignore presentation-only OpenCode model footers after it. A fresh silent invocation without an actual checkpointed session must not be replayed. Preserve the existing fail-closed behavior for host kernel D-state, active or unverified tool operations, unknown/authentication/billing errors, operator controls, pid reuse, and missing alternative models. This is runtime-local liveness, not a resource-dependent admission restriction. Existing runners must be replaced through safe same-session continuation if new recovery functionality is required immediately; installing binaries alone does not retrofit an already running process.

$id-20261021-orchestrator-model-recovery-session-checkpoint
title: Supervised orchestrator model failover and early managed-agent session checkpoints
date: 2026/10/21
source: @ottojung
kind: constraint

The supervised orchestrator must use the operator's existing ordered model list, without model catalog queries, and maintain its own durable host-local model cooldowns independently of managed agents. Definitive quota exhaustion, rate limiting and unavailable models advance to the next configured model immediately on the next supervised turn; transient endpoint/server failures retry the same model twice before advancing. Cooldowns expire after six hours and are re-evaluated at turn boundaries. Unknown, authentication, billing, signal and task errors retain the existing generic failure handling; no new providers or credentials are introduced. Every restarted turn must rebuild its live snapshot to avoid replaying stale dispatch decisions; a recognised failover must not unnecessarily trigger the generic supervisor failure backoff. On managed agents' fresh OpenCode invocations, use structured backend events to checkpoint the actual native session ID durably while the process is running, preserving that conversation across a subsequent failure or steer. Resume that recorded session without inventing another and without replaying untracked tool effects. If no trustworthy session ID is available, fail closed rather than guessing. These two changes are the complete scope of this request; leave other orchestration architecture unchanged.

$id-20261021-no-opencode-model-discovery
title: Configured models are authoritative without catalog discovery
date: 2026/10/21
source: @ottojung
kind: constraint

Antonina must never query OpenCode for a catalog or list of models during orchestrator turns, agent launch, agent continuation, or CLI model selection. Use the first identifier in the local ordered model configuration directly for orchestrators; for each managed agent, use the highest-preference configured identifier without an active per-agent failure cooldown. Only real inference failures drive per-agent retry and failover, preserving the existing cooldown policy. Do not invent models, edit the host-local preferences automatically on discovery failure, or use a catalog probe as admission preflight. Model research, when desired, belongs to autonomous agents or orchestrators rather than Antonina implementation. The CLI model select command reports the first configured identifier without checking external availability. This supersedes earlier requirements for selecting only model IDs advertised by OpenCode.

$id-20261021-per-agent-model-recovery
title: Bounded per-agent model failover with expiring cooldowns
date: 2026/10/21
source: @ottojung
kind: constraint

Managed agents use the host's existing ordered model configuration but maintain independent durable model cooldowns. A definitively exhausted quota, provider throttle or unavailable model advances immediately; a transient endpoint/server failure retries the same model twice with bounded backoff before advancing. After six hours, a previously cooled-down higher-priority model becomes eligible again only at the next invocation boundary. Switching must not interrupt a productive live invocation or reset agent identity. Track the actual invocation model and persist cooldown reason/time in canonical per-agent metadata, without introducing another service. Unknown failures, credential problems, billing problems, tool failures, operator stop/kill and resource signals must not silently cause model replay. Reuse the existing OpenCode session on recovery, and do not replay untracked fresh invocations that may already have executed tools. The software must not introduce new models or auth routes beyond the operator-maintained configured list. User explicitly does not authorize usage-based OpenAI API billing; ChatGPT OAuth and external free tiers are distinct. This supersedes the prior no-automatic-model-fallback restriction, but preserves all historical model observations below.

$id-20261021-agent-model-subcommands
title: Model inspection and selection belong to the agent command namespace
date: 2026/10/21
source: @ottojung
kind: constraint

The public interface for inspecting and selecting the ordered, host-local model configuration is `antonina agent model list` and `antonina agent model select`, not a top-level `antonina model` command. Every orchestrator caller, public help surface, test, and current deployment document must use the nested agent namespace. The model ordering and evidence-rich comments, and the absence of compiled-in defaults or fallback models, remain unchanged. This supersedes the earlier command-path choice recorded in the configuration implementation.

$id-20261021-configurable-model-order
title: Antonina selects models exclusively from an operator-maintained ordered configuration
date: 2026/10/21
source: @ottojung
kind: constraint

Antonina must never hardcode an OpenCode model identifier or install a built-in model default. Both orchestrator turns and managed-agent invocations choose the first model available in the ordered "models" array in $HOME/.config/antonina/config.json (XDG_CONFIG_HOME/antonina/config.json when set). Each entry has a model identifier and a free-form comment. Comments must be substantive, dated observational records: include the observed successful or failed operation, failure mode and frequency when known, source of evidence, and uncertainty. Do not present lack of evidence as proof of reliability. Orchestrators can atomically reorder entries, edit comments, and record observations such as historical availability and success/failure behavior; comments inform model choice but do not themselves execute as instructions. Missing, empty, malformed, duplicate, or unavailable configurations cause explicit immediate failures rather than unapproved substitutions. Installing/updating Antonina must not overwrite this host-local configuration. A user can initially place Beam Free first, but that is an operator preference, never a hardcoded Antonina default. This policy supersedes all earlier single-model instructions below; keep those as historical records only.

$id-20261015-longcat-free-verified
title: LongCat 2.5 Preview Free is Antonina's sole authorized OpenCode model
date: 2026/10/15
source: @ottojung
kind: constraint

After live verification of successful real OpenCode responses on both marceline-dev and phoebe-dev, user directs switching literally all active Antonina managed agents, orchestrators, CLI, restricted configuration, documentation, checks, and tests to exactly `opencode-go/longcat-2.5-preview-free` (LongCat 2.5 Preview Free), using `--variant low`. The OpenCode Go provider whitelist contains only `longcat-2.5-preview-free` and both primary and small models equal this identifier. There is no automatic paid or other fallback. If the model fails, report it visibly without switching models. Deploy from the same canonical main branch on both hosts. This decision supersedes the prior Cat Jam Free sole-model intent as well as all earlier model-selection instructions, preserved below as historical records.

$id-20261014-productive-continuation
title: Productive verifiable work packets and durable continuation
date: 2026/10/14
source: @ottojung
kind: constraint

Antonina orchestrators must read complete issues and delegate concrete, independently verifiable subproblems when a whole research or engineering goal is too broad. Workers must confirm repository identity before editing, attempt constructive implementation, proof or diagnosis rather than immediately giving up, and preserve actual evidence. Handoff comments should name repository, branch, artifacts or reproducible failures, validation, attempted approaches and next tasks so successors can continue without rediscovering work. Process success, a vague partial statement and an empty commit do not establish task progress. Work remains topology-only, without worker quotas, arbitrary deadlines or host-capacity admission policy. Parent acceptance criteria must not be weakened.

$id-20261014-cat-jam-free
title: Cat Jam Free is the sole authorized Antonina OpenCode model
date: 2026/10/14
source: @ottojung
kind: constraint

Antonina managed agents, orchestrators, CLI defaults, model checks, OpenClaw integration, restricted model configuration, tests and current documentation must exclusively use `opencode-go/cat-jam-free` (Cat Jam Free), with `--variant low`. The restricted OpenCode provider whitelist contains only `cat-jam-free`; both primary and small models use exactly this identifier. No fallback to a paid provider or any other model. Fail visibly when unavailable. Deploy consistently across hosts. This explicit decision supersedes all earlier model-selection intent records, including Step 5 and LongCat, retained below for historical provenance.

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

**Superseded by `$id-20261019-opaque-agent-identity` below.** This older requirement is retained solely as historical intent. Current ID consumers preserve case and never interpret the ID's shape.

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


$id-20261019-opaque-agent-identity
title: Generated agent identifiers are case-sensitive opaque strings
date: 2026/10/19
source: issue-320
kind: requirement

Antonina generates fresh managed-agent IDs as a random 22-character base62 prefix, a hyphen, and an independently chosen English word. The complete generated ID is case-sensitive. All CLI and runtime consumers treat identities as opaque strings, preserve exact case, and never parse the word. Existing legacy lowercase hex agent IDs remain valid as their exact opaque strings. All agent IDs are case-sensitive regardless of age; no consumer recognizes legacy vs newly minted shapes or lowercases a reference. The earlier case-insensitive-ID guidance is superseded for every agent ID. The agent new creation command does not accept caller-provided --id; it prints the generated ID alone on stdout, or returns structured --json.
