import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AGENT_MODEL,
  BACKEND_DIAGNOSTIC_MAX_BYTES,
  BACKEND_RETRY_BASE_MS,
  backendRetryDelay,
  buildAgentCommand,
  classifyBackendFailure,
  configuredModelAvailable,
  sanitizeBackendError,
} from '../dist/backend.js';
import { idleMeta } from '../dist/metadata.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-backend-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('recognized OpenCode server failure becomes bounded structured diagnostics', (t) => {
  const root = fixture(t);
  const log = join(root, 'output.log');
  writeFileSync(log, 'old failure\n');
  const start = Buffer.byteLength('old failure\n');
  writeFileSync(
    log,
    'old failure\n{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_abc123"}}\n',
  );
  const error = classifyBackendFailure(log, start, 1, false);
  assert.equal(error?.classification, 'transient_backend_server_error');
  assert.equal(error?.reference, 'err_abc123');
  assert.equal(error?.request_boundary, 'fresh_session');
  assert.equal(error?.fresh_session_useful, false);
  assert.equal(error?.transient, true);
  assert.equal(error?.automatic_retry_safe, false);
  assert.ok((error?.diagnostic_bytes ?? Infinity) <= BACKEND_DIAGNOSTIC_MAX_BYTES);
});

test('ordinary task failure is not misclassified and continuation stays explicit', (t) => {
  const root = fixture(t);
  const log = join(root, 'output.log');
  writeFileSync(log, 'deterministic task failure\n');
  assert.equal(classifyBackendFailure(log, 0, 1), null);

  writeFileSync(log, 'Unexpected server error\n');
  const continuation = classifyBackendFailure(log, 0, 1, true);
  assert.equal(continuation?.request_boundary, 'continuation');
  assert.equal(continuation?.fresh_session_useful, null);
});

test('retry policy requires positive replay-safety evidence and is bounded', () => {
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: false }, 0), null);
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: true }, 0), BACKEND_RETRY_BASE_MS);
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: true }, 1), BACKEND_RETRY_BASE_MS * 2);
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: true }, 2), null);
});

test('status sanitizer drops arbitrary persisted backend data', () => {
  const sanitized = sanitizeBackendError({
    classification: 'transient_backend_server_error',
    provider: 'opencode',
    model: AGENT_MODEL,
    request_boundary: 'continuation',
    reference: 'err_abc',
    transient: true,
    automatic_retry_safe: false,
    fresh_session_useful: null,
    backend_scope: 'unknown',
    diagnostic_bytes: 42,
    secret: 'must-not-escape',
  });
  assert.deepEqual(sanitized, {
    classification: 'transient_backend_server_error',
    provider: 'opencode',
    model: AGENT_MODEL,
    request_boundary: 'continuation',
    reference: 'err_abc',
    transient: true,
    automatic_retry_safe: false,
    fresh_session_useful: null,
    backend_scope: 'unknown',
    diagnostic_bytes: 42,
  });
  assert.equal(sanitizeBackendError({ classification: '' }), null);
});

test('configured model catalog distinguishes absence from transport failure', (t) => {
  const root = fixture(t);
  const bin = join(root, 'opencode');
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = models ]; then\n  printf "%s\\n" other/model opencode/space-bunny-free\n  exit 0\nfi\nexit 2\n');
  chmodSync(bin, 0o755);
  const env = { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` };
  assert.equal(configuredModelAvailable(env), true);

  writeFileSync(bin, '#!/bin/sh\necho other/model\n');
  chmodSync(bin, 0o755);
  assert.equal(configuredModelAvailable(env), false);

  writeFileSync(bin, '#!/bin/sh\nexit 1\n');
  chmodSync(bin, 0o755);
  assert.equal(configuredModelAvailable(env), null);
});

test('continuation command uses persisted session and configured variant', () => {
  const meta = idleMeta('a11d', '/tmp', null, 1);
  meta.native_session_id = 'ses_123';
  meta.variant = 'high';
  assert.deepEqual(buildAgentCommand(meta, 'continue work', true, {}), [
    'opencode', 'run', '--auto',
    '--session', 'ses_123',
    '--model', AGENT_MODEL,
    '--variant', 'high',
    '--thinking',
    '--dir', '/tmp',
    'continue work',
  ]);
});
