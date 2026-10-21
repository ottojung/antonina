import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// These explicit test-only preferences exercise the same fail-closed contract
// used in production, without reading an operator's host-local configuration.
export const FIXTURE_MODEL = 'example.test/mock';

export function installModelFixture(configHome) {
  const dir = join(configHome, 'antonina');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    models: [{ model: FIXTURE_MODEL, comment: 'Fixture model; not a real provider' }],
  }));
}

// Model discovery is separate from inference. A fake backend must answer
// 'models' without triggering the test's run effects (signals, sleeps, writes).
export function withModelProbe(body) {
  if (!body.startsWith('#!/bin/sh\n')) throw new Error('expected a shell backend fixture');
  return body.replace('#!/bin/sh\n', '#!/bin/sh\nif [ "$1" = "models" ]; then echo example.test/mock; exit 0; fi\n');
}
