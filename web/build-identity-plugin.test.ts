// Runs the real vite build over a minimal copy of the web app and asserts on the
// artifact it emits.
//
// A unit test that called `buildIdentityPlugin()` and inspected the returned
// object would pass even if the plugin were never registered in `vite.config.ts`,
// and would keep passing if vite stopped calling `generateBundle`. The only
// question worth asking is whether the emitted bundle names the revision it was
// built from, so this builds one and greps the output.
//
// The revision is supplied through the generated module rather than by arranging
// a Git repository with a chosen HEAD. A commit object name is a hash of content,
// so pinning one means amending until the hash matches, which costs tens of `git
// commit` rounds for no additional property: the path from a known commit to a
// bundle naming it is the same either way, and scripts/build-identity.test.mjs
// covers derivation from a real tree.
//
// The version and commit below are deliberately not any real value in this
// repository, so a pass cannot come from a constant that happens to be correct on
// this branch.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(webRoot, '..');

const EXPECTED_COMMIT = '1234567890abcdef1234567890abcdef12345678';
const EXPECTED_VERSION = '0.9.9';
const VITE_BIN = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');

// Only what a vite build of this app reads. `web/node_modules` is symlinked
// rather than copied: it is large and a symlink is enough for the bundler.
const SOURCES = [
  'index.html', 'package.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'vite.config.ts', 'build-identity-plugin.ts', 'src',
];

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The sandbox is laid out as a repository root rather than as a bare app
// directory, because web/src imports ../../packages/core/src/*. Copying the app
// alone builds a different graph than the deployed one.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'antonina-web-identity-'));
  sandboxes.push(root);
  const app = join(root, 'web');
  mkdirSync(app);
  for (const entry of SOURCES) cpSync(join(webRoot, entry), join(app, entry), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  cpSync(join(repoRoot, 'packages', 'core'), join(root, 'packages', 'core'), { recursive: true });
  symlinkSync(join(webRoot, 'node_modules'), join(app, 'node_modules'), 'dir');
  writeGeneratedModule(app, { dirty: false });
  return app;
}

/** Writes the generated module the way `npm run generate:build-identity` does. */
function writeGeneratedModule(dir: string, { dirty }: { dirty: boolean }) {
  writeFileSync(join(dir, 'build-identity.generated.ts'), `// GENERATED FILE - do not edit, do not commit.

export type BuildIdentitySource = 'git' | 'env';

export interface BuildIdentity {
  readonly version: string;
  readonly commit: string;
  readonly shortCommit: string;
  readonly dirty: boolean;
  readonly source: BuildIdentitySource;
}

export const WEB_BUILD_IDENTITY: BuildIdentity = {
  version: ${JSON.stringify(EXPECTED_VERSION)},
  commit: ${JSON.stringify(EXPECTED_COMMIT)},
  shortCommit: ${JSON.stringify(EXPECTED_COMMIT.slice(0, 12))},
  dirty: ${dirty},
  source: "env",
};

export interface WebBuildProvenance {
  readonly product: 'antonina';
  readonly surface: 'web';
  readonly version: string;
  readonly commit: string;
  readonly shortCommit: string;
  readonly dirty: boolean;
  readonly source: BuildIdentitySource;
}

export const WEB_BUILD_PROVENANCE: WebBuildProvenance = {
  product: 'antonina',
  surface: 'web',
  version: WEB_BUILD_IDENTITY.version,
  commit: WEB_BUILD_IDENTITY.commit,
  shortCommit: WEB_BUILD_IDENTITY.shortCommit,
  dirty: WEB_BUILD_IDENTITY.dirty,
  source: WEB_BUILD_IDENTITY.source,
};
`);
}

function patchGeneratedModule(dir: string, from: RegExp | string, to: string) {
  const module = join(dir, 'build-identity.generated.ts');
  writeFileSync(module, readFileSync(module, 'utf8').replace(from as RegExp, to));
}

// How long a single `vite build` may run before the harness kills it.
//
// This replaces vitest's inherited 5000 ms default, which was not a threshold but
// a coin flip: a successful build of this sandbox costs ~3.5 CPU-seconds and a
// build that fails at `buildStart` costs ~0.4 CPU-seconds (measured on an idle
// and on a loaded host; board 187 section 2), so 5 s left roughly one second of
// headroom above work the test genuinely has to do.
//
// The number is a CPU budget, not a wall-clock observation, so it is not tuned to
// this host's load. 90 s is ~25x the CPU the build needs. What makes it a real
// guard rather than a decoration is that it is now *enforced*: it kills the build
// (see `build` below) instead of being compared against a wall clock after the
// fact. A tighter ceiling would only reintroduce the flake; a loose one that is
// actually enforced still fails a hung build in bounded time.
const BUILD_TIMEOUT_MS = 90_000;

// How long a killed build is given to exit from SIGTERM before it is SIGKILLed.
// vite and esbuild both handle SIGTERM, so this normally reaps cleanly; the
// SIGKILL is the backstop that makes reaping unconditional.
const KILL_GRACE_MS = 5_000;

interface BuildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Process-group id of the build, kept so a caller can prove it was reaped. */
  pid: number | undefined;
}

/**
 * Runs `vite build` asynchronously, under an enforced deadline.
 *
 * `spawnSync` was the previous mechanism and it could not guard anything: it
 * blocks the worker's event loop, so no other code — vitest's timeout included —
 * gets a turn until the child has already exited. A hung build therefore pinned
 * the worker for the full `timeout:` passed to `spawnSync`, and the test timeout
 * could only relabel a finished run as failed.
 *
 * `spawn` returns a handle immediately, so the deadline is a real signal: it
 * reaches a live process. The child is started in its own process group
 * (`detached`) because vite spawns esbuild, and signalling only the group leader
 * would orphan the bundler. Both the deadline and the caller's own `AbortSignal`
 * converge through the same path, and this function does not settle until the
 * child has actually been reaped — `spawnSync` gave no such promise, and AGENTS.md
 * requires every spawned process to be converged and reaped.
 */
function build(
  dir: string,
  { signal, timeoutMs = BUILD_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BuildResult> {
  return new Promise<BuildResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [VITE_BIN, 'build'], {
      cwd: dir,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    // `detached` makes the child a process-group leader, so its pid is its pgid
    // and the negative form reaches vite *and* the esbuild service it started.
    // Signalling the leader alone is what leaves an esbuild behind.
    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // ESRCH means the group is already gone, which is the outcome we wanted.
      }
    };

    const clearTimers = () => {
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const escalate = () => {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      escalate();
    }, timeoutMs);
    deadline.unref();

    const onAbort = () => {
      aborted = true;
      escalate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    // 'close', not 'exit': it fires after the child's stdio pipes are drained, so
    // the output collected above is complete. Resolving here is also the only
    // place this function can settle, which is what makes the reaping guarantee
    // unconditional rather than a convention.
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectPromise(err);
    });
    child.on('close', (status, sig) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (aborted) {
        rejectPromise(new Error('vite build was aborted by the caller'));
        return;
      }
      resolvePromise({ status, signal: sig, stdout, stderr, timedOut, pid: child.pid });
    });
  });
}

/** A build that overran `BUILD_TIMEOUT_MS` is a harness failure, not a build outcome. */
async function buildOrFail(
  dir: string,
  { signal, timeoutMs = BUILD_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BuildResult> {
  const result = await build(dir, { signal, timeoutMs });
  if (result.timedOut) {
    throw new Error(
      `vite build exceeded the enforced ${timeoutMs} ms deadline and its process group was killed; ` +
      'it is hung, not slow',
    );
  }
  return result;
}

const dist = (dir: string, ...parts: string[]) => join(dir, 'dist', ...parts);

describe('web build identity', () => {
  it('the emitted bundle names the revision it was built from', async () => {
    const dir = sandbox();
    const result = await buildOrFail(dir);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const provenanceText = readFileSync(dist(dir, 'version.json'), 'utf8');
    expect(JSON.parse(provenanceText)).toEqual({
      product: 'antonina',
      surface: 'web',
      version: EXPECTED_VERSION,
      commit: EXPECTED_COMMIT,
      shortCommit: EXPECTED_COMMIT.slice(0, 12),
      dirty: false,
      source: 'env',
    });
    // The identity is text in a served file, which is what makes a deployed
    // bundle identifiable from a URL without a build of the repository.
    expect(provenanceText).toContain(EXPECTED_COMMIT);

    expect(readFileSync(dist(dir, 'index.html'), 'utf8'))
      .toMatch(new RegExp(`<meta name="antonina:build" content="${EXPECTED_VERSION}\\+${EXPECTED_COMMIT.slice(0, 12)}">`));
  });

  it('a dirty build says so in both places it is reported', async () => {
    const dir = sandbox();
    patchGeneratedModule(dir, 'dirty: false,', 'dirty: true,');
    const result = await buildOrFail(dir);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(dist(dir, 'version.json'), 'utf8')).dirty).toBe(true);
    expect(readFileSync(dist(dir, 'index.html'), 'utf8'))
      .toContain(`content="${EXPECTED_VERSION}+${EXPECTED_COMMIT.slice(0, 12)}-dirty"`);
  });

  it('the build fails loudly when the generated identity is unusable', async () => {
    // The generator refuses to write a bad identity, so this is the other door
    // into the same failure: a hand-edited or stale module. A bundle claiming an
    // unverifiable revision is worse than one claiming nothing, so the build stops.
    const dir = sandbox();
    patchGeneratedModule(dir, /shortCommit: "[0-9a-f]+"/, 'shortCommit: "not-a-prefix"');

    const result = await buildOrFail(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/identity is unusable|cannot be traced to a revision/);
    expect(existsSync(dist(dir, 'version.json'))).toBe(false);
  });

  it('the build fails when the commit is not an object name', async () => {
    const dir = sandbox();
    patchGeneratedModule(dir, /commit: "[0-9a-f]{40}"/, 'commit: "not-a-sha"');
    const result = await buildOrFail(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not a 40-character object name/);
  });

  // Non-vacuity for the guard above. A deadline that cannot fire is not a
  // deadline, so this asserts that one does: it hands `build` a config that never
  // resolves and a short deadline, and requires the deadline to kill the process
  // group and reap it. Under the previous `spawnSync` harness this was not merely
  // absent but impossible — the blocking call could not be preempted at all, and
  // a hung build held the worker for the full `timeout:` with no handle to kill.
  it('the deadline kills a hung build and reaps its process group', async () => {
    const dir = sandbox();
    // A plugin whose `buildStart` never settles, holding the event loop open so the
    // process cannot wind down and rollup's beforeExit check cannot rescue it. That
    // makes this a build which genuinely never finishes, not one which fails fast.
    writeFileSync(join(dir, 'vite.config.ts'), `export default {
  plugins: [{
    name: 'hang',
    buildStart() {
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    },
  }],
};
`);

    const startedAt = process.hrtime.bigint();
    const result = await build(dir, { timeoutMs: 3_000 });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(result.timedOut, 'a build that never resolves must be reported as timed out').toBe(true);
    expect(result.signal, 'the build must be killed, not left running').not.toBeNull();

    // Bounded: the deadline fired, the SIGTERM/SIGKILL escalation finished, and the
    // harness waited for the reap. If the kill did not work this await cannot return,
    // so the assertion is the elapsed bound as much as it is the flags.
    expect(elapsedMs).toBeLessThan(3_000 + 5_000 + 10_000);

    // AGENTS.md: a spawned process must be converged and reaped. The group leader
    // is the only handle we exposed, so that is what is checked — signalling the
    // group is what keeps the esbuild service it may have started from surviving.
    expect(result.pid).toBeGreaterThan(0);
    expect(() => process.kill(result.pid as number, 0), 'the build process group outlived the harness')
      .toThrow();
  });
});
