import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, updateMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

function fixture(t, id, outageCount, orphan = false) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-endpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const counter = join(root, 'counter');
  const effects = join(root, 'effects');
  const orphanPid = join(root, 'orphan-pid');
  const executable = join(root, 'opencode');
  const lines = [
    '#!/bin/sh',
    'if [ "$1" = "session" ]; then exit 1; fi',
    'if [ "$1" = "models" ]; then echo opencode-go/longcat-2.5-preview-free; exit 0; fi',
    'COUNT=' + JSON.stringify(counter),
    'EFFECTS=' + JSON.stringify(effects),
    'ORPHAN=' + JSON.stringify(orphanPid),
    'n=$(cat "$COUNT" 2>/dev/null || echo 0)',
    'n=$((n+1))',
    'echo "$n" > "$COUNT"',
    'echo "tool-called-$n" >> "$EFFECTS"',
    ...(orphan ? [
      'if [ "$n" -eq 1 ]; then',
      '  sleep 20 &',
      '  echo $! > "$ORPHAN"',
      'fi',
    ] : []),
    'if [ "$n" -le ' + outageCount + ' ]; then',
    '  echo "Error: Upstream request failed: Endpoint is unavailable."',
    '  exit 1',
    'fi',
    'echo "Recovered and finished"',
    'exit 0',
  ];
  writeFileSync(executable, lines.join('\n') + '\n', { mode: 0o755 });
  const ownerToken = mintRunnerReservationOwnerToken();
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    ANTONINA_OPENCODE_BIN: executable,
    ANTONINA_RUNNER_OWNER_TOKEN: ownerToken,
  };
  const options = { env };
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  meta.runner_gen = 7;
  meta.runner_reservation = {
    state: 'reserved', gen: 7, mode: 'new', reserved_at: Date.now() / 1000,
    owner_pid: process.pid, owner_start_ticks: procStartTicks(process.pid),
    owner_token: ownerToken,
  };
  meta.pending_prompt = 'complete work';
  writeMeta(id, meta, options);
  return { root, cwd, counter, effects, orphanPid, options, id };
}

async function run(t, f) {
  await Promise.race([
    runManagedRunner(f.id, 'new', 7, f.options),
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('recovery timed out')), 15_000);
      t.after(() => clearTimeout(timeout));
    }),
  ]);
  return readMeta(f.id, f.options);
}

test('endpoint outage automatically retries, tolerates duplicate tool effects, retains agent identity', async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const f = fixture(t, '311311', 2);
  const after = await run(t, f);
  assert.equal(after?.id, '311311');
  assert.equal(after?.cwd, f.cwd);
  assert.equal(after?.state, 'succeeded');
  assert.equal(readFileSync(f.counter, 'utf8').trim(), '3');
  assert.equal(readFileSync(f.effects, 'utf8').trim().split('\n').length, 3);
});

test('orphaned tool process from failed invocation is killed before next attempt; unrelated one survives', async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const f = fixture(t, '311312', 1, true);
  const unrelated = spawn('sleep', ['15'], { stdio: 'ignore' });
  t.after(() => { try { unrelated.kill('SIGKILL'); } catch {} });
  const after = await run(t, f);
  assert.equal(after?.state, 'succeeded');
  assert.ok(existsSync(f.orphanPid));
  assert.equal(procStartTicks(Number(readFileSync(f.orphanPid, 'utf8'))), null,
    'old tool process must be dead before recovery completes');
  assert.notEqual(procStartTicks(unrelated.pid), null, 'other process must survive');
});

test('operator stop during endpoint outage cancels retries', async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const f = fixture(t, '311313', 100);
  const running = runManagedRunner(f.id, 'new', 7, f.options);
  for (let i = 0; i < 75; i++) {
    const meta = readMeta(f.id, f.options);
    if (meta?.backend_error?.classification === 'upstream_endpoint_unavailable') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await updateMeta(f.id, (meta) => {
    meta.intent = 'stop';
    meta.stop_reason = 'stop';
  }, f.options);
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop timed out')), 5_000)),
  ]);
  const after = readMeta(f.id, f.options);
  assert.equal(after?.state, 'stopped');
  const count = Number(readFileSync(f.counter, 'utf8').trim());
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(Number(readFileSync(f.counter, 'utf8').trim()), count, 'no restart after stop');
});
