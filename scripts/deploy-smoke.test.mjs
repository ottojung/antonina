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

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { runProbe, judgeBoard, judgeFeed, parseArgs, ProbeUsageError, SmokeFailure } from './deploy-smoke.mjs';

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
 * The built bundle, built on demand.
 *
 * The probe is a post-deploy artifact check, so it has to run against the real
 * production build output and not a dev server or a test double. If the tree has
 * not been built yet this builds it once for the suite; the build identity is
 * generated first, exactly as `npm run build` does through the root pretypecheck.
 */
function ensureWebBuild() {
  if (existsSync(join(webDist, 'index.html'))) return;
  const identity = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build-identity.mjs')], { encoding: 'utf8' });
  assert.equal(identity.status, 0, `build identity generation failed: ${identity.stderr}`);
  const built = spawnSync('npm', ['run', 'build', '--prefix', join(repoRoot, 'web')], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(built.status, 0, `web build failed: ${built.stdout}${built.stderr}`);
  assert.ok(existsSync(join(webDist, 'index.html')), 'web build produced no dist/index.html');
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

before(async () => {
  ensureWebBuild();
  healthy = await startLocalAntonina('ok');
  tampered = await startLocalAntonina('tampered');
  brokenStore = await startLocalAntonina('server-error');
}, { timeout: 300_000 });

after(async () => {
  for (const local of [healthy, tampered, brokenStore]) await local?.close();
  for (const close of openInstances) await close();
});

test('a healthy local deployment passes, and the probe process exits 0', { timeout: 180_000 }, async () => {
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
