import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessionId, buildAgentCommand } from '../dist/packages/agent-runtime/src/backend.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

test('session discovery uses the agent worktree, not the caller directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-session-cwd-'));
  try {
    const worktree = join(root, 'agent-worktree');
    mkdirSync(worktree);
    const executable = join(root, 'fake-opencode');
    const rows = JSON.stringify([{id:'ses_verified', title:'antonina-cd123', created:14}]);
    writeFileSync(executable, '#!/bin/sh\nif [ "$(pwd -P)" = ' + JSON.stringify(worktree) + ' ]; then printf "%s\\n" ' + JSON.stringify(rows) + '; fi\n', {mode:0o755});
    const env={ANTONINA_OPENCODE_BIN:executable};
    assert.equal(discoverSessionId('cd123',env,worktree),'ses_verified');
    const meta = idleMeta('cd123', worktree, 'agent');
    meta.native_session_id = null;
    assert.equal(buildAgentCommand(meta,'prompt',true,env)?.includes('ses_verified'), true);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
