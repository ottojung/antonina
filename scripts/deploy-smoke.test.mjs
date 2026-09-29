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
// It is therefore NOT in the root `npm test` chain, which every other suite
// must stay runnable without a browser or a build. The CI job that provisions
// both and runs this suite is `smoke-probe` in `.github/workflows/ci.yml`; a
// missing browser there is a failure, not a skip, because a skip would report
// "the probe was never exercised" as a green run.
//
// The other cases here — the DOM-to-state classification, the unspawnable
// driver, the timeout paths — need neither, so they run on a bare checkout and
// can be reached with `node --test --test-name-pattern=...`.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import {
  runProbe, judgeBoard, judgeFeed, parseArgs, classifyObservation, overallBudgetMs,
  ProbeUsageError, ProbeTimeout, SmokeFailure, APP_STATE_TITLES, OBSERVE_BOARD,
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
 *   'tampered'    - the log is served with one operation's payload altered, so
 *                   signature verification must refuse it
 *   'server-error'- the store answers 500 with a body that is not a board
 */
/** Every local instance, so a fixture that fails halfway is still torn down. */
const openInstances = [];

async function startLocalAntonina(boardMode) {
  const { BoardApi } = await import(join(repoRoot, 'packages', 'core', 'dist', 'api.js'));
  const { SignedBoardStore } = await import(join(repoRoot, 'packages', 'core', 'dist', 'board-store.js'));
  const { credentialTrustAnchor, serializeBoardTrustAnchor } = await import(join(repoRoot, 'packages', 'core', 'dist', 'credential.js'));

  let signed = null;
  let revision = 0;
  // The failure mode is switched on only after the fixture board is committed,
  // so a broken deployment is a board that was fine and then stopped working,
  // not a board this fixture never managed to create.
  let broken = false;
  const capability = 'a'.repeat(64);
  const etag = () => `"v${revision}"`;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
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

  async function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (url.pathname === '/_skrynia/health') return send(200, { ok: true });
    if (url.pathname === '/_skrynia/store/antonina/board-v2') {
      if (request.method === 'GET') {
        if (broken && boardMode === 'server-error') return send(500, { error: 'skrynia storage backend unavailable' });
        if (signed === null) return send(404, { error: 'not found' });
        if (broken && boardMode === 'tampered') {
          // The 0.1.1 shape: the app is served fine, the board under it cannot
          // be verified. One committed operation's title is rewritten in
          // transit, so the signature no longer covers the payload.
          const tamperedLog = structuredClone(signed);
          const create = tamperedLog.operations.find((operation) => operation.kind === 'issue.create');
          assert.ok(create, 'the fixture board has no created issue to tamper with');
          create.payload.title = 'tampered in transit';
          return send(200, tamperedLog, { ETag: etag() });
        }
        return send(200, signed, { ETag: etag() });
      }
      const body = await readBody(request);
      if (request.method === 'POST') {
        if (signed !== null) return send(409, { error: 'exists' });
        signed = JSON.parse(body === '' ? 'null' : body);
        revision += 1;
        return send(201, { mode: 'capability-write', capability });
      }
      if (request.method === 'PUT') {
        if (request.headers['x-skrynia-capability'] !== capability) return send(403, { error: 'invalid capability' });
        if (request.headers['if-match'] !== etag()) return send(412, { error: 'stale' });
        signed = JSON.parse(body === '' ? 'null' : body);
        revision += 1;
        return send(200, signed, { ETag: etag() });
      }
      return send(405, { error: 'method not allowed' });
    }
    if (url.pathname.startsWith(APP_PATH)) return serveStatic(url.pathname, response);
    return send(404, { error: 'not found' });
  }

  function serveStatic(pathname, response) {
    const requested = normalize(pathname.slice(APP_PATH.length)).replace(/^(\.\.(\/|\\|$))+/, '');
    const isDirectoryRequest = requested === '' || requested === '.' || requested.endsWith('/');
    const relative = isDirectoryRequest ? (requested === '.' ? '' : requested) + 'index.html' : requested;
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
  const store = new SignedBoardStore({ baseUrl: `${origin}/_skrynia` });
  const initialized = await store.initialize();
  const trustAnchor = credentialTrustAnchor(initialized.credential);
  const client = new BoardApi({ baseUrl: `${origin}/_skrynia`, credential: initialized.credential, trustAnchor });
  const first = await client.createIssue('Smoke: the board must load', 'The probe reads this board and nothing else.');
  await client.comment(first.number, 'smoke', 'A comment, so the feed has an entry that is not a creation.');
  await client.createIssue('Smoke: a second issue', 'so the queue and the filters have something to show');
  broken = true;

  return {
    origin,
    url: `${origin}${APP_PATH}`,
    trustAnchor: serializeBoardTrustAnchor(trustAnchor),
    close,
  };
}

function probeOptions(local, extra = {}) {
  return {
    url: local.url,
    trustAnchor: local.trustAnchor,
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

// --- what the root gate is and is not required to have ---------------------
// Error 4 of the review was that appending this suite to the root `npm test`
// chain gave the root gate a browser, a chromedriver and a built-bundle
// precondition. The suite was then taken out of the chain, but "taken out of
// the chain" was, until now, a comment and a hope: nothing inspected either
// file, so re-appending the suite — or deleting the CI job that runs it — would
// have left CI green and the probe exercised by nobody again, which is the
// exact condition the review raised. These two cases are the assertion.

test('the root npm test chain does not require a browser or a built bundle', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const chain = pkg.scripts.test;
  assert.ok(!chain.includes('test:deploy-smoke'), `the root \`npm test\` chain runs the deploy smoke suite: ${chain}`);
  // And the suite is still reachable, deliberately, by name.
  assert.equal(pkg.scripts['test:deploy-smoke'], 'node --test scripts/deploy-smoke.test.mjs');
  // Nothing else in the chain may smuggle the browser back in.
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'test' || name.startsWith('//') || name === 'test:deploy-smoke') continue;
    assert.ok(
      !/deploy-smoke/.test(command) || !chain.includes(name),
      `${name} pulls the deploy smoke suite into the root chain`,
    );
  }
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

test('a deployment whose board store errors fails with the application error, exit 1', { timeout: 180_000 }, async () => {
  await browserFixtures();
  await assert.rejects(
    () => runProbe(probeOptions(brokenStore)),
    (error) => {
      assert.ok(error instanceof SmokeFailure);
      assert.match(error.message, /Skrynia GET antonina\/board-v2 failed \(500\)/);
      return true;
    },
  );

  const run = await runProbeProcess(brokenStore);
  assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /SMOKE FAILED/);
  assert.match(run.stderr, /board-v2 failed \(500\)/);
});

test('a board that cannot be read is never reported as a pass, with or without an anchor', { timeout: 180_000 }, async () => {
  // The trust screen is what a browser with no anchor sees on a board that is
  // perfectly healthy. Treating it as a pass is precisely the hole this probe
  // closes, so it is a failure in both directions.
  await browserFixtures();
  await assert.rejects(
    () => runProbe(probeOptions(healthy, { trustAnchor: null })),
    (error) => {
      assert.ok(error instanceof SmokeFailure);
      assert.match(error.message, /this browser cannot verify it/);
      return true;
    },
  );
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
  assert.match(judgeBoard({ ...base, state: 'untrusted' }, { trustAnchor: null }), /no trust anchor was supplied/);
  assert.match(judgeBoard({ ...base, state: 'untrusted' }, options), /asked for a board credential/);
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
  await assert.rejects(
    // 20s is well past the 1500ms the call is allowed, and far short of the
    // 600000ms overall budget, so this races the *signal*, never the budget.
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
  rmSync(dir, { recursive: true, force: true });
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
