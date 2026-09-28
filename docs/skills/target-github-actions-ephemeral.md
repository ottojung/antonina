# Execution target: an ephemeral GitHub Actions environment

Use this skill when work is dispatched to an execution target of kind
`ephemeral-environment` on the `github-actions` backend. The environment exists
for one job and is destroyed when that job ends. It has no `lubko://` address,
no durable filesystem, and **no resources anywhere in the board** — that is the
whole consequence of being ephemeral, and the reason this target kind cannot
carry a durable path at all.

Read `docs/intent-records/hosts.md` alongside this one. In particular the
record "An execution target is not a resource" is load-bearing: nothing on an
ephemeral environment is a board resource, because a resource is a durable
filesystem path an open issue depends on and this environment has no durability.

## Access method

`github-workflow-dispatch`. Work reaches the environment by dispatching a
workflow run in the external service. GitHub Actions is an external service, not
an Antonina runtime, and Antonina does not reimplement or wrap it: it records
which target a job was routed to, and the service runs the work.

A target registered with any other access method is refused, and so is a
persistent host on this backend: `github-actions` runs ephemeral environments
only. A workflow run is not a machine Antonina can keep a filesystem on.

## Setup and authentication

- The repository, the workflow file, and the runner labels the workflow
  requests all live in the external service and are configured there. They are
  not Antonina state, and changing them is not a board operation.
- Credentials for the service are the service's own: a token, a GitHub App
  installation, or whatever the workflow authenticates with. **None of it
  belongs on the Antonina board.** The board is a signed, shared log; anything
  written to it is readable by every board participant, and the board has no
  field meant for a secret. If a target's `description` or `limitations` starts
  to look like a place to keep a token, it is not.
- Antonina holds no opinion about whether the service is reachable, whether a
  runner exists, or whether an account has quota left. It records a
  registration; the service answers for its own health.

## Workspace persistence

`per-job-workspace`. The runner checks out the repository into a workspace it
builds for the job, and that workspace is destroyed afterwards. There is no
directory that survives the run.

This has one consequence that changes how work is planned, and it is the reason
this target kind is worth distinguishing rather than treating as a slow host:

- **A job may not be split across two dispatches on this target.** Step two of
  a two-step job gets a fresh workspace with only what the repository contains.
  Anything step one wrote to the filesystem is gone, including anything it
  committed to the repository only locally.
- **A resource cannot be registered against this target.** There is no
  `lubko://` address to register a path against, and a target that had one
  would be a different kind of thing.
- To carry state between jobs on this backend, carry it in the repository or in
  an artifact the service itself stores. That is a decision about the external
  service's own storage, not about a board resource.

## Cleanup and garbage collection

`provider-managed`. The service expires the environment on its own schedule, and
Antonina has no part in it: there is no Antonina collector, no `--confirm`, no
managed root, and no pass to trigger. A target may narrow this to `none` when
something outside Antonina is what expires it — read the field rather than
assuming.

Two consequences worth stating plainly, because they are easy to get backwards:

- Nothing Antonina does removes anything here, so a job that must be
  reproducible cannot rely on cleanup to tidy up after it.
- Nothing the service removes is a board decision, so an issue whose work lived
  only on an ephemeral environment has no durable record of that work.

## Operational caveats

- **Do not report host-like telemetry for this target.** There is no RAM, disk
  or CPU figure that is the host's own, because there is no host. The board
  overview says `not applicable` for capacity here and `unknown` for provider
  quota, and it must keep doing so: an invented number is worse than an absent
  one, because an orchestrator will schedule against it.
- **Provider quota is unknown to Antonina.** Whether the account has minutes or
  concurrent-run budget left is a fact only the service has, and Antonina has no
  integration that asks it. Read it from the service before a burst, not from
  the board.
- **Unavailability is refused by name.** A target whose recorded status is
  `unavailable` is not silently skipped in favour of another target; a request
  for it fails and says so.
- **A dispatch record is a routing decision, not a run record.** It says the
  issue was routed here. What the workflow then did is visible in the external
  service, not in the board.

## How an orchestrator should use this target

1. Ask the board for the target: `antonina board target list --kind
   ephemeral-environment`, or `target show ID` for one target's access method,
   persistence, garbage collection, limitations and guidance references.
2. Choose this target only when the work genuinely needs no durable filesystem
   and no durable path — a build, a test run, a one-shot fix whose result is
   committed to the repository.
3. Select rather than assume. `antonina dispatch select --kind
   ephemeral-environment` reports the decision and its rationale;
   `dispatch record` puts that rationale on the board.
4. Only after the dispatch is recorded, dispatch the workflow in the external
   service.
5. Do not register a resource for work that ran here. Put anything the next job
   needs into the repository or an artifact the service stores.
6. Close the issue when the work is genuinely done, not when the run was
   dispatched.
