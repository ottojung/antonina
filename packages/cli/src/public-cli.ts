export class PublicCliUsageError extends Error {}

export type PublicNamespace = 'agent' | 'board' | 'daemon';

export interface PublicRunPlan {
  readonly kind: 'run';
  readonly args: string[];
}

export interface PublicHelpPlan {
  readonly kind: 'help';
  readonly text: string;
}

export type PublicCommandPlan = PublicRunPlan | PublicHelpPlan;

interface ParsedOptions {
  readonly flags: Set<string>;
  readonly values: Map<string, string>;
  readonly repeated: Map<string, string[]>;
}

interface CommandSpec {
  readonly path: readonly string[];
  readonly summary: string;
  readonly flags?: readonly string[];
  readonly values?: readonly string[];
  readonly repeated?: readonly string[];
  readonly required?: readonly string[];
  readonly requireRepeated?: readonly string[];
  readonly normalize: (parsed: ParsedOptions) => string[];
}

const OPTION_HELP: Readonly<Record<string, string>> = {
  '--address': 'Execution-target address.',
  '--author': 'Message author.',
  '--backend': 'Execution backend.',
  '--body': 'Text body.',
  '--capability': 'Capability name; may be repeated.',
  '--clear-guidance': 'Retract the target\'s guidance references.',
  '--clear-limitations': 'Retract the target\'s caveats.',
  '--confirm': 'Confirm the destructive operation.',
  '--credential': 'Print only the initialized credential.',
  '--cursor': 'Paging cursor.',
  '--cwd': 'Working directory the front runs in; declared, never inherited from the invoking shell.',
  '--days': 'Retention age in days.',
  '--description': 'Human-readable description.',
  '--detach': 'Return after starting background work.',
  '--dry-run': 'Report what would change without changing it.',
  '--failed': 'Show failed agents only.',
  '--finished': 'Show terminal agents only.',
  '--follow': 'Follow output until the agent stops.',
  '--force': 'Force the requested operation.',
  '--guidance': 'Repository-relative guidance document path; may be repeated.',
  '--host': 'Host identifier/address.',
  '--id': 'Identifier for the selected command.',
  '--issue': 'Board issue number.',
  '--json': 'Emit JSON.',
  '--killed': 'Show killed agents only.',
  '--kind': 'Execution-target kind.',
  '--limit': 'Maximum number of records.',
  '--limitation': 'Operational caveat; may be repeated.',
  '--lines': 'Number of log lines.',
  '--path': 'Absolute resource path.',
  '--prompt': 'Prompt text.',
  '--running': 'Show running agents only.',
  '--state': 'Issue state filter.',
  '--status': 'Execution-target status.',
  '--steer': 'Preempt current work and steer the agent.',
  '--stopped': 'Show stopped agents only.',
  '--succeeded': 'Show succeeded agents only.',
  '--timeout': 'Timeout in seconds.',
  '--title': 'Title text.',
  '--trust-anchor': 'Print only the initialized trust anchor.',
};

function withJson(spec: Omit<CommandSpec, 'flags'> & { flags?: readonly string[] }): CommandSpec {
  return { ...spec, flags: [...(spec.flags ?? []), '--json'] };
}

function flagArgs(parsed: ParsedOptions, names: readonly string[]): string[] {
  return names.flatMap((name) => parsed.flags.has(name) ? [name] : []);
}

function valueArgs(parsed: ParsedOptions, names: readonly string[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    const value = parsed.values.get(name);
    if (value !== undefined) result.push(name, value);
  }
  return result;
}

function repeatedArgs(parsed: ParsedOptions, name: string): string[] {
  return (parsed.repeated.get(name) ?? []).flatMap((value) => [name, value]);
}

function jsonArg(parsed: ParsedOptions): string[] {
  return parsed.flags.has('--json') ? ['--json'] : [];
}

const BOARD_SPECS: readonly CommandSpec[] = [
  withJson({
    path: ['initialize'],
    summary: 'Initialize the board.',
    flags: ['--credential', '--trust-anchor'],
    normalize: (p) => ['initialize', ...flagArgs(p, ['--credential', '--trust-anchor']), ...jsonArg(p)],
  }),
  withJson({
    path: ['access'],
    summary: 'Show board credential access.',
    normalize: (p) => ['access', ...jsonArg(p)],
  }),
  withJson({
    path: ['credential', 'show'],
    summary: 'Print the configured credential.',
    normalize: (p) => ['credential', 'show', ...jsonArg(p)],
  }),
  withJson({
    path: ['credential', 'verify'],
    summary: 'Verify the configured credential.',
    normalize: (p) => ['credential', 'verify', ...jsonArg(p)],
  }),
  withJson({
    path: ['queue', 'list'],
    summary: 'Print the shared issue queue.',
    normalize: (p) => ['queue', 'list', ...jsonArg(p)],
  }),
  withJson({
    path: ['queue', 'reorder'],
    summary: 'Replace the queue with the supplied issue order.',
    repeated: ['--id'],
    requireRepeated: ['--id'],
    normalize: (p) => ['queue', 'reorder', ...(p.repeated.get('--id') ?? []), ...jsonArg(p)],
  }),
  withJson({
    path: ['feed'],
    summary: 'Read the board activity feed.',
    values: ['--limit', '--cursor'],
    normalize: (p) => ['feed', ...valueArgs(p, ['--limit', '--cursor']), ...jsonArg(p)],
  }),
  withJson({
    path: ['list'],
    summary: 'List board issues.',
    values: ['--state'],
    normalize: (p) => ['list', ...valueArgs(p, ['--state']), ...jsonArg(p)],
  }),
  withJson({
    path: ['show'],
    summary: 'Show one board issue.',
    values: ['--id'],
    required: ['--id'],
    normalize: (p) => ['show', p.values.get('--id')!, ...jsonArg(p)],
  }),
  withJson({
    path: ['create'],
    summary: 'Create a board issue. Antonina assigns and returns the issue number.',
    values: ['--title', '--body'],
    required: ['--title'],
    normalize: (p) => ['create', p.values.get('--title')!, ...valueArgs(p, ['--body']), ...jsonArg(p)],
  }),
  withJson({
    path: ['edit'],
    summary: 'Replace an issue description.',
    values: ['--id', '--body'],
    required: ['--id', '--body'],
    normalize: (p) => ['edit', p.values.get('--id')!, '--body', p.values.get('--body')!, ...jsonArg(p)],
  }),
  withJson({
    path: ['comment'],
    summary: 'Append a comment to an issue.',
    values: ['--id', '--body', '--author'],
    required: ['--id', '--body'],
    normalize: (p) => [
      'comment',
      p.values.get('--id')!,
      p.values.get('--body')!,
      ...valueArgs(p, ['--author']),
      ...jsonArg(p),
    ],
  }),
  ...(['close', 'reopen', 'delete'] as const).map((command): CommandSpec => withJson({
    path: [command],
    summary: command === 'close' ? 'Close an issue.' : command === 'reopen' ? 'Reopen an issue.' : 'Delete an issue.',
    values: ['--id'],
    required: ['--id'],
    normalize: (p) => [command, p.values.get('--id')!, ...jsonArg(p)],
  })),
  withJson({
    path: ['delete-board'],
    summary: 'Delete the whole board.',
    normalize: (p) => ['delete-board', ...jsonArg(p)],
  }),
  withJson({
    path: ['resource', 'list'],
    summary: 'List registered board resources.',
    values: ['--host', '--issue'],
    normalize: (p) => ['resource', 'list', ...valueArgs(p, ['--host', '--issue']), ...jsonArg(p)],
  }),
  ...(['add', 'remove'] as const).map((subcommand): CommandSpec => withJson({
    path: ['resource', subcommand],
    summary: subcommand === 'add' ? 'Register an issue dependency on a resource.' : 'Remove an issue dependency on a resource.',
    values: ['--issue', '--host', '--path'],
    required: ['--issue', '--host', '--path'],
    normalize: (p) => [
      'resource',
      subcommand,
      p.values.get('--issue')!,
      p.values.get('--host')!,
      p.values.get('--path')!,
      ...jsonArg(p),
    ],
  })),
  withJson({
    path: ['target', 'list'],
    summary: 'List execution targets.',
    values: ['--backend', '--kind'],
    normalize: (p) => ['target', 'list', ...valueArgs(p, ['--backend', '--kind']), ...jsonArg(p)],
  }),
  withJson({
    path: ['target', 'show'],
    summary: 'Show one execution target.',
    values: ['--id'],
    required: ['--id'],
    normalize: (p) => ['target', 'show', p.values.get('--id')!, ...jsonArg(p)],
  }),
  withJson({
    path: ['target', 'add'],
    summary: 'Register an execution target.',
    values: ['--id', '--backend', '--kind', '--address', '--description'],
    repeated: ['--capability', '--limitation', '--guidance'],
    required: ['--id', '--backend', '--kind'],
    normalize: (p) => [
      'target',
      'add',
      p.values.get('--id')!,
      ...valueArgs(p, ['--backend', '--kind', '--address', '--description']),
      ...repeatedArgs(p, '--capability'),
      ...repeatedArgs(p, '--limitation'),
      ...repeatedArgs(p, '--guidance'),
      ...jsonArg(p),
    ],
  }),
  withJson({
    path: ['target', 'set'],
    summary: 'Update an execution target.',
    values: ['--id', '--status', '--description'],
    repeated: ['--capability', '--limitation', '--guidance'],
    flags: ['--clear-limitations', '--clear-guidance'],
    required: ['--id'],
    normalize: (p) => [
      'target',
      'set',
      p.values.get('--id')!,
      ...valueArgs(p, ['--status', '--description']),
      ...repeatedArgs(p, '--capability'),
      ...repeatedArgs(p, '--limitation'),
      ...repeatedArgs(p, '--guidance'),
      ...flagArgs(p, ['--clear-limitations', '--clear-guidance']),
      ...jsonArg(p),
    ],
  }),
  withJson({
    path: ['dispatch', 'select'],
    summary: 'Select an execution target for a routing request.',
    values: ['--target', '--backend', '--kind'],
    repeated: ['--capability'],
    normalize: (p) => [
      'dispatch',
      'select',
      ...valueArgs(p, ['--target', '--backend', '--kind']),
      ...repeatedArgs(p, '--capability'),
      ...jsonArg(p),
    ],
  }),
  withJson({
    path: ['dispatch', 'record'],
    summary: 'Record an issue dispatch.',
    values: ['--id', '--target', '--backend', '--kind'],
    repeated: ['--capability'],
    required: ['--id'],
    normalize: (p) => [
      'dispatch',
      'record',
      ...valueArgs(p, ['--target', '--backend', '--kind']),
      ...repeatedArgs(p, '--capability'),
      p.values.get('--id')!,
      ...jsonArg(p),
    ],
  }),
  withJson({
    path: ['import'],
    summary: 'Report or perform the board format cutover (operator action).',
    flags: ['--confirm'],
    normalize: (p) => ['import', ...flagArgs(p, ['--confirm']), ...jsonArg(p)],
  }),
  withJson({
    path: ['collect', 'list'],
    summary: 'List collectible resources on one host.',
    values: ['--host'],
    required: ['--host'],
    normalize: (p) => ['collect', 'list', '--host', p.values.get('--host')!, ...jsonArg(p)],
  }),
  withJson({
    path: ['collect', 'delete'],
    summary: 'Delete one collectible resource after re-verification.',
    values: ['--host', '--path'],
    flags: ['--confirm'],
    required: ['--host', '--path'],
    normalize: (p) => [
      'collect',
      'delete',
      '--host',
      p.values.get('--host')!,
      '--path',
      p.values.get('--path')!,
      ...flagArgs(p, ['--confirm']),
      ...jsonArg(p),
    ],
  }),
];

const AGENT_SPECS: readonly CommandSpec[] = [
  {
    path: ['new'],
    summary: 'Create an idle managed agent.',
    values: ['--id', '--cwd', '--title'],
    flags: ['--json'],
    required: ['--id'],
    normalize: (p) => ['new', ...valueArgs(p, ['--id', '--cwd', '--title']), ...flagArgs(p, ['--json'])],
  },
  {
    path: ['list'],
    summary: 'List managed agents.',
    values: ['--limit'],
    flags: ['--json', '--running', '--finished', '--succeeded', '--failed', '--stopped', '--killed'],
    normalize: (p) => [
      'list',
      ...valueArgs(p, ['--limit']),
      ...flagArgs(p, ['--json', '--running', '--finished', '--succeeded', '--failed', '--stopped', '--killed']),
    ],
  },
  {
    path: ['status'],
    summary: 'Show one managed agent.',
    values: ['--id'],
    flags: ['--json'],
    required: ['--id'],
    normalize: (p) => ['status', '--id', p.values.get('--id')!, ...flagArgs(p, ['--json'])],
  },
  {
    path: ['run'],
    summary: 'Send work to a managed agent.',
    values: ['--id', '--prompt', '--cwd'],
    flags: ['--steer', '--detach', '--json'],
    required: ['--id', '--prompt'],
    normalize: (p) => [
      'run',
      '--id',
      p.values.get('--id')!,
      '--prompt',
      p.values.get('--prompt')!,
      ...valueArgs(p, ['--cwd']),
      ...flagArgs(p, ['--steer', '--detach', '--json']),
    ],
  },
  {
    path: ['log'],
    summary: 'Read managed-agent output.',
    values: ['--id', '--lines'],
    flags: ['--follow'],
    required: ['--id'],
    normalize: (p) => ['log', '--id', p.values.get('--id')!, ...valueArgs(p, ['--lines']), ...flagArgs(p, ['--follow'])],
  },
  {
    path: ['wait'],
    summary: 'Wait for a managed agent to stop running.',
    values: ['--id', '--timeout'],
    required: ['--id', '--timeout'],
    normalize: (p) => ['wait', '--id', p.values.get('--id')!, '--timeout', p.values.get('--timeout')!],
  },
  ...(['stop', 'kill'] as const).map((command): CommandSpec => ({
    path: [command],
    summary: command === 'stop' ? 'Stop a managed agent.' : 'Kill a managed agent.',
    values: ['--id'],
    required: ['--id'],
    normalize: (p) => [command, '--id', p.values.get('--id')!],
  })),
  {
    path: ['delete'],
    summary: 'Delete managed-agent state.',
    values: ['--id'],
    flags: ['--force'],
    required: ['--id'],
    normalize: (p) => ['delete', '--id', p.values.get('--id')!, ...flagArgs(p, ['--force'])],
  },
  {
    path: ['clean'],
    summary: 'Delete old terminal agents.',
    values: ['--days'],
    flags: ['--dry-run'],
    normalize: (p) => ['clean', ...valueArgs(p, ['--days']), ...flagArgs(p, ['--dry-run'])],
  },
];

const DAEMON_SPECS: readonly CommandSpec[] = [
  {
    path: ['identity'],
    summary: 'Print this host identity.',
    flags: ['--json'],
    normalize: (p) => ['identity', ...flagArgs(p, ['--json'])],
  },
  {
    path: ['status'],
    summary: 'Print the last host report and liveness.',
    flags: ['--json'],
    normalize: (p) => ['status', ...flagArgs(p, ['--json'])],
  },
  {
    path: ['start'],
    summary: 'Run the host daemon in the foreground.',
    normalize: () => ['start'],
  },
];

const SPECS: Readonly<Record<PublicNamespace, readonly CommandSpec[]>> = {
  agent: AGENT_SPECS,
  board: BOARD_SPECS,
  daemon: DAEMON_SPECS,
};

const GROUPS: Readonly<Record<PublicNamespace, readonly string[]>> = {
  agent: [],
  board: ['credential', 'queue', 'resource', 'target', 'dispatch', 'collect'],
  daemon: [],
};

export const TOP_LEVEL_HELP = [
  'Usage: antonina <agent|board|daemon> <command> [options]',
  '',
  'Antonina uses positional words only for command/subcommand selection.',
  'Every data argument is a named --option. Use -h or --help at any command level.',
  '',
  'Namespaces:',
  '  agent   manage delegated coding agents',
  '  board   read and mutate the signed coordination board',
  '  daemon  inspect or run the persistent host daemon',
].join('\n');

function specKey(path: readonly string[]): string {
  return path.join(' ');
}

function specFor(namespace: PublicNamespace, path: readonly string[]): CommandSpec | undefined {
  const key = specKey(path);
  return SPECS[namespace].find((spec) => specKey(spec.path) === key);
}

function initialPath(namespace: PublicNamespace, argv: readonly string[]): string[] {
  const groups = new Set(GROUPS[namespace]);
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) return [];
  if (groups.has(first)) {
    const second = argv[1];
    if (second !== undefined && !second.startsWith('-')) return [first, second];
    return [first];
  }
  return [first];
}

function namespaceHelp(namespace: PublicNamespace, group?: string): string {
  const rows: Array<{ name: string; summary: string }> = [];
  const seen = new Set<string>();
  for (const spec of SPECS[namespace]) {
    if (group !== undefined && spec.path[0] !== group) continue;
    const relative = group === undefined ? spec.path : spec.path.slice(1);
    const name = relative[0];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      name,
      summary: group === undefined && GROUPS[namespace].includes(name)
        ? name + ' commands'
        : spec.summary,
    });
  }
  const usage = group === undefined
    ? 'Usage: antonina ' + namespace + ' <command> [options]'
    : 'Usage: antonina ' + namespace + ' ' + group + ' <command> [options]';
  return [
    usage,
    '',
    'Commands:',
    ...rows.map((row) => '  ' + row.name.padEnd(12) + row.summary),
    '',
    'Use -h or --help after any command for its options.',
  ].join('\n');
}

function commandHelp(namespace: PublicNamespace, spec: CommandSpec): string {
  const optionNames = [...(spec.values ?? []), ...(spec.repeated ?? []), ...(spec.flags ?? [])];
  const rows = optionNames.map((name) => {
    const takesValue = (spec.values ?? []).includes(name) || (spec.repeated ?? []).includes(name);
    const required = (spec.required ?? []).includes(name) || (spec.requireRepeated ?? []).includes(name);
    const shown = name + (takesValue ? ' <value>' : '');
    return '  ' + shown.padEnd(24) + (OPTION_HELP[name] ?? '') + (required ? ' (required)' : '');
  });
  return [
    'Usage: antonina ' + namespace + ' ' + spec.path.join(' ') + (optionNames.length === 0 ? '' : ' [options]'),
    '',
    spec.summary,
    ...(rows.length === 0 ? [] : ['', 'Options:', ...rows]),
    '',
    '  -h, --help              Show this help.',
  ].join('\n');
}

function helpPlan(namespace: PublicNamespace, argv: readonly string[]): PublicHelpPlan | null {
  if (!argv.includes('--help') && !argv.includes('-h')) return null;
  const path = initialPath(namespace, argv);
  if (path.length === 0) return { kind: 'help', text: namespaceHelp(namespace) };
  if (path.length === 1 && GROUPS[namespace].includes(path[0]!)) {
    return { kind: 'help', text: namespaceHelp(namespace, path[0]!) };
  }
  const spec = specFor(namespace, path);
  if (spec === undefined) throw new PublicCliUsageError('unknown ' + namespace + ' command: ' + path.join(' '));
  return { kind: 'help', text: commandHelp(namespace, spec) };
}

function parseOptions(tokens: readonly string[], spec: CommandSpec): ParsedOptions {
  const flags = new Set(spec.flags ?? []);
  const values = new Set(spec.values ?? []);
  const repeated = new Set(spec.repeated ?? []);
  const parsed: ParsedOptions = { flags: new Set(), values: new Map(), repeated: new Map() };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith('--')) {
      throw new PublicCliUsageError(
        'unexpected positional argument ' + JSON.stringify(token)
          + '; every data argument must use a named --option',
      );
    }

    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);

    if (flags.has(name)) {
      if (inline !== undefined) throw new PublicCliUsageError(name + ' is a flag and does not take a value');
      if (parsed.flags.has(name)) throw new PublicCliUsageError(name + ' was provided more than once');
      parsed.flags.add(name);
      continue;
    }

    if (!values.has(name) && !repeated.has(name)) throw new PublicCliUsageError('unknown option ' + name);
    const value = inline ?? tokens[index + 1];
    if (value === undefined) throw new PublicCliUsageError(name + ' requires a value');
    if (inline === undefined) index += 1;

    if (values.has(name)) {
      if (parsed.values.has(name)) throw new PublicCliUsageError(name + ' was provided more than once');
      parsed.values.set(name, value);
    } else {
      const entries = parsed.repeated.get(name) ?? [];
      entries.push(value);
      parsed.repeated.set(name, entries);
    }
  }

  for (const name of spec.required ?? []) {
    if (!parsed.values.has(name)) throw new PublicCliUsageError(name + ' is required');
  }
  for (const name of spec.requireRepeated ?? []) {
    if ((parsed.repeated.get(name) ?? []).length === 0) throw new PublicCliUsageError(name + ' is required');
  }
  return parsed;
}

export function preparePublicCommand(namespace: PublicNamespace, argv: readonly string[]): PublicCommandPlan {
  const help = helpPlan(namespace, argv);
  if (help !== null) return help;

  const path = initialPath(namespace, argv);
  if (path.length === 0) throw new PublicCliUsageError('a ' + namespace + ' command is required');
  if (path.length === 1 && GROUPS[namespace].includes(path[0]!)) {
    throw new PublicCliUsageError(path[0] + ' requires a subcommand');
  }
  const spec = specFor(namespace, path);
  if (spec === undefined) throw new PublicCliUsageError('unknown ' + namespace + ' command: ' + path.join(' '));

  const parsed = parseOptions(argv.slice(path.length), spec);
  return { kind: 'run', args: spec.normalize(parsed) };
}

export function publicCommandPaths(namespace: PublicNamespace): readonly (readonly string[])[] {
  return SPECS[namespace].map((spec) => spec.path);
}
