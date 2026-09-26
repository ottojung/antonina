import { AntoninaApiError, BoardApi, DEFAULT_BOARD_BASE_URL } from '../../core/src/api.js';
import type { BoardIssue, BoardResource, IssueState, ResourceView } from '../../core/src/model.js';

export const BOARD_BASE_URL_ENV = 'ANTONINA_BOARD_URL';
export const BOARD_CAPABILITY_ENV = 'ANTONINA_BOARD_CAPABILITY';
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

type CommandResult = BoardIssue | BoardIssue[] | BoardResource | BoardResource[] | ResourceView[];

interface ParsedCommand {
  json: boolean;
  command: string;
  args: string[];
}

function requireArg(raw: string | undefined, name: string): string {
  if (raw === undefined) throw new AntoninaApiError(`${name} is required`);
  return raw;
}

function parsePositiveInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw new AntoninaApiError(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new AntoninaApiError(`${name} must be a positive integer`);
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
  if (value === undefined || value.startsWith('--')) throw new AntoninaApiError(`${name} requires a value`);
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function stableJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]));
    }
    return entry;
  };
  return JSON.stringify(canonical(value));
}

function humanIssue(issue: BoardIssue): string {
  const lines = [`#${issue.number} [${issue.state}] ${issue.title}`, 'Description:', issue.body];
  for (const message of issue.messages) lines.push(`${message.author} @ ${message.createdAt}`, message.body);
  return lines.join('\n');
}

function humanList(result: CommandResult): string[] {
  if (!Array.isArray(result)) return [humanIssue(result as BoardIssue)];
  return result.map((item) => {
    if ('protected' in item) {
      const view = item as ResourceView;
      const states = view.issues.map((entry) => `#${entry.number} [${entry.state}]`).join(', ');
      return `${view.host} ${view.path} ${states} ${view.protected ? 'protected' : 'collectible'}`;
    }
    if ('host' in item) {
      const resource = item as BoardResource;
      return `${resource.host} ${resource.path} -> ${resource.issueNumbers.map((number) => `#${number}`).join(', ')}`;
    }
    const issue = item as BoardIssue;
    return `#${issue.number} [${issue.state}] ${issue.title}`;
  });
}

function defaultClient(env: Record<string, string | undefined>): BoardApi {
  const capability = env[BOARD_CAPABILITY_ENV];
  return new BoardApi({
    baseUrl: env[BOARD_BASE_URL_ENV] ?? DEFAULT_BOARD_BASE_URL,
    ...(capability === undefined ? {} : { capability }),
  });
}

async function execute(parsed: ParsedCommand, client: BoardApi, env: Record<string, string | undefined>): Promise<CommandResult> {
  switch (parsed.command) {
    case 'list': {
      const stateOption = option(parsed.args, '--state');
      if (stateOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for list');
      const state = stateOption.value ?? 'all';
      if (!['open', 'closed', 'all'].includes(state)) throw new AntoninaApiError('--state must be open, closed, or all');
      return client.listIssues(state === 'all' ? undefined : state as IssueState);
    }
    case 'show':
      if (parsed.args.length !== 1) throw new AntoninaApiError('show requires NUMBER');
      return client.getIssue(parsePositiveInteger(parsed.args[0], 'NUMBER'));
    case 'create': {
      const bodyOption = option(parsed.args, '--body');
      if (bodyOption.rest.length !== 1) throw new AntoninaApiError('create requires TITLE');
      return client.createIssue(requireArg(bodyOption.rest[0], 'TITLE'), bodyOption.value ?? '');
    }
    case 'edit': {
      const bodyOption = option(parsed.args, '--body');
      if (bodyOption.value === undefined || bodyOption.rest.length !== 1) throw new AntoninaApiError('edit requires NUMBER --body BODY');
      return client.editIssueBody(parsePositiveInteger(bodyOption.rest[0], 'NUMBER'), bodyOption.value);
    }
    case 'comment': {
      const authorOption = option(parsed.args, '--author');
      if (authorOption.rest.length !== 2) throw new AntoninaApiError('comment requires NUMBER BODY');
      const author = authorOption.value ?? env[BOARD_AUTHOR_ENV];
      if (!author) throw new AntoninaApiError(`Message author is required; use --author or ${BOARD_AUTHOR_ENV}`);
      return client.comment(parsePositiveInteger(authorOption.rest[0], 'NUMBER'), author, requireArg(authorOption.rest[1], 'BODY'));
    }
    case 'close':
    case 'reopen': {
      if (parsed.args.length !== 1) throw new AntoninaApiError(`${parsed.command} requires NUMBER`);
      const number = parsePositiveInteger(parsed.args[0], 'NUMBER');
      return parsed.command === 'close' ? client.close(number) : client.reopen(number);
    }
    case 'resource': {
      const [subcommand, ...args] = parsed.args;
      if (subcommand === 'list') {
        const hostOption = option(args, '--host');
        const issueOption = option(hostOption.rest, '--issue');
        if (issueOption.rest.length !== 0) throw new AntoninaApiError('unexpected arguments for resource list');
        const issueNumber = issueOption.value === undefined ? undefined : parsePositiveInteger(issueOption.value, '--issue');
        return client.listResources(hostOption.value, issueNumber);
      }
      if (subcommand === 'add' || subcommand === 'remove') {
        if (args.length !== 3) throw new AntoninaApiError(`resource ${subcommand} requires ISSUE HOST PATH`);
        const issueNumber = parsePositiveInteger(args[0], 'ISSUE');
        const host = requireArg(args[1], 'HOST');
        const path = requireArg(args[2], 'PATH');
        if (subcommand === 'add') return client.addResourceDependency(host, path, issueNumber);
        return client.removeResourceDependency(host, path, issueNumber);
      }
      throw new AntoninaApiError('resource requires list, add, or remove');
    }
    default:
      throw new AntoninaApiError(`unsupported antonina board command: ${parsed.command}`);
  }
}

export async function runBoardCommand(argv: string[], context: BoardCommandContext): Promise<number> {
  try {
    const parsed = parseCommand(argv);
    const client = context.createClient?.() ?? defaultClient(context.env);
    const result = await execute(parsed, client, context.env);
    if (parsed.json) {
      context.io.stdout(stableJson(result));
      return 0;
    }

    if (parsed.command === 'resource') {
      const subcommand = parsed.args[0];
      if (subcommand === 'add') {
        const resource = result as BoardResource;
        context.io.stdout(`Resource added: ${resource.host} ${resource.path} -> #${parsed.args[1]}`);
        return 0;
      }
      if (subcommand === 'remove') {
        context.io.stdout(`Resource dependency removed: ${parsed.args[2]} ${parsed.args[3]} <- #${parsed.args[1]}`);
        return 0;
      }
    }

    for (const line of humanList(result)) context.io.stdout(line);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.io.stderr(`antonina board: ${message}`);
    return 1;
  }
}
