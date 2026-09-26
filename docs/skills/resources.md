# Durable host resources

Use this skill when scheduled or agentic work creates, uses, or hands off a durable host filesystem location. A resource is a host and canonical absolute POSIX path, such as `lubko://phoebe-dev` plus `/workspace/project-worktree`; the path may be a file or directory.

Resource registration is dependency and liveness metadata, not exclusive ownership or a lock. Multiple open Antonina issues may depend on one resource. Every number in these commands is an **Antonina BOARD issue number**, never a GitHub issue number.

## Garbage collection semantics

No collection pass runs on a cadence, and nothing schedules a collection pass. The only thing that can remove a host resource is a human running `antonina board collect delete` with `--confirm`; the collector is deliberately opaque to agents in the sense that an agent never triggers it, so never plan around cadence or timing that does not exist, and do not assume a path is safe because no one has come for it yet.

`antonina agent clean` is a different thing and is not a host-resource collector as long as it touches nothing but Antonina's own agent state; it registers no host path, reads no resource, and is a manual sweep of that state for agents in a terminal state older than a retention period.

A path is collectible only when it is registered on that host and no open Antonina board issue depends on it. A path no human has registered with `antonina board resource add` is protected — absence of a decision is never an authorization to delete — and registration is a human action that nothing in the agent lifecycle performs, so in practice no path is collectible at all until someone has registered it. A registered resource is protected while any dependent issue is open and collectible when all dependents are closed. Closing the last open dependent issue can make the resource collectible immediately; do not rely on a grace period.

## Commands

```sh
antonina board resource list [--host HOST] [--issue NUMBER]
antonina board resource add ISSUE HOST PATH
antonina board resource remove ISSUE HOST PATH
```

`--host` and `--issue` narrow inspection; verify registrations rather than assuming a command succeeded.

## Collection

Two commands answer "may this path go?", and only one of them can make it go.

```sh
antonina board collect list --host lubko://phoebe-dev
antonina board collect delete --host lubko://phoebe-dev --path /workspace/project-worktree [--confirm]
```

`collect list` is a dry run. It prints every path on that host that one verified board revision calls collectible, each line naming the board and the revision the answer came from. It needs no managed roots and no board credential — it only reads — but it does need a trust anchor for the board, from `$XDG_CONFIG_HOME/antonina/trust.json` or from the board credential in `credential.json`; with neither, the board cannot be verified at all and the command exits non-zero. A board it cannot read or cannot verify is a failure on stderr with a non-zero exit, never an empty list.

`collect delete` removes a path, and needs `--confirm`. Without it the command performs the whole re-check and then reports what it would do, naming the revision it read:

```
would delete /workspace/project-worktree on lubko://phoebe-dev (a symlink would be unlinked as a link, anything else removed recursively); board <id> rev <revision>; re-run with --confirm
```

**The delete reports the revision it re-read, which may be newer than the listing you based it on.** Nothing pins the revision you read. The human line names exactly one revision, the one the command's own re-check verified; the JSON report carries `recheckHead` (the revision acted on) and `snapshotHead` (the revision the claim named, `null` when the board moved on in between), and only `recheckHead` is authority. A pending report has no `removal` key; its presence in the JSON is what marks a report as a completed removal, so a script can tell the two apart.

**There are two hazards on this path — the read-to-remove window, and the re-pointing refusal — and only the first is about timing.** The re-check issues the authority to act on the one path it read, not a token its holder may re-point: both destructive steps re-derive the path, host, board, revision, outcome, reason and removal shape from the record the re-check itself left behind, and an authorization whose carried values no longer match it is refused before any `unlink` or `rm` — with nothing done, not performed against the re-pointed values and refused afterwards.

**Single-use is enforced where the record of the issue is consumed, which is the commit:** one completed re-check can produce at most one completion record. A removal only reads that record and does not spend it, so what one re-check bounds is the number of completions it can yield and not the number of removals performed from it — a collector that removes without ever committing is the shape that would remove more than once from one re-check. This command removes and only then commits, so in this command one re-check is one removal, and a removal that was performed is owed exactly one commit. A script reading the report should therefore treat the reported path, host and board as the ones acted on, and not as a claim the edit-resistant re-derivation already made for it. The two hazards are independent: the window below can lose a path that was protected after the re-check read, and the re-pointing refusal can stop an action the board would have permitted.

**The deletion is immediate and irreversible, and the residual window is real and unclosable.** Between the re-check's read and the unlink, a path can become protected again; if it does, it is still deleted. The signed board log is append-only with no lease or compare-and-delete primitive, so the protocol can promise only that the path was unowed at the last authoritative read. Minimize the interval: read the listing, then delete promptly, and re-run the listing if you hesitated.

**Removal is recursive, and a symlink is removed as a link, never followed.** A directory that is not empty is removed with its contents. A candidate whose final component is a symlink inside its managed root has the link unlinked and its target left alone; a symlink that resolves outside its managed root is refused, and so is a candidate whose containing directory escapes the root through one.

**The removal shape is decided by the re-check and is not decided again.** Which of those two removals happens is a fact about what the gatherer observed *inside* the re-check, and it is carried on the authorization, so the removal observes nothing and takes the shape it was given. A final component swapped after the re-check does not change the removal: if it was judged a symlink, the link is unlinked whatever is there now, and a directory that appeared in its place is not descended into.

**The window is not bounded by the final component: any component can change, and the containing directory is the dangerous one.** The final component is pinned, as above, but between the re-check's read and the removal any *other* component can change. The *containing directory* can be replaced by a symlink, and the removal then follows it and recursively deletes a tree outside the managed root — a tree the re-check never judged at any component. This cannot be closed: every check is a read followed by its own window, because neither the filesystem nor the board log offers a compare-and-remove. That is also why the removal makes no read of its own: a read would only add a window, not remove one. Keep the interval as short as you can, and treat a path that became protected after the re-check's read as a real possibility rather than an unlikely one. Recursive removal also descends into a bind or mount point inside the candidate — a devcontainer or sshfs mount under a worktree is realistic — and removes the contents from the mounted side; that is `rm -rf` semantics, not a collector guarantee.

Deletion additionally requires managed collection roots, configured as a `:`-separated list of absolute directories in `ANTONINA_COLLECT_ROOTS`. The spelled coordinate is configuration; the resolved coordinate is this process's own `realpath` of it. An unset `ANTONINA_COLLECT_ROOTS` — or one naming nothing but separators — is refused by name as `roots-not-configured: no managed collection roots are configured in ANTONINA_COLLECT_ROOTS; …` before anything else is checked; a malformed, non-canonical, duplicated or nested root set is reported as such. Either way no board is read. A path in no configured root, and a configured root itself, are refused by the re-check, after the board read. A managed root is refused if its spelling is the filesystem root `/` **or if its spelling resolves to `/`** — a symlink to `/` has the same effect, because containment is judged in the resolved coordinate and every absolute path on the host would then be inside a root. Both `/` refusals are made before any board is read, with distinct defect kinds so the two mistakes read differently. `collect list` needs none of this.

`resource list`'s trailing `collectible` label is a `resourceViews` label with no revision behind it: it is a view of the current board, useful for orientation. A collection answer is a verified revision and a re-check, and only that may delete.

## Safe handoff

1. Inspect the old issue's resources.
2. Add the follow-up open issue dependency first.
3. Verify the resource list output includes the follow-up dependency and shows it protected.
4. Only then close the old issue or remove the old dependency.

For example, hand off `/workspace/project-worktree` from Antonina board issue `412` to open follow-up issue `419`:

```sh
antonina board resource list --issue 412
antonina board resource add 419 lubko://phoebe-dev /workspace/project-worktree
antonina board resource list --issue 419
antonina board resource remove 412 lubko://phoebe-dev /workspace/project-worktree
```

Unregister a path when no issue needs it:

```sh
antonina board resource remove 419 lubko://phoebe-dev /workspace/project-worktree
```

Host values are `lubko://<server>` with no trailing slash; paths are canonical absolute POSIX paths.
