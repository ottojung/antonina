import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationActivity, safeAlternativeModel } from '../dist/packages/agent-runtime/src/liveness.js';
import { procStartTicks, readProcStat } from '../dist/packages/agent-runtime/src/process.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

const pid = process.pid;
const ticks = procStartTicks(pid);

const event = (type, part = undefined) => JSON.stringify({
  type, sessionID: 'ses_live', ...(part === undefined ? {} : { part }),
}) + '\n';

test('only a silent, authoritative ongoing model step becomes a failover candidate', () => {
  assert.notEqual(ticks, null);
  const dir = mkdtempSync(join(tmpdir(), 'antonina-liveness-unit-'));
  try {
    const log = join(dir, 'output.log');
    writeFileSync(log, 'old historical output\n');
    const start = Buffer.byteLength('old historical output\n');
    const monitor = new InvocationActivity(log, start, 1000, () => ({...readProcStat(pid), state: 'S'}));
    appendFileSync(log, event('step_start'));
    assert.equal(monitor.observe(pid, ticks, 1100, 500).diagnosis, 'progressing_or_uncertain');
    assert.equal(monitor.observe(pid, ticks, 1800, 500).diagnosis, 'model_step_silent');
    // Tool execution is not an available model request. Never attribute a
    // slow tool or a partial JSON frame to a failing model.
    appendFileSync(log, event('step_finish', { reason: 'tool-calls' }));
    assert.equal(monitor.observe(pid, ticks, 2500, 500).diagnosis, 'progressing_or_uncertain');
    assert.equal(monitor.observe(pid, ticks, 5000, 500).diagnosis, 'progressing_or_uncertain');
    appendFileSync(log, event('step_start'));
    assert.equal(monitor.observe(pid, ticks, 5200, 500).diagnosis, 'progressing_or_uncertain');
    appendFileSync(log, '{"type":"text","sessionID":"ses_live"');
    assert.equal(monitor.observe(pid, ticks, 6000, 500).diagnosis, 'progressing_or_uncertain');
    appendFileSync(log, '}\n');
    assert.equal(monitor.observe(pid, ticks, 6500, 500).diagnosis, 'progressing_or_uncertain');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('process identity failure, non-JSON output and invalid evidence cannot trigger switch', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-identity-'));
  try {
    const file=join(dir,'log');
    writeFileSync(file,event('step_start'));
    const monitor=new InvocationActivity(file,0,10,() => ({...readProcStat(pid), state: 'S'}));
    assert.equal(monitor.observe(pid,ticks+1,1000,100).diagnosis,'process_unavailable');
    assert.equal(monitor.observe(pid,ticks,1000,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,2000,100).diagnosis,'model_step_silent');
    appendFileSync(file,'plain text from a backend\n');
    assert.equal(monitor.observe(pid,ticks,3000,100).diagnosis,'progressing_or_uncertain');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('kernel D-state and process-identity changes are not mistaken for a bad model', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-proc-'));
  try {
    const file=join(dir,'log');
    writeFileSync(file,event('step_start'));
    const actual=readProcStat(pid);
    assert.notEqual(actual,null);
    const blocked=new InvocationActivity(file,0,0,()=>({...actual,state:'D'}));
    blocked.observe(pid,ticks,10000,100);
    assert.equal(blocked.observe(pid,ticks,10100,100).diagnosis,'host_io_blocked');
    const computing=new InvocationActivity(file,0,0,()=>({...actual,state:'R'}));
    assert.equal(computing.observe(pid,ticks,10000,100).diagnosis,'progressing_or_uncertain');
    const recycled=new InvocationActivity(file,0,0,()=>({...actual,startTicks:actual.startTicks+1}));
    assert.equal(recycled.observe(pid,ticks,10000,100).diagnosis,'process_unavailable');
    const zombie=new InvocationActivity(file,0,0,()=>({...actual,state:'Z'}));
    assert.equal(zombie.observe(pid,ticks,10000,100).diagnosis,'process_unavailable');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('restart requires a recorded native session and an eligible alternative model', () => {
  const root=mkdtempSync(join(tmpdir(),'antonina-liveness-models-'));
  try {
    const config=join(root,'antonina');
    mkdirSync(config);
    const env={XDG_CONFIG_HOME:root};
    writeFileSync(join(config,'config.json'),JSON.stringify({models:[
      {model:'example/luna',comment:'test'}, {model:'example/beam',comment:'test'},
    ]}));
    const meta=idleMeta('agent-test',root,null);
    assert.equal(safeAlternativeModel(meta,'example/luna',env),false);
    meta.native_session_id='ses_saved';
    assert.equal(safeAlternativeModel(meta,'example/luna',env),true);
    meta.model_failover={selected_model:'example/luna',cooldowns:[
      {model:'example/beam',reason:'transient_backend',until:Date.now()/1000+3600},
    ]};
    assert.equal(safeAlternativeModel(meta,'example/luna',env),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
