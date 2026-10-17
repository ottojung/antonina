import {
  AntoninaApiError,
  BoardApi,
  BoardDeletedError,
  BoardMissingError,
  BoardStorageRejectedError,
  BoardTrustRequiredError,
  DEFAULT_BOARD_BASE_URL,
  type BoardAccessState,
  type BoardImportReport,
  type BoardInitialization,
  type IssueListSummary,
} from '../../core/src/api.js';
import {
  serializeBoardCredential,
  serializeBoardTrustAnchor,
  type BoardCredential,
} from '../../core/src/credential.js';
import { canonicalJson, type CanonicalValue } from '../../core/src/canonical.js';
import {
  DEFAULT_FEED_LIMIT,
  type BoardFeedEntry,
  type BoardFeedPage,
} from '../../core/src/feed.js';
import {
  type BoardIssue,
  type BoardResource,
  parseReviewVerdict,
  reviewBlocksCompletion,
  type BoardReview,
  type IssueState,
  type ResourceView,
} from '../../core/src/model.js';
import {
  formatHostBytes,
} from '../../core/src/host-daemon.js';
import {
  type BoardTrustAnchor,
} from '../../core/src/operations.js';
import {
  CollectBoardError,
  CollectRefusedError,
  collectDelete,
  collectList,
  renderRevision,
  type CollectDeleteReport,
  type CollectDeleteReportBase,
  type   CollectListEntry,
} from './collection.js';
import {
  configuredValue,
  loadBoardConfigFiles,
} from './board-config.js';

export const BOARD_BASE_URL_ENV = 'ANTONINA_BOARD_URL';
export const BOARD_HEAD_ENV = 'ANTONINA_BOARD_HEAD';
export const BOARD_AUTHOR_ENV = 'ANTONINA_BOARD_AUTHOR';
const DEFAULT_COLLECTION_PAGE_SIZE = 50;
// `ANTONINA_COLLECT_ROOTS`, the managed collection roots the `collect` commands
// are configured from. It is named here, in the one block where an operator
// looks for every environment name, but it is not declared or re-exported here:
// the loader in `packages/agent-runtime/src/managed-roots-config.ts` owns the
// name, and `collect delete` imports it from there. One constant, one owner, one
// import path.

export interface BoardCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface BoardCommandContext {
  env: Record<string, string | undefined>;
  io: BoardCommandIo;
  createClient?: () => BoardApi;
  /**
   * The home directory the configuration root is resolved against. Injected by
   * tests so that no command can reach the ambient `$HOME/.config/antonina`.
   */
  home?: string;
}

type CommandValue =
  | BoardIssue
  | BoardIssue[]
  | IssueListSummary[]
  | BoardResource
  | BoardResource[]
  | BoardReview
  | ResourceView[]
  | BoardInitialization
  | BoardCredential
  | BoardAccessState
  | BoardTrustAnchor
  | CollectListEntry[]
  | CollectDeleteReportBase
  | BoardImportReport
  | BoardFeedPage
  | number[]
  | null;

interface ParsedCommand {
  json: boolean;
  command: string;
  args: string[];
}

interface CommandResult {
  mode: string;
  value: CommandValue;
  /** The issue number a result is about, for the modes that print one line. */
  number?: number;
}

function requireArg(raw: string | undefined, name: string): string {
  if (raw === undefined) throw new AntoninaApiError(name + ' is required');
  return raw;
}

function parsePositiveInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    throw new AntoninaApiError(name + ' must be a positive integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new AntoninaApiError(name + ' must be a positive integer');
  return value;
}

function pageNumber(raw: string | undefined): number {
  if (raw === undefined) throw new AntoninaApiError('--page is required');
  return parsePositiveInteger(raw, '--page');
}

function pageSlice<T>(values: readonly T[], page: number, pageSize = DEFAULT_COLLECTION_PAGE_SIZE): T[] {
  const start = (page - 1) * pageSize;
  if (!Number.isSafeInteger(start)) return [];
  return values.slice(start, start + pageSize);
}

function issuePriorityOrder(summaries: readonly IssueListSummary[], queue: readonly number[]): IssueListSummary[] {
  const priority = new Map(queue.map((number, index) => [number, index]));
  return [...summaries].sort((left, right) => {
    if (left.state !== right.state) return left.state === 'open' ? -1 : 1;
    if (left.state === 'open') {
      const leftPriority = priority.get(left.number) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = priority.get(right.number) ?? Number.MAX_SAFE_INTEGER;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    }
    return left.number - right.number;
  });
}

async function readNumberedFeedPage(client: BoardApi, page: number, limit: number): Promise<BoardFeedPage> {
  let current = await client.readFeed({ limit, cursor: null });
  for (let number = 1; number < page; number += 1) {
    if (current.nextCursor === null) {
      return { entries: [], nextCursor: null, total: current.total, limit: current.limit };
    }
    current = await client.readFeed({ limit, cursor: current.nextCursor });
  }
  return current;
}

function removeJsonFlag(argv: string[]): { json: boolean; argv: string[] } {
  const filtered: string[] = [];
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else filtered.push(arg);
  }
  return { json, argv: filtered };
}

function parseCommand(argv: string[]): ParsedCommand {
  const normalized = removeJsonFlag(argv);
  const [command, ...args] = normalized.argv;
  if (!command) throw new AntoninaApiError('a board command is required');
  return { json: normalized.json, command, args };
}

function option(args: string[], name: string): { value?: string; rest: string[] } {
  const index = args.indexOf(name);
  if (index < 0) return { rest: args };
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new AntoninaApiError(name + ' requires a value');
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function flag(args: string[], name: string): { value: boolean; rest: string[] } {
  const index = args.indexOf(name);
  if (index < 0) return { value: false, rest: args };
  return { value: true, rest: [...args.slice(0, index), ...args.slice(index + 1)] };
}

/** An option that may be given more than once, keeping the order it was given in. */
function repeatedOption(args: string[], name: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  let rest = [...args];
  for (let index = rest.indexOf(name); index >= 0; index = rest.indexOf(name)) {
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new AntoninaApiError(name + ' requires a value');
    values.push(value);
    rest = [...rest.slice(0, index), ...rest.slice(index + 2)];
  }
  return { values, rest };
}

/**
 * The trust anchor and credential a normal board command runs as.
 *
 * The trust anchor and credential come from `trust.json` and `credential.json`
 * in the Antonina configuration directory and from nowhere else. There is
 * deliberately no environment override for either: a credential is a secret
 * with a long lifetime, and a value that can arrive two different ways is a
 * value whose source an operator can no longer state with confidence. The files
 * are therefore the one normal source, and a shell needs nothing exported.
 */
export function configuredIdentity(
  context: BoardCommandContext,
): { credential: BoardCredential | null; trustAnchor: BoardTrustAnchor | null } {
  // The injected home has to reach the loader, not merely be accepted by the
  // context: it is what keeps a test's `XDG_CONFIG_HOME`-less run off the
  // ambient `~/.config/antonina`, and what makes the documented home fallback
  // resolvable without reading `homedir()`.
  const files = context.home === undefined
    ? loadBoardConfigFiles({ env: context.env })
    : loadBoardConfigFiles({ env: context.env, home: context.home });
  return {
    credential: configuredValue(files.credential),
    trustAnchor: configuredValue(files.trust),
  };
}

function defaultClient(context: BoardCommandContext): BoardApi {
  return new BoardApi({
    baseUrl: context.env[BOARD_BASE_URL_ENV] ?? DEFAULT_BOARD_BASE_URL,
    rememberedHead: context.env[BOARD_HEAD_ENV] ?? null,
    ...configuredIdentity(context),
  });
}

/**
 * The normal place to put a value, and the one place it comes from.
 *
 * The advice is written in terms of the XDG variables rather than the resolved
 * path because it must be identical for every command and every operator, and
 * because the resolved path is exactly the thing the shell will not resolve for
 * them. Naming a single file rather than also naming an environment variable is
 * deliberate: the CLI reads the file, so the file is the advice.
 */
const CREDENTIAL_ADVICE = 'save the shared board credential as'
  + ' $XDG_CONFIG_HOME/antonina/credential.json';

/**
 * The same advice, for the failure kinds a collection snapshot classifies itself
 * instead of throwing. `board-missing` and `board-unverifiable` are byte-for-byte
 * the advice above, so a collector is never taught a different next step for
 * the same board state.
 */
function collectionAdvice(kind: string): string | null {
  if (kind === 'board-missing') return 'run: antonina board initialize to create it';
  if (kind === 'board-unverifiable' || kind === 'board-state-rejected') {
    return CREDENTIAL_ADVICE;
  }
  // A transport failure is the one kind with no established advice, so it is
  // named as itself rather than flattened into another kind's advice.
  if (kind === 'board-read-failed') {
    return kind + ': check ' + BOARD_BASE_URL_ENV + ' and that this host can reach it';
  }
  return null;
}

/**
 * The CLI's advice for the states the shared API reports, so an operator is
 * never told to configure a trust anchor for a board that does not exist, left
 * guessing what to do about one it cannot verify, or left without a next step
 * for a deleted board or a refused storage capability.
 */
function boardStateAdvice(error: unknown): string | null {
  if (error instanceof BoardMissingError) return 'run: antonina board initialize to create it';
  if (error instanceof BoardTrustRequiredError) return CREDENTIAL_ADVICE;
  if (error instanceof BoardDeletedError) return 'start a new board instead; this key is permanently occupied';
  if (error instanceof BoardStorageRejectedError) return CREDENTIAL_ADVICE;
  // A collection snapshot classifies its own failures rather than throwing the
  // board errors above, so it carries the kind across and is advised about
  // here: `collect list` names initialization while the board is missing and
  // the trust anchor while it cannot be verified, exactly as every other read
  // command does.
  if (error instanceof CollectBoardError) return collectionAdvice(error.kind);
  if (error instanceof CollectRefusedError) return error.kind === null ? null : collectionAdvice(error.kind);
  return null;
}

async function execute(
  parsed: ParsedCommand,
  client: BoardApi,
  context: BoardCommandContext,
): Promise<CommandResult> {
  switch (parsed.command) {
    case 'initialize': {
      const credentialFlag = flag(parsed.args, '--credential');
      const trustFlag = flag(credentialFlag.rest, '--trust-anchor');
      if (trustFlag.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for initialize');
      if (credentialFlag.value && trustFlag.value) {
        throw new AntoninaApiError('initialize prints one value at a time; pass either --credential or --trust-anchor');
      }
      if (parsed.json && (credentialFlag.value || trustFlag.value)) {
        throw new AntoninaApiError('--json cannot be combined with --credential or --trust-anchor');
      }
      const initialized = await client.initialize();
      if (credentialFlag.value) return { mode: 'credential', value: initialized.credential };
      if (trustFlag.value) return { mode: 'trust', value: initialized.trustAnchor };
      return { mode: 'initialize', value: initialized };
    }
    case 'access':
      if (parsed.args.length !== 0) throw new AntoninaApiError('access takes no arguments');
      return { mode: 'access', value: await client.verifyCredential() };
    case 'credential': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'show') {
        if (args.length !== 0) throw new AntoninaApiError('credential show takes no arguments');
        const credential = client.getCredential();
        if (credential === null) throw new AntoninaApiError('Antonina board credential is not configured');
        return { mode: 'credential', value: credential };
      }
      if (subcommand === 'verify') {
        if (args.length !== 0) throw new AntoninaApiError('credential verify takes no arguments');
        return { mode: 'access', value: await client.verifyCredential() };
      }
      throw new AntoninaApiError('credential requires show or verify');
    }
    case 'queue': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'list') {
        const pageOption = option(args, '--page');
        if (pageOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for queue list');
        return {
          mode: 'queue',
          value: pageSlice(await client.getQueue(), pageNumber(pageOption.value)),
        };
      }
      if (subcommand === 'reorder') {
        if (args.length === 0) throw new AntoninaApiError('queue reorder requires issue numbers');
        return { mode: 'queue', value: await client.reorderQueue(args.map((arg) => parsePositiveInteger(arg, 'ISSUE'))) };
      }
      throw new AntoninaApiError('queue requires list or reorder');
    }
    case 'feed': {
      const limitOption = option(parsed.args, '--limit');
      const pageOption = option(limitOption.rest, '--page');
      if (pageOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for feed');
      const limit = limitOption.value === undefined
        ? DEFAULT_FEED_LIMIT
        : parsePositiveInteger(limitOption.value, '--limit');
      return {
        mode: 'feed',
        value: await readNumberedFeedPage(client, pageNumber(pageOption.value), limit),
      };
    }
    case 'list': {
      const stateOption = option(parsed.args, '--state');
      const pageOption = option(stateOption.rest, '--page');
      if (pageOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for list');
      const state = stateOption.value ?? 'all';
      if (!['open', 'closed', 'all'].includes(state)) {
        throw new AntoninaApiError('--state must be open, closed, or all');
      }
      const summaries = await client.listIssueSummaries(state === 'all' ? undefined : state as IssueState);
      const ordered = state === 'closed' ? summaries : issuePriorityOrder(summaries, await client.getQueue());
      return { mode: 'issues', value: pageSlice(ordered, pageNumber(pageOption.value)) };
    }
    case 'show': {
      const pageOption = option(parsed.args, '--page');
      if (pageOption.rest.length !== 1) throw new AntoninaApiError('show requires NUMBER');
      return {
        mode: 'issue',
        value: await client.getIssuePage(
          parsePositiveInteger(pageOption.rest[0], 'NUMBER'),
          pageNumber(pageOption.value),
        ),
      };
    }
    case 'create': {
      const bodyOption = option(parsed.args, '--body');
      if (bodyOption.rest.length !== 1) throw new AntoninaApiError('create requires TITLE');
      return {
        mode: 'issue',
        value: await client.createIssue(requireArg(bodyOption.rest[0], 'TITLE'), bodyOption.value ?? ''),
      };
    }
    case 'edit': {
      const bodyOption = option(parsed.args, '--body');
      if (bodyOption.value === undefined || bodyOption.rest.length !== 1) {
        throw new AntoninaApiError('edit requires NUMBER --body BODY');
      }
      return {
        mode: 'issue',
        value: await client.editIssueBody(parsePositiveInteger(bodyOption.rest[0], 'NUMBER'), bodyOption.value),
      };
    }
    case 'comment': {
      const authorOption = option(parsed.args, '--author');
      if (authorOption.rest.length !== 2) throw new AntoninaApiError('comment requires NUMBER BODY');
      const author = authorOption.value ?? context.env[BOARD_AUTHOR_ENV];
      if (!author) throw new AntoninaApiError('Message author is required; use --author or ' + BOARD_AUTHOR_ENV);
      return {
        mode: 'issue',
        value: await client.comment(
          parsePositiveInteger(authorOption.rest[0], 'NUMBER'),
          author,
          requireArg(authorOption.rest[1], 'BODY'),
        ),
      };
    }
    case 'review': {
      const verdictOption = option(parsed.args, '--verdict');
      const commitOption = option(verdictOption.rest, '--commit');
      const reviewerOption = option(commitOption.rest, '--reviewer');
      const rationaleOption = option(reviewerOption.rest, '--rationale');
      if (rationaleOption.rest.length !== 1 || rationaleOption.value === undefined) {
        throw new AntoninaApiError('review requires NUMBER --verdict VERDICT --rationale TEXT [--commit SHA] [--reviewer NAME]');
      }
      const verdict = verdictOption.value;
      if (verdict === undefined) throw new AntoninaApiError('review requires --verdict request-changes or approve');
      const reviewer = reviewerOption.value ?? context.env[BOARD_AUTHOR_ENV];
      if (!reviewer) throw new AntoninaApiError('Review reviewer is required; use --reviewer or ' + BOARD_AUTHOR_ENV);
      const number = parsePositiveInteger(rationaleOption.rest[0], 'NUMBER');
      return {
        mode: 'review',
        number,
        value: await client.recordReview({
          number,
          commit: commitOption.value ?? '',
          verdict: parseReviewVerdict(verdict),
          reviewer,
          rationale: rationaleOption.value,
        }),
      };
    }
    case 'close':
    case 'reopen': {
      if (parsed.args.length !== 1) throw new AntoninaApiError(parsed.command + ' requires NUMBER');
      const number = parsePositiveInteger(parsed.args[0], 'NUMBER');
      return {
        mode: 'issue',
        value: parsed.command === 'close' ? await client.close(number) : await client.reopen(number),
      };
    }
    case 'delete': {
      if (parsed.args.length !== 1) throw new AntoninaApiError('delete requires NUMBER');
      await client.deleteIssue(parsePositiveInteger(parsed.args[0], 'NUMBER'));
      return { mode: 'deleted-issue', value: null };
    }
    case 'delete-board':
      if (parsed.args.length !== 0) throw new AntoninaApiError('delete-board takes no arguments');
      await client.deleteBoard();
      return { mode: 'deleted-board', value: null };
    case 'resource': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'list') {
        const hostOption = option(args, '--host');
        const issueOption = option(hostOption.rest, '--issue');
        const pageOption = option(issueOption.rest, '--page');
        if (pageOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for resource list');
        const issueNumber = issueOption.value === undefined
          ? undefined
          : parsePositiveInteger(issueOption.value, '--issue');
        return {
          mode: 'resources',
          // NOT a bounded read, and deliberately still not one. `--page` bounds
          // what is PRINTED, never what is FETCHED: `listResources` is
          // `resourceViews(await this.loadBoard())` in `packages/core/src/api.ts`,
          // and per `docs/intent-records/board.md` the resource catalog is one
          // materialized object (unlike issue summaries, which ARE paged in
          // storage), so the whole collection crosses the wire before `pageSlice`
          // takes one 50-row window of it. A true bounded read means sharding the
          // catalog into resource pages — a storage-format and migration change,
          // not a CLI or UI one, and out of scope here. The web Resources tab
          // states the same limit rather than implying the UI alone fixes
          // scaling; see the note above `RESOURCE_PAGE_SIZE` in
          // `web/src/ui-state.ts`.
          value: pageSlice(await client.listResources(hostOption.value, issueNumber), pageNumber(pageOption.value)),
        };
      }
      if (subcommand === 'add' || subcommand === 'remove') {
        if (args.length !== 3) {
          throw new AntoninaApiError('resource ' + subcommand + ' requires ISSUE HOST PATH');
        }
        const issueNumber = parsePositiveInteger(args[0], 'ISSUE');
        const host = requireArg(args[1], 'HOST');
        const path = requireArg(args[2], 'PATH');
        return subcommand === 'add'
          ? { mode: 'resource-added', value: await client.addResourceDependency(host, path, issueNumber) }
          : { mode: 'resource-removed', value: await client.removeResourceDependency(host, path, issueNumber) };
      }
      throw new AntoninaApiError('resource requires list, add, or remove');
    }
    case 'import': {
      const confirmFlag = flag(parsed.args, '--confirm');
      if (confirmFlag.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for import');
      // The format cutover. The default run is a plan: it reads the pre-cutover
      // store, rebuilds the board, verifies the two are semantically identical,
      // and reports -- writing nothing and publishing nothing. Only --confirm
      // replaces the pointer, which is the one step that changes what any client
      // will read.
      //
      // It is an operator action by design, like collect delete. Nothing in the
      // runtime reads the pre-cutover store, so an agent cannot stumble into
      // half of it, and a scheduled run without the flag gets a report.
      return {
        mode: 'import',
        value: await client.importBoard({ confirm: confirmFlag.value }),
      };
    }
    case 'collect': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'list') {
        const hostOption = option(args, '--host');
        const pageOption = option(hostOption.rest, '--page');
        if (pageOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for collect list');
        const entries = (await collectList(client, requireArg(hostOption.value, 'collect list --host'))).value;
        return { mode: 'collect-list', value: pageSlice(entries, pageNumber(pageOption.value)) };
      }
      if (subcommand === 'delete') {
        const hostOption = option(args, '--host');
        const pathOption = option(hostOption.rest, '--path');
        const confirmFlag = flag(pathOption.rest, '--confirm');
        if (confirmFlag.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for collect delete');
        const collected = await collectDelete(client, {
          host: requireArg(hostOption.value, 'collect delete --host'),
          path: requireArg(pathOption.value, 'collect delete --path'),
          confirm: confirmFlag.value,
          env: context.env,
        });
        return { mode: collected.mode, value: collected.value };
      }
      throw new AntoninaApiError('collect requires list or delete');
    }
    default:
      throw new AntoninaApiError('unsupported antonina board command: ' + parsed.command);
  }
}

function humanIssue(issue: BoardIssue): string {
  const lines = ['#' + issue.number + ' [' + issue.state + '] ' + issue.title, 'Description:', issue.body];
  // The recorded verdict is printed next to the issue rather than only in the
  // thread, because it is the one line that says whether the issue can be closed
  // right now, and `close` refuses while a blocker stands.
  if (issue.review !== undefined) {
    lines.push(
      'Review: ' + issue.review.verdict
        + ' [' + issue.review.reviewer + ' @ ' + issue.review.recordedAt + ']',
      '  about ' + (issue.review.commit === '' ? 'no named commit' : issue.review.commit),
      '  ' + issue.review.rationale,
    );
  }
  const blocker = reviewBlocksCompletion(issue);
  if (blocker !== null) lines.push('Completion blocked:', blocker);
  for (const message of issue.messages) lines.push(message.author + ' @ ' + message.createdAt, message.body);
  return lines.join('\n');
}

const FEED_VERB: { readonly [K in BoardFeedEntry['kind']]: string } = {
  'issue-created': 'created',
  'issue-edited': 'edited',
  'comment-added': 'commented',
  'issue-closed': 'closed',
  'issue-reopened': 'reopened',
  'issue-deleted': 'deleted',
};

const REMOVAL_OUTCOME: { readonly [K in CollectDeleteReport['removal']]: string } = {
  unlinked: 'deleted',
  'unlinked-symlink': 'unlinked symlink',
  absent: 'already absent',
};

function humanFeedEntry(entry: BoardFeedEntry): string {
  const head = entry.at + '  #' + entry.issueNumber + ' [' + entry.state + '] ' + FEED_VERB[entry.kind];
  if (entry.author !== null) {
    return head + ' by ' + entry.author + ': ' + (entry.body ?? '');
  }
  return head + '  ' + entry.title;
}

function humanFeed(page: BoardFeedPage): string[] {
  const lines = page.entries.length === 0
    ? ['The board feed is empty.']
    : page.entries.map(humanFeedEntry);
  // The public CLI pages by explicit page number. Keep the core cursor internal:
  // a human should be told to advance the interface they can actually invoke.
  if (page.nextCursor !== null) lines.push('more: increment --page');
  return lines;
}

function humanLines(result: CommandResult): string[] {
  if (result.mode === 'initialize') {
    const initialized = result.value as BoardInitialization;
    return [
      'Antonina board initialized.',
      'Integrity anchor (public; does not grant board access):',
      serializeBoardTrustAnchor(initialized.trustAnchor),
      'Board credential (secret; grants full access):',
      serializeBoardCredential(initialized.credential),
    ];
  }
  if (result.mode === 'credential') {
    return [serializeBoardCredential(result.value as BoardCredential)];
  }
  if (result.mode === 'trust') {
    return [serializeBoardTrustAnchor(result.value as BoardTrustAnchor)];
  }
  if (result.mode === 'access') {
    const access = result.value as BoardAccessState;
    return [
      'key: ' + (access.keyId ?? 'none'),
      'storage: ' + (access.storageRejected ? 'rejected' : 'not rejected'),
      'edit: ' + (access.canEdit ? 'yes' : 'no'),
      'capabilities: ' + access.capabilities.join(', '),
    ];
  }
  if (result.mode === 'queue') {
    return [(result.value as number[]).map((number) => '#' + number).join(' ')];
  }
  if (result.mode === 'feed') return humanFeed(result.value as BoardFeedPage);
  if (result.mode === 'deleted-issue') return ['Issue deleted.'];
  if (result.mode === 'deleted-board') return ['Board deleted.'];

  if (result.mode === 'resource-added') {
    const resource = result.value as BoardResource;
    return ['Resource added: ' + resource.host + ' ' + resource.path];
  }
  if (result.mode === 'resource-removed') return ['Resource dependency removed.'];

  if (result.mode === 'import') {
    const report = result.value as BoardImportReport;
    const failed = report.checks.filter((check) => !check.equal);
    const lines = [
      `board ${report.boardId}: ${report.state}`,
      `carrying across ${report.issues} issue(s), ${report.comments} comment(s), `
        + `${report.feedEntries} feed entr${report.feedEntries === 1 ? 'y' : 'ies'}, `
        + `queue ${report.queueLength}, ${report.resources} resource(s)`,
    ];
    if (report.cutover) {
      lines.push(
        `imported into ${report.importedRefs} shard object(s) and published at revision `
        + `${report.toRevision}; the board is now served from the new store`,
      );
    } else if (report.state === 'cutover-complete') {
      lines.push(`already cut over; the board holds ${report.importedRefs} shard object(s)`);
    } else {
      lines.push(
        `the rebuilt board would hold ${report.importedRefs} shard object(s); `
        + 'nothing was written and the board was not switched over',
      );
      lines.push('re-run with --confirm to import and cut over');
    }
    if (failed.length > 0) {
      // A failed check is the reason a cutover is refused, so it is reported by
      // name rather than summarised.
      lines.push('VERIFICATION FAILED:');
      for (const check of failed) lines.push(`  ${check.name}: ${check.difference ?? 'differs'}`);
    } else if (report.checks.length > 0) {
      lines.push(`verified equivalent on ${report.checks.length} propert`
        + `${report.checks.length === 1 ? 'y' : 'ies'}`);
    }
    lines.push(
      report.legacyStore.shardObjects === 0
        ? report.legacyStore.note
        : `the pre-cutover store holds at least ${report.legacyStore.shardObjects} object(s) and is `
          + 'left whole and unreachable; ' + report.legacyStore.note.split('; ')[1],
    );
    // The reclaim premise is a dated observation of one deployment, and this is
    // the line that says whether it is still holding. A non-zero count means
    // superseded objects are piling up that Antonina could not delete, which is
    // the condition the bounded-storage fix exists to prevent and the one an
    // operator can act on -- so it is stated as a warning, not folded into a
    // summary the reader has to notice.
    if (report.state === 'cutover-complete') {
      const leaked = report.storage.unreclaimableShards;
      lines.push(
        leaked === 0
          ? `reclamation is keeping up; ${report.storage.note}`
          : `WARNING: ${leaked} superseded shard object(s) could not be deleted `
            + `(at least; the count lags the newest sweep by one commit) -- `
            + report.storage.note,
      );
    } else {
      lines.push(report.storage.note);
    }
    return lines;
  }

  if (result.mode === 'collect-list') {
    const entries = result.value as CollectListEntry[];
    if (entries.length === 0) return ['No path on this host is collectible.'];
    return entries.map((entry) => {
      const dependents = entry.closedDependents.length === 0
        ? ''
        : '; closed dependents ' + entry.closedDependents.map((number) => '#' + number).join(', ');
      return 'collectible ' + entry.path + ' on ' + entry.host
        + '; board ' + entry.boardId + ' rev ' + entry.revision + dependents;
    });
  }

  if (result.mode === 'collect-pending') {
    // The pending value is the *base* report and has no `removal`: nothing has been
    // removed, so there is no removal to report. The line therefore states the two
    // shapes the confirmed run could take rather than asserting one of them.
    const report = result.value as CollectDeleteReportBase;
    // Exactly one revision is named, and it is the one the re-check verified.
    return [
      `would delete ${report.path} on ${report.host} (a symlink would be unlinked as a link, `
        + `anything else removed recursively); board ${report.boardId} `
        + `${renderRevision(report.recheckHead)}; re-run with --confirm`,
    ];
  }
  if (result.mode === 'collect-deleted') {
    const report = result.value as CollectDeleteReport;
    // A mapping over the removal union rather than a chain of comparisons, so a
    // fourth removal result is a type error here instead of silently rendering as
    // the last case: the report must name what actually happened, never a default.
    return [
      `${REMOVAL_OUTCOME[report.removal]} ${report.path} on ${report.host}; `
        + `board ${report.boardId} ${renderRevision(report.recheckHead)}`,
    ];
  }

  if (result.mode === 'review') {
    const review = result.value as BoardReview;
    return [
      'Review #' + result.number + ' ' + review.verdict + ' by ' + review.reviewer
        + ' about ' + (review.commit === '' ? 'no named commit' : review.commit),
      '  ' + review.rationale,
    ];
  }

  const value = result.value;
  if (!Array.isArray(value)) return [humanIssue(value as BoardIssue)];
  return value.map((item) => {
    if (typeof item === 'number') return '#' + item;
    if ('protected' in item) {
      const view = item as ResourceView;
      const states = view.issues.map((entry) => '#' + entry.number + ' [' + entry.state + ']').join(', ');
      return view.host + ' ' + view.path + ' ' + states + ' ' + (view.protected ? 'protected' : 'collectible');
    }
    if ('host' in item) {
      const resource = item as BoardResource;
      return resource.host + ' ' + resource.path + ' -> ' + resource.issueNumbers.map((number) => '#' + number).join(', ');
    }
    const issue = item as BoardIssue;
    return '#' + issue.number + ' [' + issue.state + '] ' + issue.title;
  });
}

export async function runBoardCommand(argv: string[], context: BoardCommandContext): Promise<number> {
  try {
    const parsed = parseCommand(argv);
    const client = context.createClient?.() ?? defaultClient(context);
    const result = await execute(parsed, client, context);
    if (parsed.json) {
      // A JSON reader that asked for telemetry must receive it. Leaving the
      // hosts out would make `--telemetry` look honoured in the human form and
      // silently ignored here, which is the one answer a scheduler cannot check.
      context.io.stdout(canonicalJson(result.value as unknown as CanonicalValue));
      return 0;
    }
    for (const line of humanLines(result)) context.io.stdout(line);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const advice = boardStateAdvice(error);
    context.io.stderr('antonina board: ' + message + (advice === null ? '' : '; ' + advice));
    return 1;
  }
}
