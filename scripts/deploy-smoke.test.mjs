// The post-deploy smoke probe, exercised against a real application.
//
// Board issue 74. The acceptance criterion for this probe is negative: a
// deployment that serves its HTML perfectly but cannot load the board must
// make it exit non-zero. That cannot be argued from a reading of the code, so
// this suite serves the actual built bundle and the actual signed board, and
// asserts both directions against a real headless Chromium:
//
//   - healthy: the app starts, verifies the board, and renders issues and feed
//     entries, so the probe passes and the *process* exits 0;
//   - broken: the same bytes of HTML, JS and CSS, with the board store broken
//     underneath, so the probe fails and the *process* exits 1, carrying the
//     application's own error text rather than a status code.
//
// The broken cases are the 0.1.1 failure modes specifically. `curl --fail` on
// index.html passes for every one of them.
//
// Everything here is local and disposable: an ephemeral port, a throwaway
// browser profile, a board created in this process and thrown away with it. No
// Antonina state directory is read or written, and nothing leaves the host.
//
// What this suite needs, and what it will not do for itself:
//
//   - a built web bundle (`npm run build --prefix web`). The three browser cases
//     serve it, because a post-deploy artifact check has to run against the real
//     production build. The suite asserts it is there and says how to produce
//     it; it never builds one, and never writes generated sources into the
//     working tree from inside a test.
//   - a Chrome and a matching chromedriver, for the same three cases.
//
// Machine-readable, and read by `scripts/root-chain.test.mjs`: this suite
// declares the preconditions it cannot meet on a bare checkout, so the root
// chain's expansion check can see why it must not reach this file. The
// `antonina-test-needs:` token is exact; the prose above is not read by
// anything.
//
// It is therefore NOT in the root `npm test` chain, which every other suite
// must stay runnable without a browser or a build. The CI job that provisions
// both and runs this suite is `smoke-probe` in `.github/workflows/ci.yml`; a
// missing browser there is a failure, not a skip, because a skip would report
// "the probe was never exercised" as a green run.
//
// The other cases here — the DOM-to-state classification, the unspawnable
// driver, the timeout paths — need neither, so they run on a bare checkout and
// can be reached with `node --test --test-name-pattern=...`.
//
// antonina-test-needs: browser, chromedriver, built-web-bundle

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import {
  runProbe, judgeBoard, judgeFeed, parseArgs, classifyObservation, overallBudgetMs,
  ProbeUsageError, ProbeTimeout, SmokeFailure, APP_STATE_TITLES, OBSERVE_BOARD,
  BOARD_CREDENTIAL_STORAGE_KEY, BOARD_TRUST_STORAGE_KEY,
  BOARD_CREDENTIAL_KEYS, BOARD_TRUST_ANCHOR_KEYS,
} from './deploy-smoke.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDist = join(repoRoot, 'web', 'dist');
const probeScript = join(repoRoot, 'scripts', 'deploy-smoke.mjs');
const APP_PATH = '/a/antonina/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * The built bundle, as a documented precondition rather than something a test
 * produces.
 *
 * The probe is a post-deploy artifact check, so it has to run against the real
 * production build output and not a dev server or a test double. An earlier
 * revision of this suite ran `build-identity.mjs` and a full
 * `npm run build --prefix web` from inside this hook, which wrote generated
 * sources into the working tree and could run for minutes inside a 300s
 * timeout. That is now the CI step's job (`.github/workflows/ci.yml`, the
 * `smoke-probe` job), and this asserts the precondition instead: a missing
 * bundle is a clear instruction, not a silent rebuild that makes the suite
 * pass on a machine nobody chose to build.
 */
function requireWebBuild() {
  assert.ok(
    existsSync(join(webDist, 'index.html')),
    'the smoke probe suite needs the built web bundle: run `npm run build --prefix web` first '
    + '(CI does this in the smoke-probe job).',
  );
}

/**
 * A local Antonina: the built board app plus a Skrynia-shaped store, on one
 * origin, exactly as the deployment serves them.
 *
 * `boardMode` is what the deployment can do to the store underneath a perfectly
 * good page, and it is the only thing the broken cases change:
 *   'ok'          - the signed board is served as committed
 *   'tampered'    - the board pointer's signed head is rewritten in transit, so
 *                   signature verification must refuse it
 *   'server-error'- the store answers 500 with a body that is not a board
 *
 * The store itself is `packages/core/test/fake-skrynia.mjs` — the repository's
 * own Skrynia fake, the one `packages/core` is tested against — served over
 * real HTTP. It is deliberately not reimplemented here. An earlier revision of
 * this fixture hand-rolled a v2-only `board-v2` endpoint; when the store moved
 * to a sharded v3 layout that fixture answered 404 to every immutable object,
 * so `store.initialize()` died before a browser was ever started and all four
 * browser cases were red for a reason in the fixture rather than in the probe.
 * Reusing the one definition of Skrynia's semantics is what keeps this honest
 * as the store changes; the only thing added on top is how a *broken
 * deployment* answers.
 */
/** Every local instance, so a fixture that fails halfway is still torn down. */
const openInstances = [];

async function startLocalAntonina(boardMode) {
  const { BoardApi } = await import(join(repoRoot, 'packages', 'core', 'dist', 'api.js'));
  const { SignedBoardStore } = await import(join(repoRoot, 'packages', 'core', 'dist', 'board-store.js'));
  const { credentialTrustAnchor, serializeBoardTrustAnchor, serializeBoardCredential } = await import(join(repoRoot, 'packages', 'core', 'dist', 'credential.js'));
  const { fakeSkrynia } = await import(join(repoRoot, 'packages', 'core', 'test', 'fake-skrynia.mjs'));

  // The failure mode is switched on only after the fixture board is committed,
  // so a broken deployment is a board that was fine and then stopped working,
  // not a board this fixture never managed to create.
  let broken = false;
  const skrynia = fakeSkrynia();
  // What the store actually served, and what the tamper hook actually altered, so
  // a test can assert the hook matched rather than assume it did.
  const served = new Set();
  const tampered = new Set();

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      // A fixture that fails mid-request must say so in the response the caller
      // can read, not by throwing out of a stream callback where nothing sees it.
      process.stderr.write(`smoke fixture ${request.method} ${request.url} failed: ${error?.stack ?? error}\n`);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: String(error && error.message) }));
    });
  });
  const close = () => new Promise((done) => server.close(done));
  openInstances.push(close);

  function readBody(request) {
    return new Promise((done, fail) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
      request.on('error', fail);
    });
  }

  /** The last path segment: the Skrynia object key, still percent-encoded. */
  function keyOf(pathname) {
    return decodeURIComponent(pathname.split('/').at(-1));
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (url.pathname === '/_skrynia/health') return send(200, { ok: true });
    if (url.pathname.startsWith('/_skrynia/store/antonina/')) {
      const isRead = request.method === 'GET';
      if (broken && isRead && boardMode === 'server-error') {
        return send(500, { error: 'skrynia storage backend unavailable' });
      }
      const body = await readBody(request);
      const answer = await skrynia.fetch(request.url, {
        method: request.method,
        headers: new Headers(request.headers),
        body: body === '' ? undefined : body,
      });
      // `Response.body` is a stream; what this server has to write is the text.
      const text = await answer.text();
      // The 0.1.1 shape: the app is served fine, the board under it cannot be
      // verified. The signed head is rewritten on the way out, so the signature
      // no longer covers what is being served. It is rewritten in transit rather
      // than in the store, so what is stored stays valid and the only thing that
      // is broken is the deployment serving it.
      if (broken && isRead && boardMode === 'tampered' && keyOf(url.pathname) === 'board-v2') {
        served.add(keyOf(url.pathname));
        const altered = withTamperedHead(text);
        if (altered !== null) {
          tampered.add(keyOf(url.pathname));
          const etag = answer.headers.get('ETag');
          return send(200, altered, etag === null ? {} : { ETag: etag });
        }
      }
      const etag = answer.headers.get('ETag');
      response.writeHead(answer.status, {
        'Content-Type': answer.headers.get('Content-Type') ?? 'application/json',
        ...(etag === null ? {} : { ETag: etag }),
      });
      return response.end(text);
    }
    if (url.pathname.startsWith(APP_PATH)) return serveStatic(url.pathname, response);
    return send(404, { error: 'not found' });
  }

  /**
   * A served object with a signed field altered, or null if it is not one.
   *
   * This has to name the object that is actually signed, and it used not to. An
   * earlier revision rewrote an `issue.create` payload in the v2 signed log;
   * the store has since moved to materialized v3 snapshots, where the log is
   * gone and an issue lives at `issue` inside an immutable `board-v3-*` object.
   *
   * The v3 revision first rewrote the *snapshot*, and that was wrong in a way
   * that mattered: `ShardedBoardStore.getJson` verifies neither a content hash
   * against the key nor a signature over the body, so a rewritten snapshot is
   * accepted silently and the app renders the attacker's title. The probe
   * passed against a deployment that was serving a board nobody signed. That is
   * a fail-open in the worst direction and no reading of the probe finds it.
   *
   * What the v3 layout does sign is the `board-v2` *pointer*, through its
   * `head`: that is the signed log head the whole snapshot set hangs off. So
   * this alters `head` on the pointer, leaving the snapshots perfectly valid
   * and reachable — the failure is then exactly "the signature does not cover
   * what is being served", which is what the case is named for.
   */
  function withTamperedHead(body) {
    let value;
    try { value = JSON.parse(body); } catch { return null; }
    if (value === null || typeof value !== 'object' || typeof value.head !== 'string') return null;
    const altered = structuredClone(value);
    // One character changed, so this is still a well-formed digest reference
    // and the failure cannot be mistaken for a malformed store.
    altered.head = `sha256:${altered.head.slice('sha256:'.length, -1)}${altered.head.endsWith('A') ? 'B' : 'A'}`;
    return altered;
  }

  function serveStatic(pathname, response) {
    const requested = normalize(pathname.slice(APP_PATH.length)).replace(/^(\.\.(\/|\\|$))+/, '');
    const isDirectoryRequest = requested === '' || requested === '.' || requested.endsWith('/');
    const relative = (isDirectoryRequest ? (requested === '.' ? '' : requested) + 'index.html' : requested);
    const file = join(webDist, relative);
    if (!file.startsWith(webDist) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      return response.end('not found');
    }
    response.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  }

  // Reading a body from a request without a body library: the store writes are
  // small, and the fixture only ever needs the whole of one.
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // Real board, real signing, real verification: this fixture uses the same core
  // code the browser bundle uses, over the same HTTP shape.
  const board = new SignedBoardStore({ baseUrl: `${origin}/_skrynia` });
  const initialized = await board.initialize();
  const trustAnchor = credentialTrustAnchor(initialized.credential);
  const client = new BoardApi({ baseUrl: `${origin}/_skrynia`, credential: initialized.credential, trustAnchor });
  const first = await client.createIssue('Smoke: the board must load', 'The probe reads this board and nothing else.');
  await client.comment(first.number, 'smoke', 'A comment, so the feed has an entry that is not a creation.');
  await client.createIssue('Smoke: a second issue', 'so the queue and the filters have something to show');
  broken = true;

  return {
    origin,
    // The live sets, not copies of them: the reads that carry these objects are
    // the application's, and they happen after this function has returned.
    served,
    tampered,
    url: `${origin}${APP_PATH}`,
    trustAnchor: serializeBoardTrustAnchor(trustAnchor),
    // Both secrets, because the deployed probe needs both: an anchor permits
    // verification only, and readStored refuses a read with no credential.
    boardCredential: serializeBoardCredential(initialized.credential),
    close,
  };
}

function probeOptions(local, extra = {}) {
  return {
    url: local.url,
    trustAnchor: local.trustAnchor,
    boardCredential: local.boardCredential,
    chromedriver: process.env.CHROMEDRIVER ?? 'chromedriver',
    timeout: 40_000,
    minIssues: 1,
    minFeed: 1,
    ...extra,
  };
}

/**
 * Runs the probe the way the deploy workflow does: as a separate process, and
 * reads its real exit code.
 *
 * Asynchronous on purpose. The local Antonina this probes lives in *this*
 * process, so a synchronous spawn would block the event loop that has to serve
 * it, and the probe would wait for a page this process can no longer answer.
 */
function runProbeProcess(local, extraArgs = []) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [
      probeScript,
      '--url', local.url,
      '--trust-anchor', local.trustAnchor,
      '--board-credential', local.boardCredential,
      '--timeout', '40000',
      ...extraArgs,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

let healthy;
let tampered;
let brokenStore;

/**
 * Rejects with `message` if `promise` has not settled within `ms`.
 *
 * `node --test` has **no default timeout**. A test that awaits a promise which
 * only settles if the code under test is correct does not fail when that code
 * is deleted — it hangs, and in CI that is a job sitting at "in progress" until
 * the six-hour runner limit, not a red line. Every test here that waits for a
 * bound *the probe itself* has to enforce therefore races an explicit one, so
 * removing a bound is a failing assertion rather than a stalled job. The
 * `setTimeout` is unref'd so it can never hold the process open on its own.
 *
 * `thunk` is called lazily so the raced work actually starts; racing a function
 * instead of its result would settle instantly and make every one of these
 * assertions vacuous.
 */
function withinDeadline(thunk, ms, message) {
  let timer = null;
  const expiry = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${message} (waited ${ms}ms)`)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(thunk), expiry]).finally(() => clearTimeout(timer));
}

const BUDGET_DID_NOT_FIRE = 'the overall budget did not end the run';

test('a page-side wait that runs out is reported as the wait that ran out', { timeout: 60_000 }, async () => {
  // The residual the re-review recorded but did not close: both page-side
  // `waitFor` calls used to catch their own timeout and carry on to observe the
  // page anyway. That was fail-closed — an unsettled page classifies as a
  // failure — but it reported the *wrong* failure, telling an operator the board
  // could not be loaded when the truth was that the application never finished
  // starting. Here the driver answers every call and the application stays on
  // its loading screen forever, so only the wait's own deadline can end the run.
  const dir = mkdtempSync(join(tmpdir(), 'antonina-probe-fixture-'));
  const fake = join(dir, 'chromedriver');
  writeFileSync(fake, `#!/usr/bin/env node
const { createServer } = require('node:http');
const port = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=0').slice('--port='.length));
process.stderr.write('fake chromedriver answering every call\\n');
const send = (response, value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value })); };
let chunks = '';
createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/session') return send(response, { sessionId: 'sess-1' });
  request.on('data', (chunk) => { chunks += chunk; });
  request.on('end', () => {
    const body = chunks;
    chunks = '';
    // Storing the anchor works; every executed script returns false, so the
    // application is never observed to have finished starting.
    if (body.includes('localStorage.setItem')) return send(response, true);
    send(response, false);
  });
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });

  try {
    await assert.rejects(
      () => withinDeadline(() => runProbe({
        url: 'http://127.0.0.1:1/',
        trustAnchor: '{"boardId":"b","rootKeyId":"ed25519:' + 'A'.repeat(43) + '","rootPublicKey":"B"}',
        chromedriver: fake,
        timeout: 2_000,
        overallTimeout: 600_000,
        minIssues: 1,
        minFeed: 1,
      }), 30_000, 'the page-side wait did not end the run'),
      (error) => {
        assert.ok(error instanceof ProbeTimeout, `expected a ProbeTimeout, got ${error}`);
        // The page-side wording, not the per-call or the budget one.
        assert.match(error.message, /timed out waiting for the application to finish starting/);
        assert.doesNotMatch(error.message, /the probe to finish within/);
        return true;
      },
    );
  } finally {
    // In a `finally`, not after the assertion: a *failing* run must not leave
    // its fake driver behind, and that is exactly the run that fails. Fourteen
    // of these directories were found in tmpdir() for this reason before the
    // suite had ever been green.
    rmSync(dir, { recursive: true, force: true });
  }
});
// --- what the root gate is and is not required to have ---------------------
// Error 4 of the review was that appending this suite to the root `npm test`
// chain gave the root gate a browser, a chromedriver and a built-bundle
// precondition. The suite was then taken out of the chain, but "taken out of
// the chain" was, until now, a comment and a hope: nothing inspected either
// file, so re-appending the suite — or deleting the CI job that runs it — would
// have left CI green and the probe exercised by nobody again, which is the
// exact condition the review raised. These two cases are the assertion.

// This case used to assert the root chain's *text*: it looked for the literal
// string `test:deploy-smoke` in `pkg.scripts.test`, and for any script whose
// command mentions `deploy-smoke`. That approved a chain that did in fact
// reach this suite, because the step that reached it was
// `node --test scripts/*.test.mjs` — a glob, containing neither string. Board
// 74 added this file to `scripts/`, the root chain went from 10 tests to 37,
// and 27 of them need a real browser, a matching chromedriver and a built
// `web/dist`. The guard approved all of it, and it approved it by reading text
// where the defect was a file set.
//
// The guard now lives in `scripts/root-chain.test.mjs`, which expands the
// chain's globs against the working tree and asserts on the resulting paths. It
// is in the root chain itself, so it runs on a bare checkout with no browser —
// which is the only environment in which a bare-checkout contract can be
// checked. What is asserted here is what can be asserted from inside a suite
// that itself needs a browser: the exclusion, and the deliberate reachability.
test('the root npm test chain does not require a browser or a built bundle', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const chain = pkg.scripts.test;
  assert.ok(!chain.includes('test:deploy-smoke'), `the root \`npm test\` chain runs the deploy smoke suite: ${chain}`);
  // And the suite is still reachable, deliberately, by name.
  assert.equal(pkg.scripts['test:deploy-smoke'], 'node --test scripts/deploy-smoke.test.mjs');
  // Nothing else in the chain may smuggle the browser back in. Still a text
  // check, and still worth keeping as a cheap tripwire — but it is no longer
  // the gate; the expansion check in `scripts/root-chain.test.mjs` is, and
  // this case cannot stand in for it.
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'test' || name.startsWith('//') || name === 'test:deploy-smoke') continue;
    assert.ok(
      !/deploy-smoke/.test(command) || !chain.includes(name),
      `${name} pulls the deploy smoke suite into the root chain`,
    );
  }
  // The gate that matters, named from here so that a reader of this file does
  // not conclude that the checks above are the whole protection. It is not:
  // this suite is not in the root chain, so it cannot guard the root chain.
  assert.ok(
    existsSync(join(repoRoot, 'scripts', 'root-chain.test.mjs')),
    'scripts/root-chain.test.mjs is missing; the root chain has no expanding bare-checkout gate',
  );
  assert.ok(
    pkg.scripts['test:build-identity'].includes('scripts/root-chain.test.mjs'),
    'the expanding gate is not in the root `npm test` chain, so nothing runs it on a bare checkout',
  );
});

test('the deploy smoke suite is gated by a CI job that provisions a browser', () => {
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /^ {2}smoke-probe:/m, '.github/workflows/ci.yml has no smoke-probe job');
  // It must run the suite, and it must fail — not skip — when the browser is
  // missing, because a skip reports "the probe was never exercised" as green.
  const job = ci.slice(ci.search(/^ {2}smoke-probe:/m));
  assert.match(job, /test:deploy-smoke/);
  assert.doesNotMatch(job, /continue-on-error/);
  assert.doesNotMatch(job, /if:.*always\(\)/);
  assert.match(job, /build --prefix web/, 'the job does not produce the built bundle the suite needs');
  // And the probe's exit codes must not be discarded anywhere in CI.
  assert.doesNotMatch(ci, /deploy-smoke\.mjs[^\n]*\|\|\s*true/);
});

// The workflow that actually deploys, asserted as well as ci.yml. The previous
// wiring case read only ci.yml, and the review's Error 1 landed in the deploy
// workflow for exactly that reason: the job covered was the one that exercises
// the probe's *suite*, while the job that runs the probe itself on a real
// deployment was covered by nothing at all.
test('the deploy workflow provisions a browser for the probe, the way ci.yml does', () => {
  const deploy = readFileSync(join(repoRoot, '.github', 'workflows', 'web-deploy.yml'), 'utf8');
  // A missing browser is a hard failure, never a skip, or a run reports "the
  // probe was never exercised" as green.
  assert.match(deploy, /command -v chromedriver/, 'the deploy job never checks for chromedriver');
  assert.match(
    deploy,
    /if \[ -z "\$\{browser:-\}" \]; then[\s\S]*?exit 1/,
    'the deploy job does not fail loudly when no browser is on PATH',
  );
  assert.match(
    deploy,
    /ANTONINA_CHROMIUM_BINARY=\$\(command -v "\$browser"\)/,
    'the deploy job does not hand the probe the browser it provisioned',
  );
});

test('the deploy step reports a probe that could not run differently from a board that could not be read', () => {
  // Executed, not read. The whole point of the review's Error 1 is that the
  // wrong wording is *invisible* in a reading of the workflow — it looks
  // deliberate — and the only thing that catches it is running the step's own
  // shell with a probe that exits 2 and reading the summary it wrote.
  const summary = runDeploySmokeStep({ probeExit: 2 });
  assert.equal(summary.status, 2, `expected the step to fail with the probe's status\n${summary.stdout}${summary.stderr}`);
  assert.match(summary.step, /could not run/i, 'an exit 2 is not reported as a probe that could not run');
  assert.doesNotMatch(
    summary.step,
    /the board could not be read/,
    'an exit 2 is reported as an unreadable board, which is the misdiagnosis the probe exists to prevent',
  );

  const broken = runDeploySmokeStep({ probeExit: 1 });
  assert.equal(broken.status, 1);
  assert.match(broken.step, /the board could not be read/, 'an exit 1 is not reported as an unreadable board');
  assert.doesNotMatch(
    broken.step,
    /could not run/i,
    'an exit 1 is reported as a probe that could not run, so a real board failure would be blamed on the runner',
  );

  // And the pass path still says what the probe said, with no verdict invented.
  const healthy = runDeploySmokeStep({ probeExit: 0 });
  assert.equal(healthy.status, 0);
  assert.doesNotMatch(healthy.step, /FAILED/);
  assert.match(healthy.step, /probe: loaded/, 'the pass path drops the probe output it is given');
});

/**
 * The `run:` body of the deploy workflow's Smoke test step, as shell source.
 *
 * Read out of the YAML rather than kept as a copy, so the test cannot pass
 * against a step the workflow no longer has. The block scalar is located by its
 * `- name: Smoke test` marker and its `run: |` header, and ends at the first
 * line that is not indented further than the header — which is the next key of
 * the same step or the next step.
 */
function deploySmokeStepScript() {
  const yaml = readFileSync(join(repoRoot, '.github', 'workflows', 'web-deploy.yml'), 'utf8');
  const name = yaml.search(/^ {6}- name: Smoke test$/m);
  assert.notEqual(name, -1, '.github/workflows/web-deploy.yml has no "Smoke test" step');
  const header = yaml.indexOf('run: |', name);
  assert.notEqual(header, -1, 'the Smoke test step has no `run: |` body');
  const rest = yaml.slice(header + 'run: |'.length).replace(/^\n/, '');
  const lines = rest.split('\n');
  const body = [];
  for (const line of lines) {
    if (line.trim() === '') { body.push(''); continue; }
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const indent = Math.min(...body.filter((line) => line !== '').map((line) => line.length - line.trimStart().length));
  assert.ok(Number.isFinite(indent) && indent > 0, 'could not determine the Smoke test step indentation');
  return body.map((line) => (line === '' ? '' : line.slice(indent))).join('\n');
}

/**
 * Runs the deploy step's own shell, with a fake `node` standing in for the
 * probe and a fake `curl`, and returns its exit status, output and the
 * `$GITHUB_STEP_SUMMARY` it wrote.
 *
 * This is what makes the deploy wiring observable. Reading the workflow tells
 * you what it says; this tells you what an operator is shown, which is the
 * thing the review's Error 1 was actually about.
 */
function runDeploySmokeStep({ probeExit }) {
  const dir = mkdtempSync(join(tmpdir(), 'antonina-deploy-step-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const summaryPath = join(dir, 'summary.md');
    // The step calls `node scripts/deploy-smoke.mjs ...`; this is the only `node`
    // it will find, so the step's own logic runs against a chosen status.
    writeFileSync(join(bin, 'node'), `#!/bin/sh
echo "probe: loaded ${probeExit === 0 ? 'https://vau.place/a/antonina/' : ''}"
echo "probe: the application said something" >&2
exit ${probeExit}
`);
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'curl'), 0o755);
    const script = deploySmokeStepScript();
    const scriptPath = join(dir, 'step.sh');
    writeFileSync(scriptPath, script);
    const run = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GITHUB_STEP_SUMMARY: summaryPath,
        // The step's own guard, satisfied, so the run reaches the probe rather
        // than failing on its inputs and proving nothing about the branching.
        ANTONINA_BOARD_TRUST_ANCHOR: '{"boardId":"b","rootKeyId":"ed25519:' + 'A'.repeat(43) + '","rootPublicKey":"B"}',
        ANTONINA_BOARD_CREDENTIAL: '{"boardId":"b","privateKey":"B"}',
      },
    });
    return {
      status: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      step: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The three browser cases share one set of fixtures, and only they need them:
// the timeout, spawn-failure and classification cases below run with no browser
// and no built bundle at all, so `node --test --test-name-pattern` can reach them
// on a machine that has neither.
async function browserFixtures() {
  requireWebBuild();
  if (healthy === undefined) {
    healthy = await startLocalAntonina('ok');
    tampered = await startLocalAntonina('tampered');
    brokenStore = await startLocalAntonina('server-error');
  }
  return { healthy, tampered, brokenStore };
}

after(async () => {
  for (const local of [healthy, tampered, brokenStore]) await local?.close();
  for (const close of openInstances) await close();
});

test('a healthy local deployment passes, and the probe process exits 0', { timeout: 180_000 }, async () => {
  await browserFixtures();
  const result = await runProbe(probeOptions(healthy));
  assert.ok(result.observation.issueRows >= 1, 'the issue list rendered no rows');
  assert.ok(result.feed.entries >= 1, 'the feed rendered no entries');
  assert.equal(result.observation.state, 'ready');

  const run = await runProbeProcess(healthy);
  assert.equal(run.status, 0, `probe exited ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stdout, /PASS: the deployed board loaded, verified/);
  assert.equal(run.stderr.trim(), '');
});

test('a deployment that serves HTML but cannot verify the board fails, exit 1', { timeout: 180_000 }, async () => {
  // The page, the bundle and the stylesheet are served byte-for-byte as in the
  // healthy case. Only the signed board under them was rewritten in transit.
  await browserFixtures();
  await assert.rejects(
    () => runProbe(probeOptions(tampered)),
    (error) => {
      assert.ok(error instanceof SmokeFailure, `expected a SmokeFailure, got ${error}`);
      assert.match(error.message, /the application reported: The board could not be loaded/);
      return true;
    },
  );

  const run = await runProbeProcess(tampered);
  assert.equal(run.status, 1, `expected exit 1, got ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stderr, /SMOKE FAILED/);
  assert.match(run.stderr, /The board could not be loaded/);
});

test('the tampering fixture actually tampers with something the store served', { timeout: 180_000 }, async () => {
  // The fail-open this guards against is specific and it already happened once:
  // the tamper hook was written for the v2 signed log, the store had moved to
  // v3 materialized snapshots, the hook matched nothing, and the "broken
  // deployment" served a valid board — so the case above was green for a
  // reason that had nothing to do with the probe.
  //
  // Asserting the fixture is *effective* separately from asserting the probe
  // *rejects* it means the two cannot be confused again. A hook that stops
  // matching is a loud red here, naming the shapes the store actually served.
  const local = await startLocalAntonina('tampered');
  try {
    // Driven through a real browser, because the reads that carry the snapshots
    // are the application's, not the fixture's.
    await assert.rejects(() => runProbe(probeOptions(local)));
    assert.ok(
      local.served.size > 0,
      'the fixture served no object to tamper with, so the broken case was a no-op',
    );
    assert.ok(
      local.tampered.has('board-v2'),
      `the tamper hook altered none of the ${local.served.size} objects the store served `
      + '(served: ' + [...local.served].join(', ') + '); the broken case would be a no-op and the probe '
      + 'would be right to pass',
    );
    assert.ok(
      ![...local.tampered].some((key) => key.startsWith('board-v3-')),
      'an immutable snapshot was altered; only the signed pointer is rewritten, so that the '
      + 'snapshots stay reachable and the failure is the signature and nothing else',
    );
  } finally {
    await local.close();
  }
});

test('a deployment whose board store errors fails with the application error, exit 1', { timeout: 180_000 }, async () => {
  await browserFixtures();
  await assert.rejects(
    () => runProbe(probeOptions(brokenStore)),
    (error) => {
      assert.ok(error instanceof SmokeFailure);
      // The wording is the real store's, not the hand-rolled fixture's: the pointer
      // key is still board-v2, and ShardedBoardStore is what phrases the failure.
      assert.match(error.message, /Skrynia GET Antonina board-v2 failed \(500\)/);
      return true;
    },
  );

  const run = await runProbeProcess(brokenStore);
  assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /SMOKE FAILED/);
  assert.match(run.stderr, /board-v2 failed \(500\)/);
});

test('a board that cannot be read is never reported as a pass, with or without a credential', { timeout: 180_000 }, async () => {
  // The credential screen is what a browser with no credential sees on a board
  // that is perfectly healthy. Treating it as a pass is precisely the hole this
  // probe closes, so it is a failure in every direction — and the two ways of
  // getting there have to name their own cause, because they have different
  // operator actions and one of them is the probe's own fault, not the
  // deployment's.
  await browserFixtures();

  // Nothing at all: the probe was handed no secret.
  await assert.rejects(
    () => runProbe(probeOptions(healthy, { trustAnchor: null, boardCredential: null })),
    (error) => {
      assert.ok(error instanceof SmokeFailure);
      assert.match(error.message, /no board secret at all/);
      return true;
    },
  );

  // The anchor alone. This is the false red that made the positive half of
  // issue 74 unreachable: the board is healthy, the anchor is valid, and the
  // application still refuses the read because an anchor permits verification
  // and not access. The verdict has to say that, not "the deployment is broken".
  await assert.rejects(
    () => runProbe(probeOptions(healthy, { boardCredential: null })),
    (error) => {
      assert.ok(error instanceof SmokeFailure);
      assert.match(error.message, /stored a trust anchor but no board credential/);
      assert.match(error.message, /the probe's input, not the deployment/);
      assert.doesNotMatch(error.message, /the application asked for a board credential/);
      return true;
    },
  );

  // The credential alone, with no anchor. This passes, and it is the case that
  // has to be pinned rather than assumed: the credential carries the board's
  // own public key, so the application can both read *and* verify without a
  // separate anchor. An earlier revision of this test asserted the opposite —
  // that dropping the anchor alone strands the browser — and was wrong, which
  // would have made the probe look broken on a configuration that works.
  const credentialOnly = await runProbe(probeOptions(healthy, { trustAnchor: null }));
  assert.equal(credentialOnly.observation.state, 'ready');
  assert.ok(credentialOnly.observation.issueRows >= 1, 'the credential alone could not read the board');
});

test('a board credential that is really a trust anchor is refused before the browser starts', async () => {
  // The two secrets are both "the board secret" and both are JSON, so passing
  // one where the other belongs is easy, and the application's reader would
  // silently return null for it — making a mistyped flag look like a broken
  // deployment. Reject-only, and before any browser exists.
  await assert.rejects(
    () => runProbe({
      url: 'http://127.0.0.1:1/',
      trustAnchor: '{"boardId":"b","rootKeyId":"ed25519:' + 'A'.repeat(43) + '","rootPublicKey":"B"}',
      boardCredential: '{"boardId":"b","rootKeyId":"ed25519:' + 'A'.repeat(43) + '","rootPublicKey":"B"}',
      chromedriver: 'chromedriver',
      timeout: 1_000, minIssues: 1, minFeed: 1,
    }),
    (error) => {
      assert.ok(error instanceof ProbeUsageError, `expected a ProbeUsageError, got ${error}`);
      assert.match(error.message, /board credential has keys \[boardId, rootKeyId, rootPublicKey\]/);
      return true;
    },
  );
});

test('the credential keys the probe checks are the credential parser\'s own keys', async () => {
  // The probe keeps both key lists literal so it stays one file with no build
  // step, which is only safe if something compares them to the parser they are
  // standing in for. Read from the compiled source, which is what the probe
  // would be handed.
  const source = readFileSync(join(repoRoot, 'packages', 'core', 'dist', 'credential.js'), 'utf8');
  const exported = ['BOARD_CREDENTIAL_STORAGE_KEY', 'BOARD_TRUST_STORAGE_KEY'];
  for (const name of exported) {
    assert.match(source, new RegExp(`${name} = '([^']+)'`));
  }
  assert.equal(BOARD_CREDENTIAL_STORAGE_KEY, 'antonina:board-v2:credential');
  assert.equal(BOARD_TRUST_STORAGE_KEY, 'antonina:board-v2:trust');
});

test('the probe\'s duplicated key lists are the core parsers\' own key lists', async () => {
  // The two Errors of review 74 were, in the end, about duplicated knowledge.
  // The probe keeps `parseBoardCredential`'s and `parseBoardTrustAnchor`'s key
  // lists as literals so it stays one file with no build step — the deploy job
  // runs it on a checkout where nothing has been compiled, so importing
  // `packages/core/dist` there would make the probe unrunnable in the only
  // place it matters. That reason is real, but it only licenses the
  // duplication if something holds the two lists together, and until now
  // nothing did: two source comments claimed a test that did not exist.
  //
  // This is that test, and it asks core rather than a regex. It builds an
  // object whose keys are exactly the probe's list, with a usable value for
  // each, and requires core's *compiled* parser to accept it — and then requires
  // core to reject the same object with any one key removed. Together those two
  // directions pin the probe's list to core's:
  //
  //   - core gains a field  -> the probe's list no longer builds a credential
  //     core accepts, so `parseBoardCredential` throws here;
  //   - core drops a field  -> the probe's list builds an object core rejects,
  //     because the key is one core does not want;
  //   - the probe's list drifts either way -> same two failures.
  //
  // It is a behavioural comparison rather than a source-string one on purpose:
  // a grep for `hasExactKeys(...)` would keep passing through a rename, a
  // refactor into a named constant, or a second list in the same file.
  const core = await import(join(repoRoot, 'packages', 'core', 'dist', 'credential.js'));

  const anchorValue = {
    boardId: 'board-smoke',
    rootKeyId: `ed25519:${'A'.repeat(43)}`,
    rootPublicKey: 'B'.repeat(43),
  };
  const credentialValue = {
    ...anchorValue,
    schemaVersion: core.BOARD_CREDENTIAL_SCHEMA_VERSION,
    keyId: `ed25519:${'C'.repeat(43)}`,
    publicKey: 'D'.repeat(43),
    privateKey: 'E'.repeat(43),
    storageCapability: 'f'.repeat(64),
  };

  // The probe's own lists, not hand-written ones: a test that spelled the keys
  // out again would be a third copy to drift.
  assert.deepEqual([...BOARD_TRUST_ANCHOR_KEYS].sort(), Object.keys(anchorValue).sort());
  assert.deepEqual([...BOARD_CREDENTIAL_KEYS].sort(), Object.keys(credentialValue).sort());

  // Direction one: exactly these keys is a valid credential and a valid anchor.
  assert.deepEqual(core.parseBoardCredential({ ...credentialValue }), { ...credentialValue });
  assert.deepEqual(core.parseBoardTrustAnchor({ ...anchorValue }), { ...anchorValue });

  // Direction two: every one of the keys is load-bearing on core's side too, so
  // the probe cannot be holding a key core has stopped requiring.
  for (const key of BOARD_CREDENTIAL_KEYS) {
    const without = { ...credentialValue };
    delete without[key];
    assert.throws(
      () => core.parseBoardCredential(without),
      new Error('Antonina board credential is malformed'),
      `core accepts a board credential without '${key}', so the probe's key list names a key core does not require`,
    );
  }
  for (const key of BOARD_TRUST_ANCHOR_KEYS) {
    const without = { ...anchorValue };
    delete without[key];
    assert.throws(
      () => core.parseBoardTrustAnchor(without),
      new Error('Antonina board trust anchor is malformed'),
      `core accepts a trust anchor without '${key}', so the probe's key list names a key core does not require`,
    );
  }

  // And the shape check the probe actually runs accepts the same object, so the
  // pinning is not only about a list the probe happens not to use.
  assert.doesNotThrow(() => parseArgs([
    '--url', 'http://127.0.0.1:1/',
    '--trust-anchor', JSON.stringify(anchorValue),
    '--board-credential', JSON.stringify(credentialValue),
  ]));
});

// --- the verdicts themselves --------------------------------------------
// These are cheap and they pin the reasoning the browser cases exercise, so a
// future edit to the copy of the failure cannot quietly widen what passes.

test('judgeBoard names the application state and never invents one', () => {
  const options = { trustAnchor: 'anchor', minIssues: 1 };
  const base = { tabs: ['Issues', 'Feed'], alert: null, issueRows: 3, filterCounts: ['Open 2'], text: '' };
  assert.equal(judgeBoard({ ...base, state: 'ready' }, options), null);
  assert.match(judgeBoard({ ...base, state: 'unmounted' }, options), /did not mount/);
  assert.match(judgeBoard({ ...base, state: 'loading' }, options), /still on its loading screen/);
  assert.match(
    judgeBoard({ ...base, state: 'failed', heading: 'The board could not be loaded', detail: 'signature mismatch' }, options),
    /The board could not be loaded — signature mismatch/,
  );
  assert.match(judgeBoard({ ...base, state: 'untrusted' }, { trustAnchor: null, boardCredential: null }), /no board secret at all/);
  assert.match(
    judgeBoard({ ...base, state: 'untrusted' }, { trustAnchor: 'anchor', boardCredential: null }),
    /stored a trust anchor but no board credential/,
  );
  assert.match(judgeBoard({ ...base, state: 'untrusted' }, { trustAnchor: 'anchor', boardCredential: 'cred' }), /asked for a board credential/);
  assert.match(judgeBoard({ ...base, state: 'deleted' }, options), /deleted/);
  assert.match(judgeBoard({ ...base, state: 'uninitialized' }, options), /first-run screen/);
  assert.match(judgeBoard({ ...base, state: 'ready', tabs: ['Issues'] }, options), /missing its navigation/);
  assert.match(judgeBoard({ ...base, state: 'ready', alert: 'Skrynia GET antonina/board-v2 failed (503)' }, options), /503/);
  assert.match(judgeBoard({ ...base, state: 'ready', issueRows: 0 }, options), /issue list is empty/);
});

test('judgeFeed reports the feed error rather than an empty list', () => {
  const options = { minFeed: 1 };
  assert.equal(judgeFeed({ entries: 4, error: null, count: '4 of 9' }, options), null);
  assert.match(judgeFeed({ entries: 0, error: 'the log could not be read', count: null }, options), /log could not be read/);
  assert.match(judgeFeed({ entries: 0, error: null, count: null, empty: true }, options), /feed is empty/);
});

// --- the DOM-to-state mapping -------------------------------------------
// The mapping from "what is on the page" to "what state is the application in"
// used to live inside a string constant that only ever ran inside a browser, so
// the suite could not reach it: it fed judgeBoard hand-written state strings and
// nothing tested the step that produces them. That step is what decides whether
// an operator is told to rotate a trust anchor or told the board is missing, so
// it is a pure function and it is tested here, against the fields the page
// script actually collects.

test('classifyObservation tells the first-run screens apart by their title, not their prose', () => {
  const firstRun = (firstRunTitle) => ({ hasMain: true, hasLoadError: false, loading: false, hasFirstRun: true, firstRunTitle, hasMainNav: false });

  // The bug this replaced: the mapping used to read the first-run screens' *body*
  // prose, which all talks about credentials, so the missing-board screen was
  // reported as a refused trust anchor and an operator was sent to rotate a
  // perfectly good anchor on a deployment that simply had no board.
  assert.equal(classifyObservation(firstRun(APP_STATE_TITLES.uninitialized)), 'uninitialized');
  assert.equal(classifyObservation(firstRun(APP_STATE_TITLES.untrusted)), 'untrusted');
  assert.equal(classifyObservation(firstRun(APP_STATE_TITLES.deleted)), 'deleted');

  // A first-run screen the probe does not recognise is not evidence of anything:
  // an unfamiliar title is `unknown`, and unknown is a failure, not a guess.
  assert.equal(classifyObservation(firstRun('A screen this probe has not seen')), 'unknown');
  assert.equal(classifyObservation(firstRun('')), 'unknown');

  assert.equal(classifyObservation({ hasMain: true, hasLoadError: false, loading: false, hasFirstRun: false, hasMainNav: true }), 'ready');
  assert.equal(classifyObservation({ hasMain: true, hasLoadError: true, loading: false, hasFirstRun: true, firstRunTitle: APP_STATE_TITLES.untrusted, hasMainNav: false }), 'failed');
  assert.equal(classifyObservation({ hasMain: true, hasLoadError: false, loading: true, hasFirstRun: false, hasMainNav: false }), 'loading');
  assert.equal(classifyObservation({ hasMain: false }), 'unmounted');
  assert.equal(classifyObservation({ hasMain: true, hasLoadError: false, loading: false, hasFirstRun: false, hasMainNav: false }), 'unknown');
});

test('the titles the probe classifies on are the application\'s own titles', () => {
  // These strings are duplicated from web/src/ui-state.ts on purpose (the probe
  // is one file with no build step), so this is the check that the copy has not
  // drifted. If the app renames a screen, this fails and the probe is updated
  // with it, rather than the probe silently calling a known screen `unknown`.
  //
  // It also pins the property the whole diagnosis rests on: the three
  // first-run screens are told apart by *their titles*, so the titles must be
  // pairwise distinct. Two states sharing a title would collapse into one, and
  // a collapse is how "no board exists" turns back into "the anchor was
  // refused" without anybody noticing.
  const source = readFileSync(join(repoRoot, 'web', 'src', 'ui-state.ts'), 'utf8');
  for (const [state, title] of Object.entries(APP_STATE_TITLES)) {
    assert.ok(
      source.includes(`title: '${title}'`),
      `web/src/ui-state.ts no longer carries the ${state} title "${title}"; update APP_STATE_TITLES in scripts/deploy-smoke.mjs`,
    );
  }
  const titles = Object.values(APP_STATE_TITLES);
  assert.equal(new Set(titles).size, titles.length, `two application states share a title: ${titles.join(' / ')}`);

  // And the discriminator really is the `h1` each screen renders, not the copy
  // around it: App.tsx renders `<h1>{…_COPY.title}</h1>` inside
  // `<section className="first-run">` on exactly these three branches, and
  // nowhere else. If a fourth branch starts rendering one, this fails.
  const app = readFileSync(join(repoRoot, 'web', 'src', 'App.tsx'), 'utf8');
  const firstRunSections = app.split('<section className="first-run">').length - 1;
  assert.equal(firstRunSections, 3, 'App.tsx no longer renders exactly three .first-run screens; the probe\'s DOM mapping needs re-deriving');
  for (const copy of ['FIRST_RUN_COPY', 'BOARD_KEY_COPY', 'DELETED_COPY']) {
    assert.ok(
      new RegExp(`<section className="first-run">(?:(?!</section>).)*<h1>\\{${copy}\\.title\\}</h1>`, 's').test(app),
      `App.tsx no longer renders ${copy}.title as the h1 of a .first-run screen`,
    );
  }
});

// A minimal DOM, just enough to run the shipped OBSERVE_BOARD string outside a
// browser. It is not an HTML implementation: it is a node tree supporting the
// handful of selector forms that script uses (a tag, a class, `[attr="value"]`,
// `p:not(.class)`, and descendant combinators). It exists to assert that the
// page script and the classifier agree on field names — the seam that splitting
// the two halves created, and one a unit test of classifyObservation alone
// cannot cover.

/** Builds one node. `spec` is `{ tag, class, role, name, content, text, children }`. */
function node(spec) {
  const element = {
    tagName: spec.tag.toUpperCase(),
    classes: (spec.class ?? '').split(' ').filter(Boolean),
    role: spec.role ?? null,
    name: spec.name ?? null,
    content: spec.content ?? null,
    textContent: spec.text ?? '',
    children: (spec.children ?? []).map(node),
    get innerText() { return [this.textContent, ...this.children.map((child) => child.innerText)].join(' '); },
  };
  element.querySelector = (selector) => select(element, selector)[0] ?? null;
  element.querySelectorAll = (selector) => select(element, selector);
  return element;
}

/** Every node under `root`, root's own descendants included when asked. */
function flatten(root, includeSelf) {
  const below = root.children.flatMap((child) => flatten(child, true));
  return includeSelf ? [root, ...below] : below;
}

/** Does one node satisfy one simple compound selector, `:not(...)` included? */
function satisfies(element, selector) {
  const negated = [...selector.matchAll(/:not\(([^)]+)\)/g)].map((match) => match[1]);
  const positive = selector.replace(/:not\([^)]+\)/g, '').trim();
  if (!matches(element, positive)) return false;
  return negated.every((condition) => !matches(element, condition));
}

function matches(element, selector) {
  if (selector === '' || selector === '*') return true;
  // A compound like 'nav.main-nav': the tag, then any classes, then attributes.
  const attribute = /\[([a-z-]+)="([^"]*)"\]/.exec(selector);
  if (attribute !== null) {
    if (element[attribute[1]] !== attribute[2]) return false;
    selector = selector.replace(attribute[0], '');
  }
  // `tag.class.class`, in that order. Every class name in this script contains a
  // hyphen ('first-run', 'load-error', 'main-nav', 'issue-row') and no tag name
  // does, which is what tells the two apart after the split.
  const parts = selector.split('.').filter(Boolean);
  const isClass = (part) => part.includes('-');
  const classes = parts.filter(isClass);
  const tags = parts.filter((part) => !isClass(part));
  if (tags.length > 1) return false;
  if (tags.length === 1 && element.tagName !== tags[0].toUpperCase()) return false;
  return classes.every((name) => element.classes.includes(name));
}

/** Descendant selector over a tree: `'nav.main-nav button'`, `'p:not(.eyebrow)'`. */
function select(root, selector) {
  const [first, ...rest] = selector.split(' ');
  let found = flatten(root, false).filter((element) => satisfies(element, first));
  for (const part of rest) {
    found = found.flatMap((element) => flatten(element, true).filter((child) => satisfies(child, part)));
  }
  return found;
}

test('the shipped page script and the classifier agree on the fields, end to end', () => {
  // OBSERVE_BOARD is a string that only ever ran inside a browser. Running it
  // here, against a DOM shaped like the screens App.tsx renders, is what proves
  // the two halves fit: a renamed field would make classifyObservation read
  // `undefined` and call every screen `unmounted`, which no test of either half
  // alone would catch.
  const screens = {
    uninitialized: node({
      tag: 'body',
      children: [{
        tag: 'main',
        children: [{
          tag: 'section',
          class: 'first-run',
          children: [
            { tag: 'p', class: 'eyebrow', text: 'Antonina' },
            { tag: 'h1', text: APP_STATE_TITLES.uninitialized },
            { tag: 'p', text: 'Initializing the board makes this browser its first editor. Copy that credential and the board’s public trust anchor from Settings…' },
          ],
        }],
      }],
    }),
    untrusted: node({
      tag: 'body',
      children: [{
        tag: 'main',
        children: [{
          tag: 'section',
          class: 'first-run',
          children: [
            { tag: 'p', class: 'eyebrow', text: 'Antonina' },
            { tag: 'h1', text: APP_STATE_TITLES.untrusted },
            { tag: 'p', text: 'This Antonina board is private to people who have its shared credential.' },
            { tag: 'form', class: 'stacked-form', children: [{ tag: 'button', class: 'primary', text: 'Open board' }] },
          ],
        }],
      }],
    }),
    deleted: node({
      tag: 'body',
      children: [{
        tag: 'main',
        children: [{
          tag: 'section',
          class: 'first-run',
          children: [
            { tag: 'p', class: 'eyebrow', text: 'Antonina' },
            { tag: 'h1', text: APP_STATE_TITLES.deleted },
            { tag: 'p', text: 'The board was deleted on purpose.' },
          ],
        }],
      }],
    }),
    ready: node({
      tag: 'body',
      children: [{
        tag: 'main',
        children: [
          { tag: 'nav', class: 'main-nav', children: [{ tag: 'button', text: 'Issues' }, { tag: 'button', text: 'Feed' }] },
          { tag: 'nav', class: 'filters', children: [{ tag: 'button', text: 'Open 1' }] },
          { tag: 'div', class: 'issue-row' },
          { tag: 'div', class: 'issue-row' },
        ],
      }],
    }),
  };

  for (const [expected, body] of Object.entries(screens)) {
    const document = {
      title: 'Antonina',
      body,
      querySelector: (selector) => body.querySelector(selector),
      querySelectorAll: (selector) => body.querySelectorAll(selector),
    };
    const observation = new Function('document', OBSERVE_BOARD)(document);
    assert.equal(classifyObservation(observation), expected, `the ${expected} screen was classified as something else`);
  }
});

test('an uninitialized board is reported as a missing board, not a refused anchor', () => {
  const observation = {
    hasMain: true, hasLoadError: false, loading: false, hasFirstRun: true, hasMainNav: false,
    firstRunTitle: APP_STATE_TITLES.uninitialized,
    firstRunBody: 'Initializing the board makes this browser its first editor and stores the board’s root signing credential in this browser. Copy that credential and the board’s public trust anchor from Settings…',
    tabs: [], filterCounts: [], text: '',
  };
  const options = { trustAnchor: '{"boardId":"b","rootKeyId":"ed25519:' + 'A'.repeat(43) + '","rootPublicKey":"B"}', minIssues: 1 };
  const problem = judgeBoard({ ...observation, state: classifyObservation(observation) }, options);
  assert.match(problem, /no signed board exists at the deployed Skrynia key/);
  // The old classification reported this one as a trust rejection, which is what
  // sent an operator to rotate a perfectly good anchor.
  assert.doesNotMatch(problem, /refused the trust anchor/);
});

test('an unrecognised first-run screen fails with the title it showed', () => {
  const observation = {
    hasMain: true, hasLoadError: false, loading: false, hasFirstRun: true, hasMainNav: false,
    firstRunTitle: 'A screen this probe has not seen', text: 'some text',
  };
  const problem = judgeBoard({ ...observation, state: classifyObservation(observation) }, { trustAnchor: null, minIssues: 1 });
  assert.match(problem, /A screen this probe has not seen/);
});

// --- a driver that cannot be run, and a driver that will not answer --------

test('an unspawnable chromedriver is a usage error naming the path, and leaks no profile', async () => {
  // A path that exists but cannot be executed, which is the trigger the
  // 'error'-event fix is for: spawn() reports EACCES asynchronously, and with
  // no listener that kills the process with a raw stack and exit 1 — the code
  // this probe reserves for "the deployment is broken".
  const dir = mkdtempSync(join(tmpdir(), 'antonina-probe-fixture-'));
  const notExecutable = join(dir, 'chromedriver');
  writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-')).length;

  const run = spawnSync(process.execPath, [probeScript, '--url', 'http://127.0.0.1:1/', '--chromedriver', notExecutable], { encoding: 'utf8' });
  assert.equal(run.status, 2, `expected exit 2 (this host cannot check), got ${run.status}\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /smoke probe could not run/);
  assert.match(run.stderr, new RegExp(`cannot run ${notExecutable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(run.stderr, /EACCES/);
  // No raw stack, and no "SMOKE FAILED": those both mean a broken deployment.
  assert.doesNotMatch(run.stderr, /\bat .*deploy-smoke\.mjs/);
  assert.doesNotMatch(run.stderr, /SMOKE FAILED/);

  const after = readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-')).length;
  assert.equal(after, before, 'the throwaway browser profile was not removed when the driver could not be spawned');
  rmSync(dir, { recursive: true, force: true });

  // A path that does not exist at all is the same class of failure and the
  // same exit code, caught before anything is created.
  const missing = spawnSync(process.execPath, [probeScript, '--url', 'http://127.0.0.1:1/', '--chromedriver', join(dir, 'no-such-driver')], { encoding: 'utf8' });
  assert.equal(missing.status, 2, `expected exit 2, got ${missing.status}: ${missing.stderr}`);
  assert.match(missing.stderr, /does not exist/);
});

test('a chromedriver that accepts the request and never answers times out, exit 1, with what it printed', async () => {
  // The transport case: the readiness poll answers, and then the session
  // request never does. Node's fetch has no default timeout, so without the
  // per-call signal and the overall budget this run would sit here until the CI
  // job limit. The verdict must be a timeout, it must name itself as one, and it
  // must carry the driver's stderr — the assertion is on the message, never on
  // how long it took.
  const dir = mkdtempSync(join(tmpdir(), 'antonina-probe-fixture-'));
  const fake = join(dir, 'chromedriver');
  writeFileSync(fake, `#!/usr/bin/env node
const { createServer } = require('node:http');
const port = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=0').slice('--port='.length));
process.stderr.write(\`fake chromedriver \${port} pretending to be busy\\n\`);
const server = createServer((request, response) => {
  // Ready, so the probe gets past its readiness poll...
  if (request.url === '/status') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
  // ...and then never answers anything else, which is the wedge.
});
server.listen(port, '127.0.0.1');
`, { mode: 0o755 });

  const run = spawnSync(process.execPath, [probeScript, '--url', 'http://127.0.0.1:1/', '--chromedriver', fake, '--timeout', '2000'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ANTONINA_BOARD_TRUST_ANCHOR: '', ANTONINA_BOARD_TRUST_ANCHOR_FILE: '' },
  });
  assert.equal(run.status, 1, `expected exit 1 (the deployment never answered), got ${run.status}\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /SMOKE FAILED/);
  assert.match(run.stderr, /timed out/);
  // The driver is the thing to look at, so what it printed has to be here.
  assert.match(run.stderr, /pretending to be busy/);
  rmSync(dir, { recursive: true, force: true });
});

test('a run that outlasts its overall budget is a timeout, even when every call could still answer', { timeout: 60_000 }, async () => {
  // The per-call signal and the overall budget bound different things. The case
  // above is the per-call one: a single call that never returns. This is the
  // other: a generous per-call timeout, so only the budget can end the run, and
  // a driver that would answer every call eventually. Without the race the run
  // proceeds call by call and the deploy step never concludes.
  const dir = mkdtempSync(join(tmpdir(), 'antonina-probe-fixture-'));
  const fake = join(dir, 'chromedriver');
  writeFileSync(fake, `#!/usr/bin/env node
const { createServer } = require('node:http');
const port = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=0').slice('--port='.length));
process.stderr.write('fake chromedriver on ${'${port}'} answering slowly\\n');
createServer((request, response) => {
  if (request.url === '/status') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
  setTimeout(() => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"value":{}}'); }, 60_000);
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });

  const profilesBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-'));
  const options = {
    url: 'http://127.0.0.1:1/',
    trustAnchor: null,
    chromedriver: fake,
    // Each call is given far more than the run is allowed to take, so the only
    // thing that can end this is the overall budget.
    timeout: 600_000,
    overallTimeout: 2_000,
    minIssues: 1,
    minFeed: 1,
  };
  await assert.rejects(() => withinDeadline(() => runProbe(options), 15_000, BUDGET_DID_NOT_FIRE), (error) => {
    assert.ok(error instanceof ProbeTimeout, `expected a ProbeTimeout, got ${error}`);
    assert.match(error.message, /the probe to finish within 2000ms/);
    // A timeout an operator cannot diagnose is half a timeout.
    assert.match(error.message, /answering slowly/);
    return true;
  });
  // The driver and its throwaway profile are still cleaned up on this path.
  const leaked = readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-'));
  assert.deepEqual(leaked, profilesBefore, 'a timed-out run leaked its browser profile');
  rmSync(dir, { recursive: true, force: true });
});

test('the per-call WebDriver bound ends a wedged call, independently of the overall budget', { timeout: 60_000 }, async () => {
  // The other half of the transport bound, and the half the shipped tests did
  // NOT cover: `overallBudgetMs` is three times `options.timeout`, so in every
  // other case in this file the budget fires first and deleting
  // `signal: AbortSignal.timeout(this.timeout)` from `WebDriver.request` changes
  // nothing an assertion can see. Here the budget is pushed out of the way —
  // `timeout: 1500` against an `overallTimeout` of ten minutes — so only the
  // per-call signal can end the run, and the verdict has to be the *per-call*
  // wording rather than the generic budget one.
  const dir = mkdtempSync(join(tmpdir(), 'antonina-probe-fixture-'));
  const fake = join(dir, 'chromedriver');
  writeFileSync(fake, `#!/usr/bin/env node
const { createServer } = require('node:http');
const port = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '--port=0').slice('--port='.length));
process.stderr.write('fake chromedriver is HELLA busy\\n');
createServer((request, response) => {
  if (request.url === '/status') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
  // Everything else is accepted and never answered: the wedge.
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });

  const profilesBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-'));
  try {
    await assert.rejects(
      // 20s is well past the 1500ms the call is allowed, and far short of the
      // 600000ms overall budget, so this races the *signal*, never the budget.
      // It is also what keeps the mutation honest: with the per-call signal
      // deleted this is a bounded red assertion, not a wedged job.
      () => withinDeadline(() => runProbe({
        url: 'http://127.0.0.1:1/',
        trustAnchor: null,
        chromedriver: fake,
        timeout: 1_500,
        overallTimeout: 600_000,
        minIssues: 1,
        minFeed: 1,
      }), 20_000, 'the per-call WebDriver bound did not end the wedged call'),
      (error) => {
        assert.ok(error instanceof ProbeTimeout, `expected a ProbeTimeout, got ${error}`);
        // The per-call message, not "the probe to finish within 600000ms": this is
        // the assertion that distinguishes the two bounds.
        assert.match(error.message, /chromedriver to answer POST \/session within 1500ms/);
        assert.match(error.message, /HELLA busy/);
        assert.doesNotMatch(error.message, /the probe to finish within/);
        return true;
      },
    );
    assert.deepEqual(
      readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-')),
      profilesBefore,
      'a per-call timeout leaked its browser profile',
    );
  } finally {
    // A failing run must clean up its fake driver too; see the sibling test.
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the overall budget is a multiple of the per-call timeout, so a run cannot add up without bound', () => {
  assert.equal(overallBudgetMs({ timeout: 5_000 }), 15_000);
  assert.equal(overallBudgetMs({ timeout: 5_000, overallTimeout: 1_000 }), 1_000);
});

test('a malformed trust anchor is refused as a bad secret, before the browser is ever started', async () => {
  // The application's own reader returns null for anything JSON.parse rejects, so
  // a secret that is not the anchor JSON is silently the same as no anchor at
  // all, and the probe would report that the application "refused" it. It is
  // checked here instead, and named as the operator's secret.
  const url = 'https://host/a/antonina/';
  for (const bad of ['boardId: abc', 'not json at all', '[]', '{"boardId":"b"}', '{"boardId":"b","rootKeyId":"k","rootPublicKey":"p","extra":1}']) {
    assert.throws(() => parseArgs(['--url', url, '--trust-anchor', bad]), (error) => {
      assert.ok(error instanceof ProbeUsageError, `expected a ProbeUsageError for ${bad}`);
      assert.match(error.message, /--trust-anchor/);
      return true;
    });
  }
  // A well-formed anchor of the right shape parses.
  const ok = parseArgs(['--url', url, '--trust-anchor', '{"boardId":"b","rootKeyId":"ed25519:x","rootPublicKey":"y"}']);
  assert.match(ok.trustAnchor, /"boardId":"b"/);

  // And the check is not only in the argument parser: runProbe is the public
  // entry, and it refuses the same thing before it spawns a browser or creates
  // a profile. Pointed at a chromedriver path that does not exist, so if the
  // check ever moves after the driver start, the error changes and this fails.
  const profilesBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-'));
  await assert.rejects(
    () => runProbe({ url, trustAnchor: 'boardId: abc', chromedriver: '/nonexistent/chromedriver', timeout: 1_000, minIssues: 1, minFeed: 1 }),
    (error) => {
      assert.ok(error instanceof ProbeUsageError, `expected a ProbeUsageError, got ${error}`);
      assert.match(error.message, /not valid JSON/);
      // The driver's own usage error would be about the missing binary; this is
      // about the secret, which is the thing the operator has to fix first.
      assert.doesNotMatch(error.message, /chromedriver/);
      return true;
    },
  );
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) => name.startsWith('antonina-smoke-')),
    profilesBefore,
  );
});

test('the probe refuses to run without a URL, and says so with exit code 2', async () => {
  assert.throws(() => parseArgs([]), ProbeUsageError);
  assert.throws(() => parseArgs(['--url', 'not-a-url']), ProbeUsageError);
  assert.throws(() => parseArgs(['--url', 'https://host/', '--invented']), /unexpected argument/);
  const parsed = parseArgs(['--url', 'https://host/a/antonina/', '--min-issues', '0']);
  assert.equal(parsed.minIssues, 0);
  assert.equal(parsed.trustAnchor, null);

  // Exit code 2, not 1: the probe could not run. Conflating "this deployment is
  // broken" with "this host has no way to check" would make a missing browser
  // look like a failed release.
  const usage = spawnSync(process.execPath, [probeScript], { encoding: 'utf8' });
  assert.equal(usage.status, 2, `expected exit 2, got ${usage.status}: ${usage.stderr}`);
  assert.match(usage.stderr, /--url is required/);
});
