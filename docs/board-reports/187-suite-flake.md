# Board 187 — `npm test` red at the release line head

Front: continuation front on `fix/antonina-suite-flake`, base `8600cd41`.
Predecessor `187a1` died mid-diagnosis with findings only in its agent log.

Status: **in progress** (this file is written incrementally and committed as work lands).

---

## 1. The inherited claim, and why it was wrong

The issue title and `187a1`'s log both point at one test:

> "web vitest 5s timeout on tests that spawn a real vite build"

`187a1` measured `the build fails loudly when the generated identity is unusable` at
3686 ms / 360 ms / 399 ms isolated and 7923 ms inside the full run, and concluded
that one marginal test was the red.

**Re-measured, it is not one test. It is all four, and the premise "only that one
test is near the limit" is false.**

`npx vitest run build-identity-plugin --reporter=verbose`, clean tree at 8600cd41:

```
 × the emitted bundle names the revision it was built from          12821ms  → Test timed out in 5000ms
 × a dirty build says so in both places it is reported               27024ms  → Test timed out in 5000ms
 × the build fails loudly when the generated identity is unusable     7439ms  → Test timed out in 5000ms
 × the build fails when the commit is not an object name              9372ms  → Test timed out in 5000ms
 Test Files  1 failed (1)   Tests  4 failed (4)
```

The reason `9428` and `187a1` each saw exactly one failure in a full `npm test` run
is not that the other three are fast. It is that the whole file crosses the 5 s
threshold only when the host is loaded, and the load varies run to run. The
"one marginal test" reading is an artefact of sampling the threshold once.

There is no per-test timeout anywhere in this file, and no `testTimeout` in
`web/vite.config.ts`. **The 5 s is vitest's default.** So the defect is either
"the default is too small for this file" or "the harness is wrong".

---

## 2. Separating work from contention by measurement

The decisive technique is to compare **wall** against **CPU** for the same work.
CPU time is a property of the test; wall time is a property of the test *plus the
host*. Every number below is on this host, detached, serial, `fix/antonina-suite-flake`
at 8600cd41, via a harness that reproduces `sandbox()` + `build()` from
`web/build-identity-plugin.test.ts` byte for byte.

### 2a. Host state

```
nproc                 32
uptime                load average: 82.44, 78.78, 61.04
vmstat 1 5            r 70-84, b 5-6, us 79-85, sy 15-20, id 0, wa 3
/proc/pressure/cpu    some avg10=48.48 avg60=49.32   ← 48% of the time some task is stalled on CPU
/proc/pressure/io     some avg10=13.62 avg60=15.02
```

The machine is running at roughly **2.6× oversubscription with 0% idle**. That is
the "host load is high" that `187a1` reported, and it is real and out of my control.

### 2b. What the tests actually cost

`TIMEFORMAT='real %R user %U sys %S'`, three runs each, `/bin/bash time`:

| work | wall | user | sys | CPU |
|---|---|---|---|---|
| `node -e 0` (baseline) | 0.17 s | 0.02 | 0.02 | 0.04 s |
| `import('vite')` | 1.04 s | 0.20 | 0.05 | 0.25 s |
| `import('esbuild')` | 0.10 s | 0.04 | 0.02 | 0.06 s |
| esbuild binary `--version` | 0.25 s | 0.00 | 0.01 | 0.01 s |
| **full `vite build` (success)** | **11.0 / 14.5 / 13.4 s** | **3.05** | **0.35–0.45** | **~3.5 s** |
| **`vite build` failing at `buildStart`** | **6.4 / 6.5 / 8.2 / 9.0 s** | **0.27–0.29** | **0.10–0.83** | **~0.4 s** |

Sandbox setup (`sandbox()`: copy 8 entries + `packages/core`, symlink `node_modules`):
**277–606 ms wall**, and it is `cpSync` I/O, not CPU.

### 2c. Reading the numbers

* The **failing** tests cost **0.4 CPU-seconds** and take **6.4–9.0 s wall** — a
  **16–22× wall/CPU stretch**. A test cannot be CPU-starved 20× by a 32-core box at
  48% CPU pressure while using 0.4 s of CPU. That stretch is small-file **I/O**
  (13.6% io pressure, 5–6 blocked tasks, `/tmp` and `/workspace` on the same
  `/dev/mapper/myluks1` volume): vite loads a deep ESM module graph before
  `buildStart` ever runs.
* Fine-grained marks confirm the delay is *inside* `vite.build()`, not in test setup
  and not in the assertion:

  ```
  MARK script-start    +0ms
  MARK import-vite     +1277ms      ← matches the isolated 1.04s
  MARK build-threw     +8343ms      ← 7.07s inside vite.build() for ~0.1 CPU
  MARK exit            +8352ms
  ```

* The **passing** tests cost **~3.5 CPU-seconds** and take 11–14.5 s wall (4× stretch),
  and 12.8 s / 27.0 s as vitest actually observes them.

### 2d. Verdict

**Both (a) and (c) are true, and they are separable.**

* **(c) host contention is the proximate trigger.** 48% CPU pressure and 13.6% I/O
  pressure stretch these builds 4–22×. I cannot fix the host, and other fronts own it.
* **(a) the 5 s default is below the test's legitimate cost, and that is a real defect
  that exists with or without this host.** Full-build tests cost **~3.5 CPU-seconds**
  plus **~0.3–0.6 s** of `cpSync` sandbox setup ≈ **~4 CPU-seconds of irreducible work**.
  Vitest's 5000 ms default leaves roughly **1 s of headroom on a host with zero
  load and zero I/O wait**. A timeout that small is not a threshold, it is a coin
  flip: the suite is *expected* to be red on any machine that is not idle, and
  *expected* to be lucky on one that is. This is the defect to fix.
* **(b) there is also a genuine harness defect**, and it is the reason the guard is
  not merely small but **unenforceable** — see §3.

---

## 3. The harness defect: `spawnSync` makes the timeout unenforceable

`web/build-identity-plugin.test.ts` `build()` is:

```ts
function build(dir: string) {
  return spawnSync(process.execPath, [VITE_BIN, 'build'], {
    encoding: 'utf8',
    timeout: 300_000, cwd: dir, env: process.env,
  });
}
```

`spawnSync` **blocks the worker thread's event loop**. Vitest cannot interrupt a
synchronous test body; its timeout is only evaluated *after* the body returns, and
then it is applied as a post-hoc wall-clock comparison. Two consequences, both real:

1. The `timeout: 300_000` on the child is the **only** thing bounding a hung build. A
   hung `vite build` pins the worker for a full **5 minutes** and vitest cannot report
   or abort during any of it.
2. A 5 s test guard here is **decorative**. It cannot stop anything; it can only
   relabel a completed run as failed.

That is defect **(b)**: not a race or a leak, but a harness shape in which the
liveness guard does not guard. It also means the fix for (a) is not "type a bigger
number" — a bigger number would still be unenforced.

Additionally, the current harness has **no reaping story on abort**: because
`spawnSync` owns the child, there is no handle to kill if the test is ever abandoned.
`AGENTS.md` requires every spawned process to be converged and reaped.

### Ruled out, explicitly

* **Not a leaked child.** `spawnSync` returns only after the child exits. Measured:
  esbuild service processes before/after a build — no growth attributable to this
  suite. (One leaked `--service=0.25.12` esbuild was observed, but its path is
  `/workspace/antonina-171-resources/...`, another front's worktree, not this one.)
* **Not `NODE_ENV=test`/vitest-env contamination.** Standalone full build 11–14.5 s vs
  vitest-observed 12.8 s: same order. `env: process.env` is not distorting the build.
* **Not wasted sandbox copying.** 277–606 ms, and it is not in the 7.4–27 s.
* **Not a fixed sleep in the harness.** There is no sleep, retry or fixed delay in
  this file. The 6–9 s in the failing tests is vite's own ESM config/module load.

---

## 4. The repair

*(to be completed as it lands)*