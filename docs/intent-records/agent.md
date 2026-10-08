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

Every managed OpenCode invocation launched by `antonina agent` uses `--variant low`. The variant is an Antonina runtime setting, not a caller-selectable per-agent tuning knob. Legacy durable agent records that still contain `variant: low` remain readable for compatibility, but they do not downgrade a newly launched invocation; once that child is published, the durable record is updated to `low` so status reflects what actually ran.

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

$id-7512745100523122386
title: Collecting a shared conversation database reads then unlinks, and the interval is stated
date: 2026/10/05
source: issue-198
kind: constraint

Removing a dedicated OpenCode database file is a two-step act: the inventory of agent records naming that key is read, and the `.db` and its `-wal` and `-shm` siblings are then unlinked only if that read was complete and named nothing. Between the read and the unlink there is an interval, and this implementation has no exclusive claim on the key across it. A record published inside that interval can name the very key whose unlink is already in flight, and the unlink then removes a conversation that a live record is about to name. This window is a property of the primitives, not of this implementation: POSIX offers no compare-and-unlink, so nothing in ordinary Node or POSIX can make the judgment and the removal one act, and no lock is held across the read and the unlink. Narrowing the interval — re-read the inventory as late as the removal decision, and refuse unless the read is complete and the key is absent from it — is the whole of what is available, and an implementation that keeps the interval is not thereby claiming it closed.

What bounds the interval is the surrounding lifecycle rather than any claim about the key. A fork that reads its source after the delete tombstone is refused, because a source marked `delete_pending` blocks a fork. The reachable case is therefore the narrower one: a fork that read its source and passed that check before the tombstone was written, and that publishes its clone after the unlink has already happened. That case is not closed here, and this statement is the reason: a reader must not come away believing the re-read guarantees no record names the key, because it guarantees only that no record named it at the instant it was read. The alternative considered and rejected is to hold a lock across the read and the unlink. It is worse rather than better, for the reason recorded for the stale-lock reclaim in `hosts.md`: naming the lock would not make the judgment and the removal atomic either, it would add a second unwitnessed step to a destructive path, and the residual interval would then be larger and no longer stated. Trading this interval for a longer unstated one is not an improvement.

This is a statement about the interval alone. It does not weaken what the read must establish before the unlink: an inventory that could not be enumerated, or a record whose metadata could not be read or did not validate, is not an inventory that licenses an unlink, and a key the read names is not collected.
