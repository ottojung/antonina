import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const config = JSON.parse(readFileSync(fileURLToPath(new URL('../../../config/opencode-openclaw.json', import.meta.url)), 'utf8'));
const turn = readFileSync(fileURLToPath(new URL('../../../scripts/antonina-orchestrator-turn', import.meta.url)), 'utf8');

test('OpenClaw scheduler config pins LongCat 2.5 Preview Free through opencode-go', () => {
  assert.equal(config.model, 'opencode-go/longcat-2.5-preview-free');
  assert.equal(config.small_model, 'opencode-go/longcat-2.5-preview-free');
  assert.deepEqual(config.provider['opencode-go'].whitelist, ['longcat-2.5-preview-free']);
  assert.match(turn, /--model opencode-go\/longcat-2.5-preview-free/);
});
