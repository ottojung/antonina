import { configuredModels, modelConfigPath } from '../../agent-runtime/src/model-config.js';
import { selectConfiguredModel } from '../../agent-runtime/src/backend.js';

/** Read-only model inspection. Orchestrators edit config.json atomically themselves. */
export function runModelCommand(args: string[], env = process.env): number {
  try {
    if (args.length !== 1) throw new Error('model: expected "list" or "select"');
    if (args[0] === 'list') {
      process.stdout.write(JSON.stringify({ path: modelConfigPath(env), models: configuredModels(env) }, null, 2) + '\n');
      return 0;
    }
    if (args[0] === 'select') {
      process.stdout.write(selectConfiguredModel(env) + '\n');
      return 0;
    }
    throw new Error('model: expected "list" or "select"');
  } catch (error) {
    process.stderr.write('antonina: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    return 1;
  }
}
