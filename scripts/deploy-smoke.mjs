#!/usr/bin/env node
// Functional post-deploy smoke test for the Antonina web board.
//
// Board issue 74. The smoke test this replaces was two `curl --fail` calls: one
// for the static app URL, one for the Skrynia health endpoint. Both can be
// served perfectly while the deployed application cannot load the board, which
// is exactly what happened in the 0.1.1 rollout. A 200 on index.html is a claim
// about a file, not about an application, and the file is the part that is
// hardest to break.
//
// So this probe drives a real headless browser against the deployed URL and
// requires the things a human would look at:
//
//   1. the application starts: the bundle is fetched, the module graph
//      evaluates, and the app mounts past its loading state;
//   2. the board is loaded *and verified*: the app reaches its board shell, not
//      the trust prompt and not an error page. Verification is the app's own —
//      this probe hands it a public trust anchor and the core parser does the
//      signature and log replay, exactly as it does in a browser;
//   3. the issue list is populated;
//   4. the feed is populated;
//   5. a failure prints the *application's own* error text, not just a status.
//
// Read-only, by construction: the only interaction is navigation and reading.
// No form is ever submitted, no button that writes is ever clicked, and no
// credential is used — the trust anchor is a public key and the probe never
// stores one. A deployment that fails this probe leaves production untouched.
//
// Usage:
//   node scripts/deploy-smoke.mjs --url https://host/a/antonina/ \
//     [--trust-anchor TEXT | --trust-anchor-file PATH] \
//     [--chromedriver PATH] [--timeout MS] [--min-issues N] [--min-feed N]
//
// The trust anchor may also come from ANTONINA_BOARD_TRUST_ANCHOR or
// ANTONINA_BOARD_TRUST_ANCHOR_FILE. Without an anchor the probe cannot ask the
// app to verify anything, so it reports the trust screen as a failure rather
// than passing a board it never read.
//
// Exit codes:
//   0  the board loaded, was verified, and rendered issues and feed entries
//   1  the deployment is broken, and the application's own words are printed
//   2  the probe could not run: bad usage, or no browser on this host

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const PROBE_USAGE = [
  'Usage: node scripts/deploy-smoke.mjs --url URL [--trust-anchor TEXT|--trust-anchor-file PATH]',
  '                             [--chromedriver PATH] [--timeout MS] [--min-issues N] [--min-feed N]',
].join('\n');

const DEFAULTS = {
  timeout: 45_000,
  minIssues: 1,
  minFeed: 1,
  driverPort: 0,
};

/** Storage key the app itself reads the trust anchor from (core credential.ts). */
export const BOARD_TRUST_STORAGE_KEY = 'antonina:board-v2:trust';

export class ProbeUsageError extends Error {}

export function parseArgs(argv) {
  const options = { ...DEFAULTS, url: null, trustAnchor: null, chromedriver: 'chromedriver' };
  const value = (flag, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new ProbeUsageError(`${flag} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') { options.url = value(arg, i); i += 1; }
    else if (arg === '--trust-anchor') { options.trustAnchor = value(arg, i); i += 1; }
    else if (arg === '--trust-anchor-file') { options.trustAnchor = readFileSync(value(arg, i), 'utf8'); i += 1; }
    else if (arg === '--chromedriver') { options.chromedriver = value(arg, i); i += 1; }
    else if (arg === '--timeout') { options.timeout = Number(value(arg, i)); i += 1; }
    else if (arg === '--min-issues') { options.minIssues = Number(value(arg, i)); i += 1; }
    else if (arg === '--min-feed') { options.minFeed = Number(value(arg, i)); i += 1; }
    else if (arg === '--help' || arg === '-h') throw new ProbeUsageError(PROBE_USAGE);
    else throw new ProbeUsageError(`unexpected argument: ${arg}`);
  }
  if (options.url === null) throw new ProbeUsageError('--url is required');
  let parsed;
  try { parsed = new URL(options.url); } catch { throw new ProbeUsageError(`--url is not a URL: ${options.url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProbeUsageError(`--url must be http or https, not ${parsed.protocol}`);
  }
  for (const [flag, number] of [['--timeout', options.timeout], ['--min-issues', options.minIssues], ['--min-feed', options.minFeed]]) {
    if (!Number.isFinite(number) || number < 0) throw new ProbeUsageError(`${flag} must be a non-negative number`);
  }
  if (options.trustAnchor === null) {
    if (process.env.ANTONINA_BOARD_TRUST_ANCHOR) options.trustAnchor = process.env.ANTONINA_BOARD_TRUST_ANCHOR;
    else if (process.env.ANTONINA_BOARD_TRUST_ANCHOR_FILE) {
      options.trustAnchor = readFileSync(process.env.ANTONINA_BOARD_TRUST_ANCHOR_FILE, 'utf8');
    }
  }
  if (options.trustAnchor !== null) options.trustAnchor = options.trustAnchor.trim();
  return options;
}

// --- WebDriver client -----------------------------------------------------
// The W3C WebDriver protocol over plain HTTP, so the probe needs no dependency
// and no network install: chromedriver is already on the host and speaks it.

export class WebDriver {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
    this.session = null;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value = {};
    try { value = text === '' ? {} : JSON.parse(text); } catch { value = { value: { message: text } }; }
    if (!response.ok) {
      const detail = value?.value?.message ?? `${method} ${path} failed (${response.status})`;
      const error = new Error(detail);
      error.webdriver = true;
      throw error;
    }
    return value.value;
  }

  async start(capabilities) {
    const value = await this.request('POST', '/session', { capabilities });
    this.session = value.sessionId;
    return value;
  }

  async stop() {
    if (this.session === null) return;
    try { await this.request('DELETE', `/session/${this.session}`); } catch { /* the driver is going away anyway */ }
    this.session = null;
  }
}

/** A thin, correct W3C command wrapper: one method per command the probe uses. */
class Driver {
  constructor(webdriver) { this.wd = webdriver; }

  navigate(url) { return this.wd.request('POST', `/session/${this.wd.session}/url`, { url }); }

  script(body, args = []) {
    return this.wd.request('POST', `/session/${this.wd.session}/execute/sync`, { script: body, args });
  }

  /** Waits for `condition` (a body returning truthy) or throws on timeout. */
  async waitFor(body, args, { timeout, poll = 200, describe }) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.script(body, args);
      if (value) return value;
      if (Date.now() >= deadline) throw new ProbeTimeout(describe);
      await delay(poll);
    }
  }

  logs(kind) { return this.wd.request('POST', `/session/${this.wd.session}/log`, { type: kind }); }
}

class ProbeTimeout extends Error {
  constructor(what) { super(`timed out waiting for ${what}`); this.timeout = true; }
}

export class SmokeFailure extends Error {}

// --- the observation the whole probe is one expression of ----------------

/**
 * Reads the app's own state out of the rendered page.
 *
 * This one expression is what makes the probe functional: it names the states
 * the application can be in (`loading`, `failed`, `uninitialized`, `untrusted`,
 * `deleted`, `ready`) and reports the text the app printed for each, so a
 * failure carries the application's diagnosis instead of a bare HTTP status.
 * It is evaluated in the page, against the real DOM, with no knowledge of the
 * application's source.
 */
export const OBSERVE_BOARD = `
const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
const main = document.querySelector('main');
const body = document.body;
const errorPanel = document.querySelector('.load-error');
const firstRun = document.querySelector('.first-run');
const rows = document.querySelectorAll('.issue-row');
const counts = Array.from(document.querySelectorAll('.filters button')).map((b) => text(b));
const state = !main
  ? 'unmounted'
  : errorPanel ? 'failed'
  : /Loading your shared board/.test(text(main)) ? 'loading'
  : firstRun ? (/This board was deleted/.test(body.innerText) ? 'deleted'
  : /trust anchor/i.test(body.innerText) ? 'untrusted' : 'uninitialized')
  : document.querySelector('nav.main-nav') ? 'ready'
  : 'unknown';
return {
  state,
  title: text(document.title),
  heading: text(errorPanel && errorPanel.querySelector('h1')),
  detail: text(errorPanel && errorPanel.querySelector('p:not(.eyebrow)')),
  firstRunTitle: text(firstRun && firstRun.querySelector('h1')),
  firstRunBody: text(firstRun && firstRun.querySelector('p:not(.eyebrow):not([role])')),
  alert: text(document.querySelector('[role="alert"]')),
  tabs: Array.from(document.querySelectorAll('nav.main-nav button')).map((b) => text(b)),
  issueRows: rows.length,
  filterCounts: counts,
  version: (document.querySelector('meta[name="antonina:build"]') || {}).content || null,
  text: text(body).slice(0, 400),
};
`;

const CLICK_TAB = `
const tab = Array.from(document.querySelectorAll('nav.main-nav button'))
  .find((b) => b.textContent.trim().toLowerCase() === String(arguments[0]).toLowerCase());
if (!tab) return false;
tab.click();
return true;
`;

/** True once the app has left its loading screen, loading or failure included. */
const SETTLED = `
return !/Loading your shared board/.test(document.body.textContent || '') || !!document.querySelector('.load-error');
`;

const READ_FEED = `
const list = document.querySelector('.feed-list');
return {
  entries: list ? list.querySelectorAll('li').length : 0,
  error: (document.querySelector('.feed-error') || {}).textContent || null,
  count: (document.querySelector('.feed-count') || {}).textContent || null,
  empty: !!document.querySelector('.feed-view-inner .empty-state'),
};
`;

/** True once the feed tab has rendered entries, an error, or its empty state. */
const FEED_SETTLED = `
const inner = document.querySelector('.feed-view-inner');
if (!inner) return false;
return inner.querySelectorAll('.feed-list li').length > 0
  || !!inner.querySelector('.feed-error')
  || !!inner.querySelector('.empty-state');
`;

const STORE_TRUST = `
localStorage.setItem(arguments[0], arguments[1]);
return localStorage.getItem(arguments[0]) === arguments[1];
`;

/** Every browser-side condition the probe turns into a pass or a failure. */
export function judgeBoard(observation, options) {
  if (observation.state === 'unmounted') {
    return `the application did not mount: the page has no <main> element, so the bundle never ran (page text: ${observation.text || '<empty>'})`;
  }
  if (observation.state === 'loading') {
    return 'the application is still on its loading screen; it never finished starting';
  }
  if (observation.state === 'failed') {
    return `the application reported: ${observation.heading || 'the board could not be loaded'} — ${observation.detail || '(no detail printed)'}`;
  }
  if (observation.state === 'untrusted') {
    if (options.trustAnchor === null) {
      return 'the board is present but this browser cannot verify it, and no trust anchor was supplied, so the board was never read. '
        + 'Pass --trust-anchor (or ANTONINA_BOARD_TRUST_ANCHOR) to make the probe read and verify the deployed board.';
    }
    return `the application refused the trust anchor: ${observation.firstRunBody || observation.firstRunTitle || '(no reason printed)'}`;
  }
  if (observation.state === 'uninitialized') {
    return 'the application reached its first-run screen instead of a board: no signed board exists at the deployed Skrynia key';
  }
  if (observation.state === 'deleted') {
    return 'the application reports the board has been deleted';
  }
  if (observation.state === 'unknown') {
    return `the application rendered neither a board nor an error: ${observation.text || '<empty>'}`;
  }
  const tabs = observation.tabs.map((tab) => tab.toLowerCase());
  if (!tabs.includes('issues') || !tabs.includes('feed')) {
    return `the board shell is missing its navigation; found [${observation.tabs.join(', ')}]`;
  }
  if (observation.alert) {
    return `the application raised an error while reading the board: ${observation.alert}`;
  }
  if (observation.issueRows < options.minIssues) {
    return `the board verified but its issue list is empty (${observation.issueRows} rows rendered, ${options.minIssues} required; filters: ${observation.filterCounts.join(' | ') || 'none'})`;
  }
  return null;
}

export function judgeFeed(feed, options) {
  if (feed.error) return `the feed reported an application error: ${feed.error}`;
  if (feed.entries < options.minFeed) {
    return `the feed is empty (${feed.entries} entries rendered, ${options.minFeed} required${feed.empty ? ', the empty state was shown' : ''})`;
  }
  return null;
}

// --- driver lifecycle ----------------------------------------------------

async function startDriver(options) {
  if (!existsSync(options.chromedriver) && !options.chromedriver.includes('/')) {
    const found = await which(options.chromedriver);
    if (found === null) throw new ProbeUsageError(`${options.chromedriver} is not on PATH; install ChromeDriver or pass --chromedriver`);
    options.chromedriver = found;
  }
  const profile = mkdtempSync(join(tmpdir(), 'antonina-smoke-'));
  const port = await freePort();
  const driver = spawn(options.chromedriver, [`--port=${port}`, '--allowed-ips=127.0.0.1', '--allowed-origins=*'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  driver.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (driver.exitCode !== null) throw new ProbeUsageError(`chromedriver exited (${driver.exitCode}): ${stderr.trim()}`);
    try {
      const status = await fetch(`${base}/status`);
      if (status.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() >= deadline) {
      driver.kill('SIGKILL');
      throw new ProbeUsageError(`chromedriver did not become ready on ${base}: ${stderr.trim()}`);
    }
    await delay(150);
  }
  return {
    base,
    profile,
    async close() {
      driver.kill('SIGTERM');
      await Promise.race([new Promise((done) => driver.once('exit', done)), delay(3000)]);
      if (driver.exitCode === null) driver.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** A port nothing else on this host is holding, so two probes never collide. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function which(command) {  return new Promise((done) => {
    const probe = spawn('sh', ['-c', `command -v ${command}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', (chunk) => { out += String(chunk); });
    probe.on('close', (code) => done(code === 0 && out.trim() !== '' ? out.trim() : null));
    probe.on('error', () => done(null));
  });
}

/**
 * Runs the whole probe and returns what it saw. Throws SmokeFailure with the
 * application's own words when the deployment is broken, and ProbeUsageError
 * when the probe itself could not run.
 */
export async function runProbe(options, { report = () => {} } = {}) {
  const started = Date.now();
  const driverProcess = await startDriver(options);
  const wd = new WebDriver(driverProcess.base);
  const driver = new Driver(wd);
  const consoleErrors = [];
  try {
    await wd.start({
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          binary: process.env.ANTONINA_CHROMIUM_BINARY || undefined,
          args: [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--window-size=1280,900',
            // A throwaway profile: the probe never reads or writes any real
            // browser state, and the trust anchor it stores dies with it.
            `--user-data-dir=${driverProcess.profile}`,
          ],
        },
      },
    });
    await wd.request('POST', `/session/${wd.session}/timeouts`, { script: options.timeout, pageLoad: options.timeout });

    const collectLogs = async () => {
      for (const kind of ['browser', 'severe']) {
        try {
          for (const entry of await driver.logs(kind)) {
            const text = `${entry.level}: ${entry.message}`;
            if (/\[(ERROR|SEVERE)\]/i.test(text)) consoleErrors.push(text);
          }
        } catch { /* a driver that cannot serve logs must not decide the verdict */ }
      }
    };

    // Load the origin once so the app's own origin is established, then set the
    // trust anchor and reload. The anchor is a public key: this is the whole of
    // what the probe writes, it goes to the browser profile and never to the
    // board, and no credential is involved at any point.
    await driver.navigate(options.url);
    if (options.trustAnchor !== null) {
      const stored = await driver.script(STORE_TRUST, [BOARD_TRUST_STORAGE_KEY, options.trustAnchor]);
      if (!stored) throw new SmokeFailure('the trust anchor could not be stored in the browser; the probe cannot verify the board');
      await driver.navigate(options.url);
    }
    report(`probe: loaded ${options.url}`);

    let observation;
    try {
      await driver.waitFor(SETTLED, [], { timeout: options.timeout, describe: 'the application to finish starting' });
    } catch (error) {
      if (!error.timeout) throw error;
    }
    observation = await driver.script(OBSERVE_BOARD, []);

    const boardProblem = judgeBoard(observation, options);
    if (boardProblem !== null) throw new SmokeFailure(boardProblem);
    report(`probe: board verified (${observation.issueRows} issue rows, build ${observation.version ?? 'unidentified'})`);

    // The feed tab: the only click this probe makes. It is navigation within the
    // board, it issues the same read the app issues on its own 30s cadence, and
    // it writes nothing.
    if (!(await driver.script(CLICK_TAB, ['Feed']))) throw new SmokeFailure('the Feed tab is not clickable');
    let feed;
    try {
      await driver.waitFor(FEED_SETTLED, [], { timeout: options.timeout, describe: 'the feed to load' });
    } catch (error) {
      if (!error.timeout) throw error;
    }
    feed = await driver.script(READ_FEED, []);
    const feedProblem = judgeFeed(feed, options);
    if (feedProblem !== null) throw new SmokeFailure(feedProblem);
    report(`probe: feed populated (${feed.entries} entries${feed.count ? `, ${feed.count}` : ''})`);

    await collectLogs();
    if (consoleErrors.length > 0) {
      throw new SmokeFailure(`the page reported browser errors while the board loaded:\n  ${consoleErrors.slice(0, 5).join('\n  ')}`);
    }
    return { observation, feed, consoleErrors, elapsedMs: Date.now() - started };
  } finally {
    await wd.stop();
    await driverProcess.close();
  }
}

export function reportLines(result) {
  return [
    `PASS: the deployed board loaded, verified, and rendered ${result.observation.issueRows} issue row(s) `
    + `and ${result.feed.entries} feed entry(ies) in ${result.elapsedMs}ms`,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runProbe(options, { report: (line) => process.stdout.write(`${line}\n`) });
    for (const line of reportLines(result)) console.log(line);
    process.exit(0);
  } catch (error) {
    if (error instanceof ProbeUsageError) {
      console.error(`smoke probe could not run: ${error.message}\n${PROBE_USAGE}`);
      process.exit(2);
    }
    if (error instanceof SmokeFailure) {
      console.error(`SMOKE FAILED: ${error.message}`);
      process.exit(1);
    }
    console.error(`SMOKE FAILED: ${error && error.stack ? error.stack : String(error)}`);
    process.exit(1);
  }
}
