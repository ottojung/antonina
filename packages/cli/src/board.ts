import {
  AntoninaApiError,
  BoardApi,
  BoardDeletedError,
  BoardMissingError,
  BoardStorageRejectedError,
  BoardTrustRequiredError,
  DEFAULT_BOARD_BASE_URL,
  TargetSelectionError,
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
  type BoardFeedRequest,
} from '../../core/src/feed.js';
import {
  defaultExecutionTargetAccessMethod,
  defaultExecutionTargetPersistence,
  executionTargetAccess,
  parseExecutionTargetAccessMethod,
  parseExecutionTargetBackend,
  parseExecutionTargetCapability,
  parseExecutionTargetGarbageCollection,
  parseExecutionTargetKind,
  parseExecutionTargetPersistence,
  parseExecutionTargetStatus,
  type BoardDispatch,
  type BoardExecutionTarget,
  type BoardIssue,
  type BoardResource,
  type ExecutionTargetAccessMethod,
  type ExecutionTargetBackend,
  type ExecutionTargetKind,
  type ExecutionTargetPersistence,
  type ExecutionTargetStatus,
  type IssueState,
  type ResourceView,
  type TargetRequest,
  type TargetSelection,
  type TargetView,
} from '../../core/src/model.js';
import {
  formatHostBytes,
  hostViewForTarget,
  type DaemonHostReport,
  type DaemonHostView,
  type HostBytesMeasurement,
} from '../../core/src/host-daemon.js';
import { daemonPaths } from '../../host-daemon/src/identity.js';
import { readHostReport } from '../../host-daemon/src/state.js';
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
  | BoardDispatch
  | BoardExecutionTarget
  | ResourceView[]
  | TargetView[]
  | TargetSelection
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
  /**
   * The host-local daemon views a `target list --telemetry` asked for, or
   * `null` when it did not. It rides on the result rather than being a second
   * command so the human and JSON forms of one answer are the same answer.
   */
  hosts?: DaemonHostView[] | null;
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
  return raw === undefined ? 1 : parsePositiveInteger(raw, '--page');
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
 * The routing request a `target` or `dispatch` command carries. The flags are
 * the same in every case so "run it here" and "run it where it fits" are one
 * vocabulary, and none of them names a default host.
 */
function targetRequest(args: string[]): { request: TargetRequest; rest: string[] } {
  const targetOption = option(args, '--target');
  const backendOption = option(targetOption.rest, '--backend');
  const kindOption = option(backendOption.rest, '--kind');
  const capabilityOption = repeatedOption(kindOption.rest, '--capability');
  return {
    request: {
      targetId: targetOption.value ?? null,
      backend: backendOption.value === undefined ? null : parseExecutionTargetBackend(backendOption.value),
      kind: kindOption.value === undefined ? null : parseExecutionTargetKind(kindOption.value),
      capabilities: capabilityOption.values.map(parseExecutionTargetCapability),
    },
    rest: capabilityOption.rest,
  };
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
      const cursorOption = option(limitOption.rest, '--cursor');
      const pageOption = option(cursorOption.rest, '--page');
      if (pageOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for feed');
      if (cursorOption.value !== undefined && pageOption.value !== undefined) {
        throw new AntoninaApiError('--page cannot be combined with --cursor');
      }
      const limit = limitOption.value === undefined
        ? DEFAULT_FEED_LIMIT
        : parsePositiveInteger(limitOption.value, '--limit');
      if (pageOption.value !== undefined) {
        return { mode: 'feed', value: await readNumberedFeedPage(client, pageNumber(pageOption.value), limit) };
      }
      const request: BoardFeedRequest = cursorOption.value === undefined && limitOption.value === undefined
        ? {}
        : { limit, cursor: cursorOption.value ?? null };
      return { mode: 'feed', value: await client.readFeed(request) };
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
    case 'show':
      if (parsed.args.length !== 1) throw new AntoninaApiError('show requires NUMBER');
      return { mode: 'issue', value: await client.getIssue(parsePositiveInteger(parsed.args[0], 'NUMBER')) };
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
    case 'target': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'list') {
        const backendOption = option(args, '--backend');
        const kindOption = option(backendOption.rest, '--kind');
        const pageOption = option(kindOption.rest, '--page');
        const telemetryFlag = flag(pageOption.rest, '--telemetry');
        if (telemetryFlag.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for target list');
        // Both filters are parsed before they are applied, so an unknown value
        // is refused whether or not any target happens to match it.
        const backend = backendOption.value === undefined ? null : parseExecutionTargetBackend(backendOption.value);
        const kind = kindOption.value === undefined ? null : parseExecutionTargetKind(kindOption.value);
        const targets = (await client.listTargets()).filter((target) =>
          (backend === null || target.backend === backend) && (kind === null || target.kind === kind));
        return {
          mode: 'targets',
          value: pageSlice(targets, pageNumber(pageOption.value)),
          hosts: telemetryFlag.value ? await client.daemonHosts(localHostReports(context), { nowMs: Date.now() }) : null,
        };
      }
      if (subcommand === 'show') {
        const telemetryFlag = flag(args, '--telemetry');
        if (telemetryFlag.rest.length !== 1) throw new AntoninaApiError('target show requires ID');
        return {
          mode: 'target',
          value: await client.getTarget(requireArg(telemetryFlag.rest[0], 'ID')),
          hosts: telemetryFlag.value ? await client.daemonHosts(localHostReports(context), { nowMs: Date.now() }) : null,
        };
      }
      if (subcommand === 'add') {
        const backendOption = option(args, '--backend');
        const kindOption = option(backendOption.rest, '--kind');
        const addressOption = option(kindOption.rest, '--address');
        const descriptionOption = option(addressOption.rest, '--description');
        const displayNameOption = option(descriptionOption.rest, '--display-name');
        const accessMethodOption = option(displayNameOption.rest, '--access-method');
        const persistenceOption = option(accessMethodOption.rest, '--persistence');
        const garbageCollectionOption = option(persistenceOption.rest, '--garbage-collection');
        const limitationOption = repeatedOption(garbageCollectionOption.rest, '--limitation');
        const guidanceOption = repeatedOption(limitationOption.rest, '--guidance');
        const capabilityOption = repeatedOption(guidanceOption.rest, '--capability');
        if (capabilityOption.rest.length !== 1) {
          throw new AntoninaApiError('target add requires ID --backend BACKEND --kind KIND');
        }
        const id = requireArg(capabilityOption.rest[0], 'ID');
        const address = addressOption.value ?? null;
        if (address === null && kindOption.value === 'persistent-host') {
          throw new AntoninaApiError('target add --kind persistent-host requires --address lubko://<server>');
        }
        const backend = parseExecutionTargetBackend(requireArg(backendOption.value, 'target add --backend'));
        const kind = parseExecutionTargetKind(requireArg(kindOption.value, 'target add --kind'));
        return {
          mode: 'target',
          value: await client.registerTarget({
            id,
            backend,
            kind,
            capabilities: capabilityOption.values.map(parseExecutionTargetCapability),
            address,
            description: descriptionOption.value ?? '',
            // A flag the caller did not give is not written at all, so the
            // target keeps reading through the same default a target registered
            // before these fields existed reads through. A flag the caller gave
            // is validated against the backend and kind it is registering for,
            // here rather than at the model, so the refusal names the field.
            ...(displayNameOption.value === undefined
              ? {}
              : { displayName: displayNameOption.value }),
            ...(accessMethodOption.value === undefined
              ? {}
              : { accessMethod: checkedAccessMethod(backend, accessMethodOption.value) }),
            ...(persistenceOption.value === undefined
              ? {}
              : { persistence: checkedPersistence(kind, persistenceOption.value) }),
            ...(garbageCollectionOption.value === undefined
              ? {}
              : { garbageCollection: parseExecutionTargetGarbageCollection(garbageCollectionOption.value) }),
            ...(limitationOption.values.length === 0
              ? {}
              : { limitations: limitationOption.values }),
            ...(guidanceOption.values.length === 0 ? {} : { guidance: guidanceOption.values }),
          }),
        };
      }
      if (subcommand === 'set') {
        const statusOption = option(args, '--status');
        const descriptionOption = option(statusOption.rest, '--description');
        const displayNameOption = option(descriptionOption.rest, '--display-name');
        const limitationOption = repeatedOption(displayNameOption.rest, '--limitation');
        const guidanceOption = repeatedOption(limitationOption.rest, '--guidance');
        const capabilityOption = repeatedOption(guidanceOption.rest, '--capability');
        const clearLimitations = flag(capabilityOption.rest, '--clear-limitations');
        const clearGuidance = flag(clearLimitations.rest, '--clear-guidance');
        if (clearGuidance.rest.length !== 1) throw new AntoninaApiError('target set requires ID');
        const id = requireArg(clearGuidance.rest[0], 'ID');
        const existing = await client.getTarget(id);
        const status: ExecutionTargetStatus = statusOption.value === undefined
          ? existing.status
          : parseExecutionTargetStatus(statusOption.value);
        // An absent `--capability` keeps the declared capabilities, so a
        // status change cannot silently strip what a target can do. The
        // descriptive notes behave the same way, and a field the target never
        // had stays absent rather than being written out empty.
        const capabilities = capabilityOption.values.length === 0
          ? existing.capabilities
          : capabilityOption.values.map(parseExecutionTargetCapability);
        // A caveat or a guidance document that has since become wrong is
        // retracted by naming it as a flag rather than as a value, so there is
        // no reserved word that a real note could collide with: an operator who
        // genuinely wants a note that happens to read like a sentinel still
        // gets that note stored, because the sentinel is not a note at all.
        // A flag and a value on the same field is a contradiction rather than
        // an ordering, so it is refused instead of resolved.
        if (clearLimitations.value && limitationOption.values.length > 0) {
          throw new AntoninaApiError('--clear-limitations cannot be combined with --limitation');
        }
        if (clearGuidance.value && guidanceOption.values.length > 0) {
          throw new AntoninaApiError('--clear-guidance cannot be combined with --guidance');
        }
        return {
          mode: 'target',
          value: await client.setTarget(id, {
            status,
            capabilities,
            description: descriptionOption.value ?? existing.description,
            ...(displayNameOption.value !== undefined
              ? { displayName: displayNameOption.value }
              : existing.displayName !== undefined ? { displayName: existing.displayName } : {}),
            ...(limitationOption.values.length > 0
              ? { limitations: limitationOption.values }
              : clearLimitations.value
                ? { limitations: [] }
                : existing.limitations !== undefined ? { limitations: existing.limitations } : {}),
            ...(guidanceOption.values.length > 0
              ? { guidance: guidanceOption.values }
              : clearGuidance.value
                ? { guidance: [] }
                : existing.guidance !== undefined ? { guidance: existing.guidance } : {}),
          }),
        };
      }
      throw new AntoninaApiError('target requires list, show, add, or set');
    }
    case 'dispatch': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'select') {
        const routed = targetRequest(args);
        if (routed.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for dispatch select');
        return { mode: 'selection', value: await client.selectTarget(routed.request) };
      }
      if (subcommand === 'record') {
        const routed = targetRequest(args);
        if (routed.rest.length !== 1) throw new AntoninaApiError('dispatch record requires NUMBER');
        return {
          mode: 'dispatch',
          value: await client.recordDispatch(parsePositiveInteger(routed.rest[0], 'NUMBER'), routed.request),
        };
      }
      throw new AntoninaApiError('dispatch requires select or record');
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
  for (const message of issue.messages) lines.push(message.author + ' @ ' + message.createdAt, message.body);
  return lines.join('\n');
}

/**
 * Every removal result and the words that report it, as a total mapping over
 * `CollectDeleteReport['removal']`. The annotation is the exhaustiveness check:
 * a removal result added to the union without a word here is a type error, so the
 * reporting cannot quietly fall through to a case that did not happen.
 */
const REMOVAL_OUTCOME: { readonly [K in CollectDeleteReport['removal']]: string } = {
  unlinked: 'deleted',
  'unlinked-symlink': 'unlinked symlink',
  absent: 'already absent',
};

function humanTargetRecord(target: BoardExecutionTarget): string[] {
  // Every line here is read off `executionTargetAccess`, so the CLI prints the
  // same access method, persistence, garbage collection and guidance a board
  // view prints. A field the record leaves absent is reported from its default
  // rather than omitted, because "this target says nothing about how it is
  // cleaned up" and "this target is cleaned up by the provider" are different
  // things for an operator and only one of them is true.
  const access = executionTargetAccess(target);
  return [
    target.id + ' [' + target.backend + '/' + target.kind + '] ' + target.status
      + ' [' + target.capabilities.join(', ') + ']'
      + (target.address === null ? ' no-host' : ' ' + target.address),
    '  name ' + access.displayName,
    '  access ' + access.accessMethod,
    '  persistence ' + access.persistence,
    '  cleanup ' + access.garbageCollection,
    '  guidance ' + access.guidance.join(', '),
    ...(target.description === '' ? [] : ['  ' + target.description]),
    ...access.limitations.map((limitation) => '  caveat: ' + limitation),
  ];
}

function humanTarget(target: TargetView): string {
  const lines = humanTargetRecord(target);
  for (const resource of target.resources) {
    lines.push('  resource ' + resource.path + ' -> ' + resource.issueNumbers.map((number) => '#' + number).join(', '));
  }
  if (target.dispatchedIssues.length > 0) {
    lines.push('  dispatched ' + target.dispatchedIssues.map((number) => '#' + number).join(', '));
  }
  return lines.join('\n');
}

/**
 * The access method a flag names, refused here when it contradicts the backend
 * being registered. The model would refuse the same record; refusing at the
 * command line means the operator is told which flag disagrees with which
 * backend before anything is signed.
 */
function checkedAccessMethod(backend: ExecutionTargetBackend, raw: string): ExecutionTargetAccessMethod {
  const method = parseExecutionTargetAccessMethod(raw);
  const expected = defaultExecutionTargetAccessMethod(backend);
  if (method !== expected) {
    throw new AntoninaApiError(`the ${backend} backend is reached by ${expected}, not ${method}`);
  }
  return method;
}

/** The persistence a flag names, refused when it contradicts the kind being registered. */
function checkedPersistence(kind: ExecutionTargetKind, raw: string): ExecutionTargetPersistence {
  const persistence = parseExecutionTargetPersistence(raw);
  const expected = defaultExecutionTargetPersistence(kind);
  if (persistence !== expected) {
    throw new AntoninaApiError(`a target of kind ${kind} has ${expected} persistence, not ${persistence}`);
  }
  return persistence;
}

/**
 * The host-local daemon report, read at most once per command.
 *
 * Telemetry is opt-in because it is a filesystem read of state the operator's
 * own machine owns, and because a report is evidence about a host rather than a
 * board fact. A host that has never published one contributes nothing here, and
 * `humanHostTelemetry` turns that absence into a stated `unknown` rather than
 * into silence.
 *
 * The paths come from the command context, never from `process.env`, exactly as
 * `antonina daemon` resolves them. A `--telemetry` read that fell through to the
 * ambient environment would let a test — or any caller with an injected `env` —
 * read the operator's own state tree, which is not a thing a board command may
 * do behind the caller's back.
 */
function localHostReports(context: BoardCommandContext): DaemonHostReport[] {
  const report = readHostReport({
    paths: daemonPaths({
      env: context.env,
      ...(context.home === undefined ? {} : { home: context.home }),
    }),
  });
  return report === null ? [] : [report];
}

/** One byte measurement as an operator reads it, keeping the reason it is absent. */
function humanBytes(measurement: HostBytesMeasurement): string {
  return measurement.ok
    ? formatHostBytes(measurement.bytes) + ' (' + measurement.bytes + ' bytes)'
    : 'unknown (' + measurement.reason + (measurement.detail === '' ? '' : ': ' + measurement.detail) + ')';
}

/**
 * The live capacity of a persistent host, exactly as far as the last report
 * supports it.
 *
 * Every absent measurement keeps its own reason, and the liveness line is
 * printed even when there is no telemetry at all: a host that is offline, a
 * host that reports no telemetry, and a host with no free memory are three
 * different facts and none of them is silence.
 */
function humanHostTelemetry(host: DaemonHostView | undefined): string[] {
  if (host === undefined) {
    return ['  telemetry unknown (no host-local daemon report was readable on this machine)'];
  }
  const lines = [
    '  host ' + host.hostId + ' ' + host.liveness.status
      + (host.liveness.ageMs === null ? ' (never reported)' : ' (last report ' + host.liveness.ageMs + 'ms ago)')
      + (host.health === null ? '' : ', daemon ' + host.health),
  ];
  if (host.telemetry === null) {
    lines.push('  capacity unknown (the report carried no telemetry)');
    return lines;
  }
  const telemetry = host.telemetry;
  lines.push('  memory ' + humanBytes(telemetry.memory.available) + ' free of ' + humanBytes(telemetry.memory.total));
  for (const filesystem of telemetry.filesystems) {
    lines.push('  filesystem ' + filesystem.path + ' ' + humanBytes(filesystem.available)
      + ' free of ' + humanBytes(filesystem.total));
  }
  lines.push('  cpu '
    + (telemetry.cpu.logicalCores === null ? 'unknown (cores not reported)' : telemetry.cpu.logicalCores + ' logical cores')
    + (telemetry.cpu.model === null ? '' : ', ' + telemetry.cpu.model)
    + (telemetry.cpu.loadAverage === null ? ', load unknown (not reported)' : ', load ' + telemetry.cpu.loadAverage.join(' ')));
  lines.push('  quota not applicable (a host is not a metered external execution service)');
  if (telemetry.problems.length > 0) lines.push('  report problems: ' + telemetry.problems.join(', '));
  return lines;
}

/** Telemetry for a target that is not a persistent host, stated rather than measured. */
function nonHostTelemetry(target: BoardExecutionTarget): string[] {
  if (target.kind === 'ephemeral-environment') {
    return [
      '  capacity not applicable (an ephemeral environment has no host RAM, disk or CPU of its own to report)',
      '  quota unknown (Antonina holds no provider account quota; read it from the provider)',
    ];
  }
  return ['  capacity unknown (no host-local daemon report was readable on this machine)'];
}

/**
 * One target as one block. The lines are joined into a single string rather
 * than emitted separately so a target stays one unit of output the way the feed
 * keeps one entry to one line: a caller reading the catalog can address a target
 * without counting the lines beneath it.
 */
function humanTargetBlock(target: TargetView, hosts: readonly DaemonHostView[] | null): string {
  const lines = humanTarget(target).split('\n');
  if (hosts === null) return lines.join('\n');
  if (target.kind !== 'persistent-host') return [...lines, ...nonHostTelemetry(target)].join('\n');
  return [...lines, ...humanHostTelemetry(hostViewForTarget(target, hosts))].join('\n');
}

/** The catalog as a list, each target carrying its live state only when asked for. */
function humanTargetList(targets: readonly TargetView[], hosts: readonly DaemonHostView[] | null): string[] {
  if (targets.length === 0) return ['No execution targets are registered.'];
  return targets.map((target) => humanTargetBlock(target, hosts));
}

/**
 * The selection as a caller reads it: which target, which rule chose it, and
 * every candidate that was considered and why it was or was not eligible.
 */
function humanSelection(selection: TargetSelection): string[] {
  const lines = [
    (selection.target === null ? 'no target selected: ' : 'selected ' + selection.target.id + ': ')
      + selection.rationale,
  ];
  for (const entry of selection.considered) {
    lines.push(
      '  ' + entry.targetId + ' [' + entry.backend + '/' + entry.kind + '] ' + entry.status
        + (entry.eligible
          ? ' eligible; undeclared ' + entry.surplus.join(', ')
          : ' refused: ' + entry.unmet.join(', ')),
    );
  }
  return lines;
}

/**
 * How each feed entry kind reads on one line. A mapping over the whole
 * vocabulary rather than a chain of comparisons, so a kind added to the feed is
 * a type error here instead of silently rendering as the last case.
 */
const FEED_VERB: { readonly [K in BoardFeedEntry['kind']]: string } = {
  'issue-created': 'created',
  'issue-edited': 'edited',
  'comment-added': 'commented',
  'issue-closed': 'closed',
  'issue-reopened': 'reopened',
  'issue-deleted': 'deleted',
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
  // The continuation token is printed rather than left implicit: a human paging
  // back through the feed needs the same token the JSON form hands a program.
  if (page.nextCursor !== null) lines.push('next: ' + page.nextCursor);
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
        + `queue ${report.queueLength}, ${report.resources} resource(s), `
        + `${report.targets} target(s), ${report.dispatches} dispatch(es)`,
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

  if (result.mode === 'target') {
    // `target show` hands back the record itself, with no resource or dispatch
    // projection beside it, so it is printed from the record and never routed
    // through the catalog listing that needs those.
    const target = result.value as BoardExecutionTarget;
    const lines = humanTargetRecord(target);
    if (result.hosts === undefined || result.hosts === null) return lines;
    return [
      ...lines,
      ...(target.kind === 'persistent-host'
        ? humanHostTelemetry(hostViewForTarget(target, result.hosts))
        : nonHostTelemetry(target)),
    ];
  }
  if (result.mode === 'targets') return humanTargetList(result.value as TargetView[], result.hosts ?? null);
  if (result.mode === 'selection') return humanSelection(result.value as TargetSelection);
  if (result.mode === 'dispatch') {
    const dispatch = result.value as BoardDispatch;
    return ['Dispatched #' + dispatch.issueNumber + ' to ' + dispatch.targetId + '; ' + dispatch.rationale];
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
      const payload = result.hosts === undefined || result.hosts === null
        ? result.value
        : { [result.mode === 'targets' ? 'targets' : 'target']: result.value, hosts: result.hosts };
      context.io.stdout(canonicalJson(payload as unknown as CanonicalValue));
      return 0;
    }
    for (const line of humanLines(result)) context.io.stdout(line);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const advice = boardStateAdvice(error);
    context.io.stderr('antonina board: ' + message + (advice === null ? '' : '; ' + advice));
    // A refused selection names every candidate it considered, so the operator
    // sees which target was rejected and for which requirement rather than only
    // being told that nothing was chosen.
    if (error instanceof TargetSelectionError) {
      for (const line of humanSelection(error.selection).slice(1)) context.io.stderr('antonina board: ' + line);
    }
    return 1;
  }
}
