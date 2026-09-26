import {
  AntoninaApiError,
  BoardApi,
  BoardMissingError,
  BoardTrustRequiredError,
  DEFAULT_BOARD_BASE_URL,
  type BoardAccessState,
  type BoardInitialization,
} from '../../core/src/api.js';
import {
  parseBoardCredential,
  parseBoardTrustAnchor,
  serializeBoardCredential,
  serializeBoardTrustAnchor,
  type BoardCredential,
} from '../../core/src/credential.js';
import { canonicalJson, type CanonicalValue } from '../../core/src/canonical.js';
import type { BoardIssue, BoardResource, IssueState, ResourceView } from '../../core/src/model.js';
import {
  parseBoardCapability,
  type BoardCapability,
  type VerifiedAuthority,
} from '../../core/src/operations.js';

export const BOARD_BASE_URL_ENV = 'ANTONINA_BOARD_URL';
export const BOARD_CREDENTIAL_ENV = 'ANTONINA_BOARD_CREDENTIAL';
export const BOARD_TRUST_ENV = 'ANTONINA_BOARD_TRUST';
export const BOARD_HEAD_ENV = 'ANTONINA_BOARD_HEAD';
export const BOARD_AUTHOR_ENV = 'ANTONINA_BOARD_AUTHOR';

export interface BoardCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface BoardCommandContext {
  env: Record<string, string | undefined>;
  io: BoardCommandIo;
  createClient?: () => BoardApi;
}

type CommandValue =
  | BoardIssue
  | BoardIssue[]
  | BoardResource
  | BoardResource[]
  | ResourceView[]
  | BoardInitialization
  | BoardCredential
  | BoardAccessState
  | VerifiedAuthority[]
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

function parseJsonEnv(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AntoninaApiError(name + ' must contain valid JSON', { cause: error });
  }
}

function defaultClient(env: Record<string, string | undefined>): BoardApi {
  const rawCredential = env[BOARD_CREDENTIAL_ENV];
  const rawTrust = env[BOARD_TRUST_ENV];
  const credential = rawCredential === undefined
    ? null
    : parseBoardCredential(parseJsonEnv(rawCredential, BOARD_CREDENTIAL_ENV));
  const trustAnchor = rawTrust === undefined
    ? null
    : parseBoardTrustAnchor(parseJsonEnv(rawTrust, BOARD_TRUST_ENV));
  const rememberedHead = env[BOARD_HEAD_ENV] ?? null;
  return new BoardApi({
    baseUrl: env[BOARD_BASE_URL_ENV] ?? DEFAULT_BOARD_BASE_URL,
    credential,
    trustAnchor,
    rememberedHead,
  });
}

function parseCapabilities(args: string[]): BoardCapability[] {
  if (args.length === 0) throw new AntoninaApiError('credential delegate requires at least one capability');
  return args.map(parseBoardCapability);
}

/**
 * The CLI's advice for the three board states the shared API reports, so an
 * operator is never told to configure a trust anchor for a board that does not
 * exist, or left guessing what to do about one it cannot verify.
 */
function boardStateAdvice(error: unknown): string | null {
  if (error instanceof BoardMissingError) return 'run: antonina board initialize to create it';
  if (error instanceof BoardTrustRequiredError) return 'set ' + BOARD_TRUST_ENV + ' to the board trust anchor to read it';
  return null;
}

async function execute(
  parsed: ParsedCommand,
  client: BoardApi,
  env: Record<string, string | undefined>,
): Promise<CommandResult> {
  switch (parsed.command) {
    case 'initialize':
      if (parsed.args.length !== 0) throw new AntoninaApiError('initialize takes no arguments');
      return { mode: 'initialize', value: await client.initialize() };
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
      if (subcommand === 'trust') {
        if (args.length !== 0) throw new AntoninaApiError('credential trust takes no arguments');
        const trust = client.getTrustAnchor();
        if (trust === null) throw new AntoninaApiError('Antonina board trust anchor is not configured');
        return { mode: 'trust', value: trust as unknown as CommandValue };
      }
      if (subcommand === 'verify') {
        if (args.length !== 0) throw new AntoninaApiError('credential verify takes no arguments');
        return { mode: 'access', value: await client.verifyCredential() };
      }
      if (subcommand === 'delegate') {
        return { mode: 'credential', value: await client.delegateCredential(parseCapabilities(args)) };
      }
      if (subcommand === 'revoke') {
        if (args.length !== 1) throw new AntoninaApiError('credential revoke requires KEY_ID');
        return { mode: 'authorities', value: await client.revokeCredential(requireArg(args[0], 'KEY_ID')) };
      }
      throw new AntoninaApiError('credential requires show, trust, verify, delegate, or revoke');
    }
    case 'authority': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand !== 'list' || args.length !== 0) throw new AntoninaApiError('authority requires list');
      return { mode: 'authorities', value: await client.listAuthorities() };
    }
    case 'queue': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'list') {
        if (args.length !== 0) throw new AntoninaApiError('queue list takes no arguments');
        return { mode: 'queue', value: await client.getQueue() };
      }
      if (subcommand === 'reorder') {
        if (args.length === 0) throw new AntoninaApiError('queue reorder requires issue numbers');
        return { mode: 'queue', value: await client.reorderQueue(args.map((arg) => parsePositiveInteger(arg, 'ISSUE'))) };
      }
      throw new AntoninaApiError('queue requires list or reorder');
    }
    case 'list': {
      const stateOption = option(parsed.args, '--state');
      if (stateOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for list');
      const state = stateOption.value ?? 'all';
      if (!['open', 'closed', 'all'].includes(state)) {
        throw new AntoninaApiError('--state must be open, closed, or all');
      }
      return {
        mode: 'issues',
        value: await client.listIssues(state === 'all' ? undefined : state as IssueState),
      };
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
      const author = authorOption.value ?? env[BOARD_AUTHOR_ENV];
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
        if (issueOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for resource list');
        const issueNumber = issueOption.value === undefined
          ? undefined
          : parsePositiveInteger(issueOption.value, '--issue');
        return { mode: 'resources', value: await client.listResources(hostOption.value, issueNumber) };
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
    default:
      throw new AntoninaApiError('unsupported antonina board command: ' + parsed.command);
  }
}

function humanIssue(issue: BoardIssue): string {
  const lines = ['#' + issue.number + ' [' + issue.state + '] ' + issue.title, 'Description:', issue.body];
  for (const message of issue.messages) lines.push(message.author + ' @ ' + message.createdAt, message.body);
  return lines.join('\n');
}

function humanLines(result: CommandResult, parsed: ParsedCommand): string[] {
  if (result.mode === 'initialize') {
    const initialized = result.value as BoardInitialization;
    return [
      'Antonina signed board initialized.',
      'Trust anchor (public):',
      serializeBoardTrustAnchor(initialized.trustAnchor),
      'Root credential (secret; store securely):',
      serializeBoardCredential(initialized.credential),
    ];
  }
  if (result.mode === 'credential') {
    return [serializeBoardCredential(result.value as BoardCredential)];
  }
  if (result.mode === 'trust') {
    return [serializeBoardTrustAnchor(result.value as never)];
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
  if (result.mode === 'authorities') {
    return (result.value as VerifiedAuthority[]).map((authority) =>
      authority.keyId
      + ' parent=' + (authority.parentKeyId ?? '-')
      + ' ' + (authority.revoked ? 'revoked' : 'active')
      + ' [' + authority.capabilities.join(', ') + ']'
    );
  }
  if (result.mode === 'queue') {
    return [(result.value as number[]).map((number) => '#' + number).join(' ')];
  }
  if (result.mode === 'deleted-issue') return ['Issue deleted.'];
  if (result.mode === 'deleted-board') return ['Board deleted.'];

  if (result.mode === 'resource-added') {
    const resource = result.value as BoardResource;
    return ['Resource added: ' + resource.host + ' ' + resource.path];
  }
  if (result.mode === 'resource-removed') return ['Resource dependency removed.'];

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
    const client = context.createClient?.() ?? defaultClient(context.env);
    const result = await execute(parsed, client, context.env);
    if (parsed.json) {
      context.io.stdout(canonicalJson(result.value as unknown as CanonicalValue));
      return 0;
    }
    for (const line of humanLines(result, parsed)) context.io.stdout(line);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const advice = boardStateAdvice(error);
    context.io.stderr('antonina board: ' + message + (advice === null ? '' : '; ' + advice));
    return 1;
  }
}
