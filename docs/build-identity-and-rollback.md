# Build identity and rollback

Board issue 76. This document is the operational half of that issue: how to
identify the running build, and how to return to the previous known-good one.

The code half is `scripts/build-identity.mjs`, which derives the identity from
Git and the package manifests at build time, and `web/build-identity-plugin.ts`,
which writes it into the web bundle. Nothing in this repository declares a
version-and-commit pair by hand.

## Identifying what is running

### The CLI

```sh
antonina --version          # or -V
antonina --version --json   # same identity, machine-readable
```

Output is four fields and the process exits 0:

```
antonina 0.1.2 (079a5cc91776)
version 0.1.2
commit 079a5cc91776ed5fe4079c116ede2fd704fc4424
commit-source git
```

`commit` is the full 40-character object name. A 12-character prefix is a prefix;
matching it against a deployment record is not an identity. A build from a tree
with tracked modifications additionally prints `dirty true` and marks the short
commit `-dirty`, so a local build is never mistaken for a released one.

`--version` is a success. It exits 0. A real usage error, including
`antonina --version stray-argument`, exits 2. If you are scripting this:

```sh
set -e
revision="$(antonina --version --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).commit')"
```

### The web UI

Two places, both readable without a build of this repository:

```sh
curl -s https://vau.place/a/antonina/version.json
```

```json
{
  "product": "antonina",
  "surface": "web",
  "version": "0.1.0",
  "commit": "079a5cc91776ed5fe4079c116ede2fd704fc4424",
  "shortCommit": "079a5cc91776",
  "dirty": false,
  "source": "git"
}
```

And the served page carries the same identity as an `antonina:build` meta tag,
visible in devtools or in a diagnostics screenshot:

```html
<meta name="antonina:build" content="0.1.0+079a5cc91776">
```

`version.json` is the rollback-relevant one. The meta tag is for correlating a
screenshot with a revision; it carries the short commit only.

The CLI and the web report their own package's version and a shared commit. At
this revision those are 0.1.2 and 0.1.0 respectively, because
`packages/cli/package.json` and `web/package.json` declare different versions.
That disagreement is pre-existing and is recorded as its own follow-up rather
than fixed here: the two numbers are read from their own manifests, so each
surface is reporting the truth about itself, and a rollback target is chosen on
`commit`, which is unambiguous.

## What happens when Git metadata is unavailable

The commit is resolved from the first of these that yields one:

1. `ANTONINA_BUILD_COMMIT`, when set to a full 40-character lowercase object name.
2. `git rev-parse HEAD` in the repository root.

If neither yields one, the build **fails** with a non-zero exit and a message
naming both. There is no `unknown` sentinel and no fallback. This is deliberate:
an artifact that cannot name its revision is the exact condition this issue was
filed against, and producing one silently is worse than refusing to build.

This is not a fragility in the deploy path. `.github/workflows/web-deploy.yml`
passes the checked-out revision in explicitly:

```yaml
-e ANTONINA_BUILD_COMMIT="$GITHUB_SHA"
```

so the deploy never depends on a usable `.git` inside the builder container. A
builder image with a dirty or absent `.git` still produces a correctly identified
artifact, because the value comes from the workflow rather than from the
container's working copy.

A malformed `ANTONINA_BUILD_COMMIT` is an error, not a reason to fall through to
Git. Falling through would let a typo produce a build carrying a different
revision than the caller asked for, with nothing reporting the substitution.

`dirty` is asked of Git even when the commit came from the override, because
dirtiness is a property of the working tree. Where Git is entirely unavailable,
`dirty` is reported `false` and `commit-source` is `env`, which together say
"this came from an explicit value, and tree state was not inspected".

Locally, a build from a non-Git checkout must set the variable:

```sh
ANTONINA_BUILD_COMMIT="$(git rev-parse HEAD)" npm run build
```

## Rollback

Two deployments, two procedures. In both, the target is chosen by **commit**,
never by version string: a version can be re-tagged, a commit cannot.

### The previous known-good targets at this revision

Named here because the point of the issue is that this should not have to be
reconstructed during an incident:

| Surface | Current | Previous known-good | Anchor |
| --- | --- | --- | --- |
| CLI | `0.1.2` at `079a5cc` | `0.1.1` at `65caa73` | tag `v0.1.1` |
| CLI (further back) | | `0.1.0` at `6a7c832` | tag `v0.1.0` |
| Web | `0.1.0` at `079a5cc` | `65caa73` | ancestor of `origin/main` |

`v0.1.1` and `v0.1.0` are both ancestors of `origin/main`, so both are known-good
and both are reachable. `65caa73` is the merge that carries the 0.1.1 web and CLI
state, and it is the immediate predecessor of the current release line for
rollback purposes.

Confirm a target before rolling back to it:

```sh
git merge-base --is-ancestor v0.1.1 origin/main && echo "reachable"
```

### Rolling back the CLI

The CLI ships as a tarball built by `npm pack ./packages/cli`. There is no
registry, so a rollback is: check out the target, pack, install over the existing
install, and verify the identity came back.

```sh
git -C /path/to/antonina fetch origin
git -C /path/to/antonina checkout --detach v0.1.1
npm -C /path/to/antonina run bootstrap     # installs web/node_modules for tsc
npm -C /path/to/antonina run typecheck     # emits packages/cli/dist
npm -C /path/to/antonina pack ./packages/cli --pack-destination /tmp
```

Then, on the affected host, over the existing installation:

```sh
npm install --prefix /path/to/antonina-install /tmp/antonina-cli-0.1.1.tgz
```

Verify, and only then consider the rollback done:

```sh
/path/to/antonina-install/node_modules/.bin/antonina --version
# must print version 0.1.1 and commit 65caa735bbf00fab3acf092784d93e86fcc45280
```

Two things this procedure depends on, stated plainly because they are what make
it fail:

- **The host has a build toolchain.** `typecheck` emits `dist`, so rolling back
  means building on a host with Node 22+ and the web toolchain bootstrapped. If
  the host cannot build, pack the tarball on a machine that can and copy it; the
  installed artifact does not need the toolchain, only the packing host does.
- **The target commit typechecks.** A rollback to a commit whose tree no longer
  builds is not a rollback. `npm run typecheck` above is the check, and it is
  worth running before touching the affected host rather than during the incident.

Then restore the source tree:

```sh
git -C /path/to/antonina checkout -
```

### Rolling back the web

The web bundle is deployed to the Skrynia namespace `antonina` at
`https://vau.place/_skrynia` by `.github/workflows/web-deploy.yml`. The deploy
step is `ottojung/Skrynia/action/deploy` with `subdir: .`, and it deploys
whatever is in the working tree at the workflow's commit.

**Identify the current deployment first.** This is the step the 0.1.0 → 0.1.1
incident had to reconstruct, and after this issue it is one request:

```sh
curl -s https://vau.place/a/antonina/version.json
```

If that file is absent, the running deployment predates this change and its
revision **cannot** be determined from the namespace's served content. It then
has to come from the namespace's own revision history: the Skrynia namespace's
list of deployed revisions, compared against `git log origin/main` to find the
commit matching the deployment timestamp. That depends on the namespace retaining
its revision history; it is a property of Skrynia, not of this repository, and it
is the reason the deployed `version.json` exists. Do not assume it is available.

**Then redeploy the target commit.** The deploy workflow triggers on a push to
`main`; a `workflow_dispatch` on the workflow file redeploys whatever commit the
workflow run is checked out at. To return to a specific revision, check that
revision out in a local clone, run `make build` to produce the bundle, and
confirm the bundle identifies itself before it is deployed:

```sh
git clone /path/to/antonina /tmp/rollback
git -C /tmp/rollback checkout --detach 65caa73
make -C /tmp/rollback build
cat /tmp/rollback/build/version.json    # must name 65caa735bbf00fab3acf092784d93e86fcc45280
```

Then dispatch the deploy workflow at that commit through GitHub, or hand the
built `build/` directory to the Skrynia deploy action with the same inputs the
workflow uses (`namespace: antonina`, `subdir: .`,
`builder: ghcr.io/ottojung/skrynia-builder:1.0.0-122-g9829feb`). Deploying a
tarball of `build/` directly bypasses the build the workflow would have run, so
prefer dispatching the workflow.

Finally, verify the rollback landed:

```sh
curl -s https://vau.place/a/antonina/version.json
# must print the rolled-back commit
```

`docs/build-identity-and-rollback.md` records the revision in the deployed
artifact, so a completed rollback is observable without any further repository
work. If this check does not print the target commit, the rollback did not
happen, whatever the deploy step reported.

### Known limits of this procedure

- There is no `gh` on the development host, so the dispatch step in the web
  rollback has not been executed here. The build-and-inspect half has; see the
  commit message for what was run.
- The previous known-good web deployment is identified by commit from the
  namespace's revision history when `version.json` is absent. That history is
  Skrynia's to retain or lose, and nothing in this repository can make it exist
  for deployments that predate this change.
- Neither rollback is a release-management system. There are no channels, no
  promotion, and no artifact store; a rollback is a rebuild at a named commit
  plus a check that the identity came back.
