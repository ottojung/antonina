import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyBackendFailure, backendRetryDelay } from '../dist/packages/agent-runtime/src/backend.js';

test('Step 5 provider throttle is recognized without unsafe automatic replay', () => {
  const d = mkdtempSync(join(tmpdir(), 'antonina-rate-'));
  try {
    const path = join(d, 'output.log');
    writeFileSync(path, 'Error: Upstream request failed: Rate limit exceeded. Please try again later.\n');
    const classified = classifyBackendFailure(path, 0, 1, false);
    assert.equal(classified?.classification, 'upstream_rate_limited');
    assert.equal(classified?.provider, 'opencode-go');
    assert.equal(classified?.transient, true);
    assert.equal(classified?.automatic_retry_safe, false);
    assert.equal(backendRetryDelay(classified, 0), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
