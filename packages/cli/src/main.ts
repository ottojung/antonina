#!/usr/bin/env node
import { runAgentCommand } from './agent.js';
import { runBoardCommand } from './board.js';

const AGENT_COMMANDS = new Set(['new', 'list', 'status', 'prompt', 'log', 'wait', 'stop', 'kill', 'delete', 'clean']);

function io() {
  return {
    stdout: (text: string) => { process.stdout.write(`${text}\n`); },
    stderr: (text: string) => { process.stderr.write(`${text}\n`); },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [namespace, ...args] = argv;
  if (namespace === 'board') {
    return runBoardCommand(args, { env: process.env, io: io() });
  }
  if (namespace === 'agent') {
    return runAgentCommand(args, { env: process.env, cwd: process.cwd(), io: io() });
  }
  // Preserve the pre-migration top-level agent command spellings while the
  // documented namespace converges on `antonina agent ...`.
  if (namespace !== undefined && AGENT_COMMANDS.has(namespace)) {
    return runAgentCommand(argv, { env: process.env, cwd: process.cwd(), io: io() });
  }
  process.stderr.write('antonina: expected "agent" or "board" command namespace\n');
  return 2;
}

if (process.argv[1]?.endsWith('/main.js')) {
  void main().then((code) => { process.exitCode = code; });
}
