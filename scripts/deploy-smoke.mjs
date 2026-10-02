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
//      the probe hands it a public trust anchor and the core parser does the
//      signature and log replay, exactly as it does in a browser;
//   3. the issue list is populated;
//   4. the feed is populated;
//   5. a failure prints the *application's own* error text, not just a status.
//
// Read-only against the board, by construction: the only interaction with it is
// navigation and reading. No form is ever submitted, no button that writes is
// ever clicked, and nothing is ever written to a board.
//
// Two secrets go into the throwaway browser profile and nowhere else: the public
// trust anchor, and the board credential. Both are needed, and neither is
// optional in practice. `BoardApi.readStored` refuses every read that has no
// credential, so the anchor alone gets the browser to the credential screen of a
// perfectly healthy board — a false red about a healthy deployment. Neither
// secret is printed, sent to the board, or written to any Antonina state
// directory, and both die with the profile. A deployment that fails this probe
// leaves production untouched.
//
// The verdicts are `judgeBoard`, `judgeFeed`, and the browser console check at
// the end of the session, which reads the one W3C log type that exists (`browser`)
// and filters on `entry.level`, so it is a check that can fire rather than one
// that looks like a check. The board-side verdicts remain the primary gate: this
// probe is not interested in what the console said, only in whether the board
// could be read.
//
// Usage:
//   node scripts/deploy-smoke.mjs --url https://host/a/antonina/ \
//     --trust-anchor TEXT --board-credential TEXT \
//     [--chromedriver PATH] [--timeout MS] [--min-issues N] [--min-feed N]
//
// The trust anchor may also come from ANTONINA_BOARD_TRUST_ANCHOR or
// ANTONINA_BOARD_TRUST_ANCHOR_FILE, and the board credential from
// ANTONINA_BOARD_CREDENTIAL or ANTONINA_BOARD_CREDENTIAL_FILE. Without the
// credential the application refuses every read, so the probe cannot see a board
// even when the deployment is serving one perfectly; it reports that as the
// probe's own missing input rather than as a broken deployment.
//
// Exit codes:
//   0  the board loaded, was verified, and rendered issues and feed entries
//   1  the deployment is broken, and the application's own words are printed
//   2  the probe could not run: bad usage, or no browser on this host
//
// Reads the state out of the app's own first-run `h1`s, never out of body prose,
// because the distinction an operator has to act on — "this deployment has no
// board" versus "this browser cannot open the board that is there" — is not
// visible in prose. See `classifyObservation`.
//
// Timeouts: `--timeout` bounds every call to chromedriver and every page-side
// wait, and the run as a whole is bounded at three times that. A driver that
// accepts a request and never answers is therefore a timeout verdict with the
// driver's stderr attached, not a step that hangs until the job limit.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const PROBE_USAGE = [
  'Usage: node scripts/deploy-smoke.mjs --url URL [--trust-anchor TEXT|--trust-anchor-file PATH]',
  '                             [--board-credential TEXT|--board-credential-file PATH]',
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

/**
 * Storage key the app itself reads the board *credential* from.
 *
 * This is the other half of the browser's board access, and the probe needs it:
 * `BoardApi.readStored` (packages/core/src/api.ts) refuses every read that has
 * no credential, reporting `BoardTrustRequiredError` when a board exists and
 * `BoardMissingError` when it does not. A public trust anchor lets the app
 * *verify* a board; it grants no read access. Since "Make every existing board
 * key full-access" (ebe8c17) moved that check from "has an anchor" to "has a
 * credential", a probe that stores only an anchor lands on the credential
 * screen on a perfectly healthy deployment, and the positive half of issue 74
 * is unreachable: there is no input that makes it pass.
 */
export const BOARD_CREDENTIAL_STORAGE_KEY = 'antonina:board-v2:credential';

/**
 * The keys the probe's own shape check requires of a board credential.
 *
 * This duplicates `parseBoardCredential`'s list
 * (packages/core/src/credential.ts) rather than importing it, and it is
 * deliberately not derived from core: the deploy job runs this script on a
 * checkout where nothing has been compiled, so `packages/core/dist` does not
 * exist and importing it would make the probe unrunnable in the one place it
 * matters. The duplication is safe only because
 * `scripts/deploy-smoke.test.mjs` hands these two lists to core's own compiled
 * parsers and asserts that they accept exactly these keys and reject them if
 * one is removed, so a new field on `BoardCredential` turns the suite red
 * rather than turning a healthy release into a false alarm at deploy time.
 */
export const BOARD_CREDENTIAL_KEYS = [
  'boardId', 'keyId', 'privateKey', 'publicKey',
  'rootKeyId', 'rootPublicKey', 'schemaVersion', 'storageCapability',
];

/**
 * The keys the probe's own shape check requires of a public trust anchor.
 *
 * Duplicates `parseBoardTrustAnchor`'s list, and is pinned to it by the same
 * test as {@link BOARD_CREDENTIAL_KEYS}, for the same single-file reason.
 */
export const BOARD_TRUST_ANCHOR_KEYS = ['boardId', 'rootKeyId', 'rootPublicKey'];

export class ProbeUsageError extends Error {}

export function parseArgs(argv) {
  const options = { ...DEFAULTS, url: null, trustAnchor: null, boardCredential: null, chromedriver: 'chromedriver' };
  const value = (flag, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new ProbeUsageError(`${flag} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') { options.url = value(arg, i); i += 1; }
    else if (arg === '--trust-anchor') { options.trustAnchor = value(arg, i); options.trustAnchorSource = arg; i += 1; }
    else if (arg === '--trust-anchor-file') { options.trustAnchor = readFileSync(value(arg, i), 'utf8'); options.trustAnchorSource = arg; i += 1; }
    else if (arg === '--board-credential') { options.boardCredential = value(arg, i); options.boardCredentialSource = arg; i += 1; }
    else if (arg === '--board-credential-file') { options.boardCredential = readFileSync(value(arg, i), 'utf8'); options.boardCredentialSource = arg; i += 1; }
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
    if (process.env.ANTONINA_BOARD_TRUST_ANCHOR) {
      options.trustAnchor = process.env.ANTONINA_BOARD_TRUST_ANCHOR;
      options.trustAnchorSource = 'ANTONINA_BOARD_TRUST_ANCHOR';
    } else if (process.env.ANTONINA_BOARD_TRUST_ANCHOR_FILE) {
      options.trustAnchor = readFileSync(process.env.ANTONINA_BOARD_TRUST_ANCHOR_FILE, 'utf8');
      options.trustAnchorSource = `ANTONINA_BOARD_TRUST_ANCHOR_FILE (${process.env.ANTONINA_BOARD_TRUST_ANCHOR_FILE})`;
    }
  }
  if (options.trustAnchor !== null) options.trustAnchor = options.trustAnchor.trim();
  if (options.boardCredential === null) {
    if (process.env.ANTONINA_BOARD_CREDENTIAL) {
      options.boardCredential = process.env.ANTONINA_BOARD_CREDENTIAL;
      options.boardCredentialSource = 'ANTONINA_BOARD_CREDENTIAL';
    } else if (process.env.ANTONINA_BOARD_CREDENTIAL_FILE) {
      options.boardCredential = readFileSync(process.env.ANTONINA_BOARD_CREDENTIAL_FILE, 'utf8');
      options.boardCredentialSource = `ANTONINA_BOARD_CREDENTIAL_FILE (${process.env.ANTONINA_BOARD_CREDENTIAL_FILE})`;
    }
  }
  if (options.boardCredential !== null) options.boardCredential = options.boardCredential.trim();
  // Checked here as well as in runProbe, so the command line rejects a bad
  // secret at parse time and never reaches the browser; runProbe repeats it
  // because it is the public entry and cannot assume it came through here.
  if (options.trustAnchor !== null) {
    checkTrustAnchorShape(options.trustAnchor, options.trustAnchorSource ?? 'the trust anchor');
  }
  return options;
}

/**
 * The shape the probe's anchor has to have, checked before the probe hands it
 * to the application.
 *
 * The application stores this text and reads it back with `JSON.parse`, and it
 * returns `null` for anything that does not parse — so a secret that is valid
 * YAML, a bare `key: value` line, or JSON with a trailing character is
 * indistinguishable from *no anchor at all*, and the probe would then report
 * that the application "refused the trust anchor" when in fact nothing was ever
 * offered. The keys checked here are the ones
 * `parseBoardTrustAnchor` (packages/core/src/credential.ts) requires, kept
 * literal rather than imported so this script stays a single file with no build
 * step; `scripts/deploy-smoke.test.mjs` hands the list to core's own compiled
 * parser and asserts the two agree.
 */
function checkTrustAnchorShape(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ProbeUsageError(`the trust anchor from ${source} is not valid JSON (${error.message}); `
      + 'it must be the single-line anchor `antonina board credential trust` prints');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProbeUsageError(`the trust anchor from ${source} is not a JSON object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = BOARD_TRUST_ANCHOR_KEYS;
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new ProbeUsageError(`the trust anchor from ${source} has keys [${keys.join(', ')}] `
      + `but must have exactly [${wanted.join(', ')}]; it is the public anchor, not the board credential and not the contents of trust.json`);
  }
  for (const key of wanted) {
    if (typeof value[key] !== 'string' || value[key] === '') {
      throw new ProbeUsageError(`the trust anchor from ${source} has no usable ${key}`);
    }
  }
}

/**
 * The shape a board credential has to have, checked before it reaches the browser.
 *
 * The same reasoning as `checkTrustAnchorShape`, and it exists because the two
 * secrets are confusable at the command line: a trust anchor and a board
 * credential are both JSON, both are "the board secret", and passing one where
 * the other belongs produces a browser that stores something the application
 * then silently refuses — which reads as a broken deployment rather than as a
 * mistyped flag. The keys are `parseBoardCredential`'s
 * (packages/core/src/credential.ts:76-95), kept literal for the same
 * single-file reason; `scripts/deploy-smoke.test.mjs` asserts the two lists
 * agree by running core's own compiled parser over them.
 *
 * Reject-only, like every other check here: it can turn a pass into a red and
 * never the reverse. It never logs or echoes the secret, which is why it does
 * not report which *value* was wrong, only which key was missing.
 */
function checkBoardCredentialShape(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ProbeUsageError(`the board credential from ${source} is not valid JSON (${error.message})`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProbeUsageError(`the board credential from ${source} is not a JSON object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = BOARD_CREDENTIAL_KEYS;
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new ProbeUsageError(`the board credential from ${source} has keys [${keys.join(', ')}] `
      + `but must have exactly [${wanted.join(', ')}]; it is the board credential, not the trust anchor `
      + 'and not the contents of credential.json');
  }
}

// --- WebDriver client -----------------------------------------------------
// The W3C WebDriver protocol over plain HTTP, so the probe needs no dependency
// and no network install: chromedriver is already on the host and speaks it.

export class WebDriver {
  constructor(base, { timeout = DEFAULTS.timeout, diagnostics = () => '' } = {}) {
    this.base = base.replace(/\/$/, '');
    this.session = null;
    // Every call over this transport is bounded. Node's fetch has no default
    // timeout, so without this a chromedriver that accepts the connection and
    // stops answering holds the deploy step open until the job limit, and the
    // step reports "in progress" for hours instead of a diagnosable failure.
    this.timeout = timeout;
    this.diagnostics = diagnostics;
  }

  async request(method, path, body) {
    let response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (error) {
      // A wedged driver fails here, as an abort, not as an HTTP error — so it
      // becomes the same diagnosable timeout the overall budget produces, with
      // the driver's stderr attached. Left as a raw rejection it would be
      // printed as a stack trace and read as a crash rather than a hang.
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        const note = this.diagnostics();
        throw new ProbeTimeout(`chromedriver to answer ${method} ${path} within ${this.timeout}ms`
          + (note === '' ? '' : `; chromedriver said: ${note}`));
      }
      throw error;
    }
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

  /**
   * Waits for `condition` (a body returning truthy) or throws on timeout.
   *
   * The deadline is checked *before* each call, not only after it returns, so
   * the loop's bound bounds the loop: a call that never returns is bounded by
   * the transport's own timeout (and by the overall budget in `runProbe`), and
   * one that keeps answering false is bounded by this deadline.
   */
  async waitFor(body, args, { timeout, poll = 200, describe }) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (Date.now() >= deadline) throw new ProbeTimeout(describe);
      const value = await this.script(body, args);
      if (value) return value;
      await delay(poll);
    }
  }

  logs(kind) { return this.wd.request('POST', `/session/${this.wd.session}/log`, { type: kind }); }
}

/** A wait that ran out of time. `timeout` is what the callers branch on. */
export class ProbeTimeout extends Error {
  constructor(what) { super(`timed out waiting for ${what}`); this.timeout = true; }
}

export class SmokeFailure extends Error {}

// --- the observation the whole probe is one expression of ----------------

/**
 * The screens the application can be on, named by the `h1` it prints for each.
 *
 * These are the `h1` strings the application itself renders for each
 * first-run screen, taken from `web/src/App.tsx` (each of the three branches
 * that returns `<section className="first-run">`) and from the copy they render
 * in `web/src/ui-state.ts`:
 *
 *   `uninitialized` FIRST_RUN_COPY.title, `App.tsx` `FirstRun`
 *   `untrusted`    BOARD_KEY_COPY.title, `App.tsx` `BoardKeyPrompt`
 *   `deleted`      DELETED_COPY.title, `App.tsx` the `deleted` branch
 *
 * The titles are the states, and they are the *only* reliable discriminator:
 * an earlier revision classified on body prose, and every first-run body in the
 * application talks about credentials, so "no board exists at all" was
 * reported to the operator as "the application refused the trust anchor" —
 * sending them to rotate a perfectly good anchor on a deployment that simply
 * had no board. `deploy-smoke.test.mjs` asserts each string below is still a
 * `title:` in `web/src/ui-state.ts` *and* that no two of them are equal, so a
 * rename in the app cannot quietly collapse two states into one.
 *
 * `untrusted` is the screen a browser with no board credential sees on a board
 * that is perfectly healthy — which is exactly the state the deployed probe is
 * in unless it is also handed a credential, and is why holding an anchor and no
 * credential is the *readable* case, not the broken one.
 */
export const APP_STATE_TITLES = {
  deleted: 'This board was deleted',
  untrusted: 'Enter the board credential',
  uninitialized: 'No Antonina board yet',
};

/**
 * Turns the facts `OBSERVE_BOARD` collected into the state the probe reports.
 *
 * Pure, and in Node rather than in the page, so the mapping the whole verdict
 * rests on is unit-testable: feeding it a hand-written observation is a real
 * test, where the same logic buried in a browser-side string constant was
 * invisible to the suite. A first-run screen whose `h1` matches none of the
 * three known titles is `unknown` rather than guessed into one of them: an
 * unfamiliar screen is not evidence that a board is missing.
 */
export function classifyObservation(observation) {
  if (!observation.hasMain) return 'unmounted';
  if (observation.hasLoadError) return 'failed';
  if (observation.loading) return 'loading';
  if (observation.hasFirstRun) {
    const title = observation.firstRunTitle ?? '';
    if (title === APP_STATE_TITLES.deleted) return 'deleted';
    if (title === APP_STATE_TITLES.untrusted) return 'untrusted';
    if (title === APP_STATE_TITLES.uninitialized) return 'uninitialized';
    return 'unknown';
  }
  return observation.hasMainNav ? 'ready' : 'unknown';
}

/**
 * Reads the app's own state out of the rendered page.
 *
 * This one expression is what makes the probe functional: it reports the
 * screens the application is actually showing and the text the app printed for
 * each, so a failure carries the application's diagnosis instead of a bare HTTP
 * status. It is evaluated in the page, against the real DOM, with no knowledge
 * of the application's source, and it reports facts rather than a verdict —
 * `classifyObservation` is what names the state.
 */
export const OBSERVE_BOARD = `
const text = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');
const main = document.querySelector('main');
const body = document.body;
const errorPanel = document.querySelector('.load-error');
const firstRun = document.querySelector('.first-run');
const rows = document.querySelectorAll('.issue-row');
const counts = Array.from(document.querySelectorAll('.filters a[href]')).map((b) => text(b));
// The page reports the facts, not the verdict: which screens are present and
// what their titles say. classifyObservation() below turns those facts into a
// state, and it does that in Node where it can be unit-tested, because the
// difference between "no board exists" and "this browser cannot verify it" is
// the application's h1 and not a phrase its body prose happens to share.
return {
  hasMain: !!main,
  hasLoadError: !!errorPanel,
  loading: !!main && /Loading your shared board/.test(text(main)),
  hasFirstRun: !!firstRun,
  hasMainNav: !!document.querySelector('nav.main-nav'),
  title: text(document.title),
  heading: text(errorPanel && errorPanel.querySelector('h1')),
  detail: text(errorPanel && errorPanel.querySelector('p:not(.eyebrow)')),
  firstRunTitle: text(firstRun && firstRun.querySelector('h1')),
  firstRunBody: text(firstRun && firstRun.querySelector('p:not(.eyebrow):not([role])')),
  alert: text(document.querySelector('[role="alert"]')),
  tabs: Array.from(document.querySelectorAll('nav.main-nav a[href]')).map((b) => text(b)),
  issueRows: rows.length,
  filterCounts: counts,
  version: (document.querySelector('meta[name="antonina:build"]') || {}).content || null,
  text: text(body).slice(0, 400),
};
`;

const CLICK_TAB = `
const tab = Array.from(document.querySelectorAll('nav.main-nav a[href]'))
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
    // This is the `untrusted` load status, which the application reaches when it
    // cannot read the board without a board *credential* — a public trust anchor
    // only lets it verify; it does not grant read access. So this screen means
    // the probe could not read the board, and the two causes have to be told
    // apart, because they are not the same operator action.
    if (options.trustAnchor === null && (options.boardCredential ?? null) === null) {
      return 'the board is present but this browser cannot open it, and the probe was given no board secret at all, so the board was never read. '
        + 'Pass --trust-anchor (or ANTONINA_BOARD_TRUST_ANCHOR) together with --board-credential '
        + '(or ANTONINA_BOARD_CREDENTIAL) to make the probe read and verify the deployed board. '
        + 'A trust anchor alone is not enough: the application refuses every read that has no board credential.';
    }
    if ((options.boardCredential ?? null) === null) {
      // The precise shape of this false red, and the one an operator would
      // otherwise report as a broken deployment. Say it as the cause, not as a
      // symptom to investigate.
      return 'the probe stored a trust anchor but no board credential, and the application refused the read: '
        + 'a trust anchor is a public key that only permits verification, and the deployed board is unreadable without its credential. '
        + 'This is the probe\'s input, not the deployment. Pass --board-credential to make the probe able to read the board.';
    }
    return `the application asked for a board credential instead of showing the board, so the deployed board was never read: ${observation.firstRunBody || observation.firstRunTitle || '(no reason printed)'}`;
  }
  if (observation.state === 'uninitialized') {
    return 'the application reached its first-run screen instead of a board: no signed board exists at the deployed Skrynia key';
  }
  if (observation.state === 'deleted') {
    return 'the application reports the board has been deleted';
  }
  if (observation.state === 'unknown') {
    const screen = observation.hasFirstRun
      ? `it showed a first-run screen titled "${observation.firstRunTitle || '<untitled>'}"`
      : 'it rendered neither a board nor an error';
    return `the application rendered neither a readable board nor a known error: ${screen}: ${observation.text || '<empty>'}`;
  }  const tabs = observation.tabs.map((tab) => tab.toLowerCase());
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
  if (!existsSync(options.chromedriver)) {
    if (options.chromedriver.includes('/')) {
      throw new ProbeUsageError(`${options.chromedriver} does not exist; pass --chromedriver a path to a ChromeDriver binary`);
    }
    const found = await which(options.chromedriver);
    if (found === null) throw new ProbeUsageError(`${options.chromedriver} is not on PATH; install ChromeDriver or pass --chromedriver`);
    options.chromedriver = found;
  }
  const profile = mkdtempSync(join(tmpdir(), 'antonina-smoke-'));
  const discard = () => { rmSync(profile, { recursive: true, force: true }); };
  const port = await freePort();
  const driver = spawn(options.chromedriver, [`--port=${port}`, '--allowed-ips=127.0.0.1', '--allowed-origins=*'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // A spawn failure is reported asynchronously, through this event, and an
  // event with no listener kills the process with a raw stack and exit 1 —
  // which this probe reserves for "the deployment is broken". A missing or
  // non-executable chromedriver is the opposite: this host cannot check. So the
  // failure is captured here and converted, below, to the usage error (exit 2)
  // that says exactly that, naming the path that could not be run.
  let spawnError = null;
  driver.on('error', (error) => { spawnError = error; });
  let stderr = '';
  driver.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      if (spawnError !== null) {
        const code = spawnError.code === undefined ? '' : ` (${spawnError.code})`;
        throw new ProbeUsageError(`cannot run ${options.chromedriver}${code}: ${spawnError.message}`);
      }
      if (driver.exitCode !== null) throw new ProbeUsageError(`chromedriver exited (${driver.exitCode}): ${stderr.trim()}`);
      try {
        const status = await fetch(`${base}/status`, { signal: AbortSignal.timeout(1_000) });
        if (status.ok) break;
      } catch { /* not listening yet */ }
      if (Date.now() >= deadline) {
        throw new ProbeUsageError(`chromedriver did not become ready on ${base}: ${stderr.trim()}`);
      }
      await delay(150);
    }
  } catch (error) {
    // Every path out of here must take the throwaway profile with it, including
    // the spawn failure: a leaked browser profile is litter in tmpdir() and the
    // `finally` in runProbe never runs for a driver that never started.
    driver.kill('SIGKILL');
    discard();
    throw error;
  }
  return {
    base,
    profile,
    /** Everything chromedriver printed, for a failure that has to be diagnosable. */
    diagnostics: () => stderr.trim(),
    async close() {
      driver.kill('SIGTERM');
      await Promise.race([new Promise((done) => driver.once('exit', done)), delay(3000)]);
      if (driver.exitCode === null) driver.kill('SIGKILL');
      discard();
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
 * The overall budget for one probe run.
 *
 * Every individual WebDriver call is bounded by `options.timeout`, so a wedged
 * driver now fails inside one timeout rather than hanging. This is the bound
 * for the run as a whole: several bounded calls in sequence (start the session,
 * load the page, settle, read the board, open the feed) each waiting up to
 * `options.timeout` would otherwise still add up to a multiple of it, and the
 * deploy step should say so out loud rather than keep going.
 */
export function overallBudgetMs(options) {
  return options.overallTimeout ?? options.timeout * 3;
}

/**
 * Runs the whole probe and returns what it saw. Throws SmokeFailure with the
 * application's own words when the deployment is broken, and ProbeUsageError
 * when the probe itself could not run.
 */
export async function runProbe(options, { report = () => {} } = {}) {
  const started = Date.now();
  // runProbe is the public entry and callers construct the options object
  // themselves, so "not supplied" arrives as either `null` or a missing key.
  // Normalising here means every check below is one comparison, and an omitted
  // secret is absent rather than an `undefined` that reads as a malformed one.
  options = { ...options, trustAnchor: options.trustAnchor ?? null, boardCredential: options.boardCredential ?? null };
  // Before anything is created or launched, so a bad secret costs no browser
  // and no profile: runProbe is the public entry and the check cannot live only
  // in parseArgs, which a caller may not have gone through.
  if (options.trustAnchor !== null) {
    checkTrustAnchorShape(options.trustAnchor, options.trustAnchorSource ?? 'the trust anchor');
  }
  if (options.boardCredential !== null) {
    checkBoardCredentialShape(options.boardCredential, options.boardCredentialSource ?? 'the board credential');
  }
  const driverProcess = await startDriver(options);
  try {
    const session = probeSession(options, driverProcess, report);
    // The backstop for a transport that accepts the request and never answers:
    // the deadline is enforced by something other than the calls themselves,
    // and the failure it produces carries chromedriver's stderr, because "it
    // hung" without what the driver said is not a diagnosis.
    const budget = overallBudgetMs(options);
    let timer = null;
    const expiry = new Promise((_, fail) => {
      timer = setTimeout(() => {
        const note = driverProcess.diagnostics();
        fail(new ProbeTimeout(`the probe to finish within ${budget}ms`
          + (note === '' ? '; chromedriver printed nothing to stderr' : `; chromedriver said: ${note}`)));
      }, budget);
    });
    try {
      return await Promise.race([session, expiry]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await driverProcess.close();
  }
}

/** Everything the probe does once a driver is up, and the only place it fails on the deployment. */
async function probeSession(options, driverProcess, report) {
  const started = Date.now();
  const wd = new WebDriver(driverProcess.base, { timeout: options.timeout, diagnostics: driverProcess.diagnostics });
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

    // The browser's own console, read through the one W3C log type that exists
    // (`browser`; `driver` and `performance` are the others, and a type the
    // driver rejects is not a check). Chrome reports a console error as level
    // SEVERE, so that is the level that is kept — matching on the *level*
    // rather than on a bracketed tag in the message, which Chrome log entries
    // do not carry and which made this filter discard everything.
    //
    // And then the `source`, which is the part that had to be measured. Every
    // SEVERE entry is not an application fault: a failed subresource fetch is
    // reported at SEVERE with `source: 'network'`, and a page that never
    // requests a favicon.ico therefore produces one on every single run. This
    // check fired on the very first healthy board the suite ever loaded, on
    // `favicon.ico` 404, with the issue list and the feed both populated. A
    // check that is red on a healthy deployment every time is a check operators
    // learn to ignore, so it keeps what it is actually for — a *script* fault
    // (`source: 'javascript'`, an uncaught exception, and `'console-api'`, an
    // explicit `console.error`). A board that fails to load is not lost by
    // ignoring network entries: it renders its own error text, and `judgeBoard`
    // reports that text, which is a far better diagnosis than a 404 line.
    const collectLogs = async () => {
      try {
        for (const entry of await driver.logs('browser')) {
          if (entry.level !== 'SEVERE' && entry.level !== 'ERROR') continue;
          if (entry.source === 'network') continue;
          consoleErrors.push(`${entry.level} [${entry.source ?? 'unknown'}]: ${entry.message}`);
        }
      } catch (error) {
        // A driver that cannot serve logs must not decide the verdict, but it
        // must not be invisible either: the run reports that the check was
        // unavailable rather than passing as though it had been satisfied.
        report(`probe: browser logs unavailable (${error.message}); console errors were not checked`);
      }
    };

    // Load the origin once so the app's own origin is established, then set the
    // board secrets and reload.
    //
    // Two secrets, and they are not interchangeable on current main. The trust
    // anchor is a public key: it lets the application verify the board's
    // signatures. The board *credential* is what grants the read — `readStored`
    // refuses every credential-less read. Storing only the anchor produces a
    // browser on the credential screen of a perfectly healthy board, which is a
    // false red about the deployment, so the credential is stored too whenever
    // the caller supplied one.
    //
    // Both go to the throwaway browser profile and nowhere else. Neither is
    // sent to the board, printed, or written to any Antonina state directory,
    // and both die with the profile.
    await driver.navigate(options.url);
    if (options.trustAnchor !== null || options.boardCredential !== null) {
      if (options.trustAnchor !== null) {
        const stored = await driver.script(STORE_TRUST, [BOARD_TRUST_STORAGE_KEY, options.trustAnchor]);
        if (!stored) throw new SmokeFailure('the trust anchor could not be stored in the browser; the probe cannot verify the board');
      }
      if (options.boardCredential !== null) {
        const stored = await driver.script(STORE_TRUST, [BOARD_CREDENTIAL_STORAGE_KEY, options.boardCredential]);
        if (!stored) throw new SmokeFailure('the board credential could not be stored in the browser; the probe cannot read the board');
      }
      await driver.navigate(options.url);
    }
    report(`probe: loaded ${options.url}`);

    // A page-side wait that runs out is *not* swallowed and stepped over. An
    // earlier revision caught the timeout here and carried on to observe the
    // page anyway, which was fail-closed (an unsettled page classifies as a
    // failure) but reported the *wrong* failure: an operator was told the board
    // could not be loaded, or that the issue list was empty, when the truth was
    // that the application never finished starting. `waitFor` also runs its
    // deadline check before each call, so this is a real bound, and letting the
    // ProbeTimeout out names the wait that ran out.
    await driver.waitFor(SETTLED, [], { timeout: options.timeout, describe: 'the application to finish starting' });
    const observation = { ...(await driver.script(OBSERVE_BOARD, [])) };
    observation.state = classifyObservation(observation);

    const boardProblem = judgeBoard(observation, options);
    if (boardProblem !== null) throw new SmokeFailure(boardProblem);
    report(`probe: board verified (${observation.issueRows} issue rows, build ${observation.version ?? 'unidentified'})`);

    // The feed tab: the only click this probe makes. It is navigation within the
    // board, it issues the same read the app issues on its own 30s cadence, and
    // it writes nothing.
    if (!(await driver.script(CLICK_TAB, ['Feed']))) throw new SmokeFailure('the Feed tab is not clickable');
    // Same here: a feed that never settles is reported as the feed that never
    // settled, not as a feed that rendered nothing.
    await driver.waitFor(FEED_SETTLED, [], { timeout: options.timeout, describe: 'the feed to load' });
    const feed = await driver.script(READ_FEED, []);
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
    if (error instanceof ProbeTimeout) {
      // A timeout is a failure of the deployment to answer, so exit 1, and it
      // is reported as a timeout rather than as a stack trace: the operator
      // needs to know the probe ran out of time, not what a promise rejection
      // looks like.
      console.error(`SMOKE FAILED: ${error.message}`);
      process.exit(1);
    }
    console.error(`SMOKE FAILED: ${error && error.stack ? error.stack : String(error)}`);
    process.exit(1);
  }
}
