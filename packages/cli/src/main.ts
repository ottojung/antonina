#!/usr/bin/env node
import { runManagedRunner } from '../../agent-runtime/src/runner.js';
import { runAgentCommand, type AgentCommandContext } from './agent.js';
import { runBoardCommand } from './board.js';

const AGENT_COMMANDS = new Set(['new', 'list', 'status', 'prompt', 'log', 'wait', 'stop', 'kill', 'delete', 'clean']);

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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [namespace, ...args] = argv;
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
  if (namespace === 'board') {
    return runBoardCommand(args, { env: process.env, io: io() });
  }
  if (namespace === 'agent') {
    return runAgentCommand(args, agentContext());
  }
  // Preserve the pre-migration top-level agent command spellings while the
  // documented namespace converges on `antonina agent ...`.
  if (namespace !== undefined && AGENT_COMMANDS.has(namespace)) {
    return runAgentCommand(argv, agentContext());
  }
  process.stderr.write('antonina: expected "agent" or "board" command namespace\n');
  return 2;
}

if (process.argv[1]?.endsWith('/main.js')) {
  void main().then((code) => { process.exitCode = code; });
}
