#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runManagedRunner } from '../../agent-runtime/src/runner.js';
import { runAgentCommand, type AgentCommandContext } from './agent.js';
import { versionFields, versionJson, versionLine } from './build-identity.js';
import { runBoardCommand } from './board.js';
import { runDaemonCommand } from './daemon.js';
import {
  PublicCliUsageError,
  TOP_LEVEL_HELP,
  preparePublicCommand,
  type PublicNamespace,
} from './public-cli.js';


function io() {
  return {
    stdout: (text: string) => { process.stdout.write(`${text}\n`); },
    stdoutRaw: (text: string) => { process.stdout.write(text); },
    stderr: (text: string) => { process.stderr.write(`${text}\n`); },
  };
}

function agentContext(): AgentCommandContext {
  const entryScript = process.argv[1];
  return {
    env: process.env,
    cwd: process.cwd(),
    io: io(),
    ...(entryScript === undefined ? {} : { entryScript }),
  };
}

/**
 * `antonina --version`, and its `-V` short form.
 *
 * This is deliberately not routed through `runPublicNamespace`. That path
 * reports a usage error, and routing a successful query through it is how the
 * flag ended up reporting "expected agent, board or daemon command namespace"
 * while exiting 0: the operator's query was answered by the error branch, so a
 * script reading the exit code was told the query succeeded. Here the success
 * case prints identity and returns 0 explicitly, and only a genuinely malformed
 * invocation returns non-zero.
 */
function runVersionCommand(args: string[]): number {
  const wantsJson = args.includes('--json');
  const stray = args.filter((arg) => arg !== '--json');
  if (stray.length > 0) {
    process.stderr.write(`antonina: unexpected argument to --version: ${stray[0]}\n`);
    process.stderr.write("Try 'antonina --version'.\n");
    return 2;
  }
  process.stdout.write(
    (wantsJson ? JSON.stringify(versionJson()) : [versionLine(), ...versionFields()].join('\n')) + '\n',
  );
  return 0;
}

async function runPublicNamespace(namespace: PublicNamespace, args: string[]): Promise<number> {
  let plan;
  try {
    plan = preparePublicCommand(namespace, args);
  } catch (error) {
    if (!(error instanceof PublicCliUsageError)) throw error;
    process.stderr.write(`antonina: ${error.message}\n`);
    process.stderr.write(`Try 'antonina ${namespace} --help'.\n`);
    return 2;
  }

  if (plan.kind === 'help') {
    process.stdout.write(plan.text + '\n');
    return 0;
  }
  if (namespace === 'board') return runBoardCommand(plan.args, { env: process.env, io: io() });
  if (namespace === 'daemon') return runDaemonCommand(plan.args, { env: process.env, io: io() });
  return runAgentCommand(plan.args, agentContext());
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [namespace, ...args] = argv;
  if (namespace === '--help' || namespace === '-h') {
    process.stdout.write(TOP_LEVEL_HELP + '\n');
    return 0;
  }
  if (namespace === '--version' || namespace === '-V') {
    return runVersionCommand(args);
  }
  if (namespace === '_runner') {
    const [agentId, mode, generationRaw] = args;
    if (
      agentId === undefined
      || (mode !== 'new' && mode !== 'continue')
      || generationRaw === undefined
      || !/^[1-9][0-9]*$/.test(generationRaw)
    ) return 2;
    const generation = Number(generationRaw);
    if (!Number.isSafeInteger(generation)) return 2;
    await runManagedRunner(agentId, mode, generation, { env: process.env });
    return 0;
  }
  if (namespace === 'board' || namespace === 'daemon' || namespace === 'agent') {
    return runPublicNamespace(namespace, args);
  }
  process.stderr.write('antonina: expected "agent", "board" or "daemon" command namespace\n');
  process.stderr.write("Try 'antonina --help'.\n");
  return 2;
}

function isMainModule(): boolean {
  const argvEntry = process.argv[1];
  if (argvEntry === undefined) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main().then((code) => { process.exitCode = code; });
}
