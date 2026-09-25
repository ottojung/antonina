#!/usr/bin/env node
import { runBoardCommand } from './board.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [namespace, ...args] = argv;
  if (namespace === 'board') {
    return runBoardCommand(args, {
      env: process.env,
      io: {
        stdout: (text) => { process.stdout.write(`${text}\n`); },
        stderr: (text) => { process.stderr.write(`${text}\n`); },
      },
    });
  }
  process.stderr.write('antonina: the TypeScript agent runtime migration is not complete on this branch\n');
  return 1;
}

if (process.argv[1]?.endsWith('/main.js')) {
  void main().then((code) => { process.exitCode = code; });
}
