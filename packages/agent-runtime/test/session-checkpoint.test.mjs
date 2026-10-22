import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sessionIdFromOpenCodeEvent, SessionCheckpointReader,
} from '../dist/packages/agent-runtime/src/session-checkpoint.js';

test('only canonical top-level OpenCode JSON events can checkpoint sessions', () => {
  assert.equal(sessionIdFromOpenCodeEvent('not JSON'), null);
  assert.equal(sessionIdFromOpenCodeEvent(JSON.stringify({
    type: 'tool_output', sessionID: 'ses_spoof',
  })), null);
  assert.equal(sessionIdFromOpenCodeEvent(JSON.stringify({
    type: 'step_start', part: { sessionID: 'ses_nested' },
  })), null);
  assert.equal(sessionIdFromOpenCodeEvent(JSON.stringify({
    type: 'step_start', sessionID: '../bad',
  })), null);
  assert.equal(sessionIdFromOpenCodeEvent(JSON.stringify({
    type: 'step_start', sessionID: 'ses_realcheckpoint', part: { type: 'step-start' },
  })), 'ses_realcheckpoint');
  assert.equal(sessionIdFromOpenCodeEvent(JSON.stringify({
    type: 'error', sessionID: 'ses_errorevent',
  })), 'ses_errorevent');
});

test('reader handles partial JSONL, old log boundaries and repeated scans', () => {
  const root=mkdtempSync(join(tmpdir(),'antonina-session-checkpoint-'));
  try {
    const file=join(root,'output.log');
    writeFileSync(file,'{"type":"step_start","sessionID":"ses_previous"}\n');
    const start=Buffer.byteLength(readFileSync(file));
    const reader=new SessionCheckpointReader(file,start);
    assert.equal(reader.scan(),null);
    appendFileSync(file,'{"type":"step_start","sessionID":');
    assert.equal(reader.scan(),null);
    appendFileSync(file,'"ses_current"}\n{"type":"error","sessionID":"ses_later"}\n');
    assert.equal(reader.scan(),'ses_current');
    assert.equal(reader.scan(),'ses_current');
  }finally{rmSync(root,{recursive:true,force:true});}
});
