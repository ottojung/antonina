# Execution target: a persistent Lubko host

Use this skill when work is dispatched to an execution target of kind
`persistent-host` on the `lubko` backend — that is, a real machine that stays
up between jobs and keeps a filesystem you can come back to. The board catalog
names the target and points here; this document is the procedure, and it
changes when the backend changes, so the catalog does not copy it.

Read `docs/intent-records/hosts.md` alongside this one. In particular the
record "An execution target is not a resource" is load-bearing: a target is an
environment a job may run on, a resource is a durable filesystem path an open
issue depends on. A persistent host is the one kind of target that *can* carry
resources, and it does so by answering to one canonical `lubko://` address.
That address is the whole relation; a resource never stores a second spelling
of it.

## Access method

`lubko-transport`. Work reaches the host over the Lubko transport, and Lubko is
the only thing that runs it. Antonina decides and records which target a job
runs on; it does not reimplement the transport, and it has no command-execution
surface of its own. If you are writing something that needs to run a command
there, you need a Lubko client, not an Antonina board call.

A target registered with any other access method is refused: the backend names
who runs the work and the access method names the mechanism, and the two cannot
disagree for a Lubko host.

## Setup and authentication

- The host must be reachable at the canonical `lubko://<server-name>` address
  the target declares. That address is the target's identity on the board: two
  targets may not claim one address.
- Whatever authenticates you to the transport (an SSH key, a Lubko credential,
  whatever your Lubko client requires) is host-side and is deliberately **not**
  in Antonina state. Antonina's own board credential says nothing about it and
  cannot be used to reach a host. Never record such a secret on the board or in
  this document; the board is a signed, shared log and every reader of it can
  read what you wrote.
- The host-local Antonina daemon is optional. It publishes capacity telemetry
  and nothing else: it carries no command surface, so a daemon can never become
  a second transport. A host with no daemon is a perfectly valid persistent
  target; it simply reports no live capacity, and the board overview says
  `unknown` rather than guessing.

## Workspace persistence

`durable-host-filesystem`. This is the reason to prefer a persistent host at
all: a directory one job writes is still there for the next job, and a later
job can depend on it being there. That makes a persistent host the only kind of
target on which a two-step job is safe.

Two things follow that are easy to get wrong:

- A path only counts as durable once it is **registered** as a resource
  (`antonina board resource add ISSUE HOST PATH`). Registration is dependency
  and liveness metadata, not ownership and not a lock: several open issues may
  depend on one resource.
- "Still there" is not "safe to delete". A registered path is protected while
  any dependent issue is open, and an unregistered path is protected absolutely.
  See `docs/skills/resources.md` before removing anything.

## Cleanup and garbage collection

`host-local-collector` by default, and a target may narrow this to `none` when
no managed collection roots are configured for it. Read the field on the target
rather than assuming the default: `none` is a real state and means no
host-local collection can reach that host's paths at all.

The collector is manual and human-driven. No cadence exists, and an agent never
triggers a pass. Only `antonina board collect delete --confirm`, run by a human,
can remove a registered path, and only when a verified board revision says no
open issue depends on it. Treat anything not collected as permanent and size
your work accordingly.

## Operational caveats

- **Liveness is not status.** A target recorded `available` is a registration an
  operator set; it is not a claim the host is answering. Liveness comes from the
  daemon's last report and is judged by age alone. Never infer ownership or
  reachability from a process name, and never from a pid without its start
  time.
- **A stale report is not a dead host, and a missing report is not a
  zero-capacity host.** The board overview reports `unknown` for both, and so
  should you.
- **Unavailability is refused by name.** A target whose recorded status is
  `unavailable` is not silently skipped in favour of another target; a request
  for it fails and says so.
- **Do not delete host state Antonina did not register.** A path you created
  outside the resource registry is invisible to the collector, which is
  protection, not a gap to exploit.
- The board overview shows live capacity only for daemon-backed persistent
  hosts. If the host has no daemon, ask the host, not the board.

## How an orchestrator should use this target

1. Ask the board for the target: `antonina board target list --kind persistent-host --page 1`, or `target show ID` for one target's access facts,
   persistence, garbage collection, limitations and guidance references.
2. Check the target's `status`. If it is `unavailable`, stop: the selection
   refuses that target by name rather than routing around it.
3. Select rather than assume. `antonina dispatch select` reports the decision
   and its rationale; `dispatch record` puts that rationale on the board. The
   same board and the same request always select the same target, so a
   disagreement between two orchestrators is a difference in board state or in
   the request, not in the rule.
4. Only after the dispatch is recorded, run the work over the Lubko transport.
5. Register any path the work leaves behind **while the issue is still open**,
   and register the issue as its dependent. That is what makes the path
   collectible later instead of permanent.
6. Close the issue only when the work is done. Closing the last open dependent
   is what makes a resource collectible, and nothing sweeps it up afterwards.
