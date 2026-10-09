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

test('temporary endpoint outage is diagnosed without replaying partial work', () => {
  const d = mkdtempSync(join(tmpdir(), 'antonina-endpoint-'));
  try {
    const path = join(d, 'output.log');
    const old = 'Error: Upstream request failed: Endpoint is unavailable.\n';
    const newer = 'This turn was not affected\n';
    writeFileSync(path, old + newer);
    const unrelated = classifyBackendFailure(path, Buffer.byteLength(old), 1, true);
    assert.equal(unrelated?.classification, 'unrecognized_backend_failure');
    writeFileSync(path, 'prior successful tool action\n' + old);
    const classified = classifyBackendFailure(path, Buffer.byteLength('prior successful tool action\n'), 1, true);
    assert.equal(classified?.classification, 'upstream_endpoint_unavailable');
    assert.equal(classified?.provider, 'opencode-go');
    assert.equal(classified?.model, 'opencode-go/longcat-2.5-preview-free');
    assert.equal(classified?.request_boundary, 'continuation');
    assert.equal(classified?.transient, true);
    assert.equal(classified?.automatic_retry_safe, false);
    assert.equal(backendRetryDelay(classified, 0), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
