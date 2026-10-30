import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationActivity, recoverableOpenCodeError, safeAlternativeModel } from '../dist/packages/agent-runtime/src/liveness.js';
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
    // A finished tool-call step is different from a tool still executing.
    appendFileSync(log, event('step_finish', { reason: 'tool-calls' }));
    assert.equal(monitor.observe(pid, ticks, 2500, 500).diagnosis, 'progressing_or_uncertain');
    assert.equal(monitor.observe(pid, ticks, 5000, 500).diagnosis, 'step_finished_silent');
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
    // A transient penalty is soft, not a reason to refuse a safe fallback.
    assert.equal(safeAlternativeModel(meta,'example/luna',env),true);
    meta.model_failover.cooldowns[0].reason='quota_exhausted';
    assert.equal(safeAlternativeModel(meta,'example/luna',env),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a resumed invocation silent from its first byte is detected independently of step_start', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-startup-'));
  try {
    const file=join(dir,'log');
    writeFileSync(file,'prior invocation had tool output\n');
    const offset=Buffer.byteLength('prior invocation had tool output\n');
    const monitor=new InvocationActivity(file,offset,0,()=>({...readProcStat(pid),state:'S'}));
    assert.equal(monitor.observe(pid,ticks,200,500).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,550,500).diagnosis,'startup_silent');
    // OpenCode's own cosmetic footer is not a tool operation or proof of a new step.
    appendFileSync(file,'\u001b[0m> build · beam-free\n');
    assert.equal(monitor.observe(pid,ticks,600,500).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,1200,500).diagnosis,'startup_silent');
    appendFileSync(file,'Unstructured backend diagnostic\n');
    assert.equal(monitor.observe(pid,ticks,2100,500).diagnosis,'progressing_or_uncertain');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a terminal OpenCode APIError followed by its display footer triggers model recovery', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-provider-'));
  try {
    const file=join(dir,'log');
    writeFileSync(file,'');
    const monitor=new InvocationActivity(file,0,0,()=>({...readProcStat(pid),state:'S'}));
    const errorEvent=(message,statusCode)=>JSON.stringify({type:'error',sessionID:'ses_live',
      error:{name:'APIError',data:{message,statusCode,isRetryable:true}}})+'\n';
    appendFileSync(file,errorEvent('The usage limit has been reached',429)+'\u001b[0m> build · beam-free\n');
    assert.equal(monitor.observe(pid,ticks,100,1000,300).diagnosis,'progressing_or_uncertain');
    const observed=monitor.observe(pid,ticks,450,1000,300);
    assert.equal(observed.diagnosis,'backend_error_silent');
    assert.equal(observed.backendFailure,'model_quota_exhausted');
    appendFileSync(file,event('step_start'));
    assert.equal(monitor.observe(pid,ticks,490,1000,300).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,1600,1000,300).diagnosis,'model_step_silent');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('refuse automatic failover on authentication, billing, unknown errors and tool activity', () => {
  const samples=[
    [401,'Unauthorized','backend_authentication_failed'],
    [402,'Payment Required','backend_billing_required'],
    [403,'permission denied',null],
    [400,'Failed to compile user project',null],
    [429,'invalid_api_key: The usage limit has been reached','backend_authentication_failed'],
  ];
  for (const [statusCode,message,expected] of samples) {
    const e={type:'error',sessionID:'ses_live',error:{name:'APIError',data:{message,statusCode}}};
    assert.equal(recoverableOpenCodeError(e),expected);
  }
  const valid={type:'error',sessionID:'ses_live',error:{name:'APIError',data:{message:'rate limit exceeded',statusCode:429}}};
  assert.equal(recoverableOpenCodeError(valid),'upstream_rate_limited');
  assert.equal(recoverableOpenCodeError({type:'error',error:{name:'Error',data:{statusCode:429}}}),null);
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-unsafe-'));
  try {
    const file=join(dir,'log');
    writeFileSync(file,event('tool_use',{type:'tool',state:{status:'running'}}));
    const monitor=new InvocationActivity(file,0,0,()=>({...readProcStat(pid),state:'S'}));
    assert.equal(monitor.observe(pid,ticks,2000,100,100).diagnosis,'progressing_or_uncertain');
    appendFileSync(file,JSON.stringify({type:'error',sessionID:'ses_live',
      error:{name:'APIError',data:{message:'invalid_api_key',statusCode:401}}})+'\n');
    assert.equal(monitor.observe(pid,ticks,2100,100,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,2400,100,100).diagnosis,'backend_error_silent');
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('both observed production stall patterns recover after the final tool-call step', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-repro-'));
  try {
    for (const name of ['volodyslav-92','pyreports-201']) {
      const file=join(dir,name);
      writeFileSync(file,'');
      const monitor=new InvocationActivity(file,0,0,()=>({...readProcStat(pid),state:'S'}));
      appendFileSync(file,event('step_start'));
      appendFileSync(file,JSON.stringify({type:'tool_use',sessionID:'ses_live',
        part:{type:'tool',tool:'bash',state:{status:'completed',metadata:{exit:0}}}})+'\n');
      appendFileSync(file,event('step_finish',{reason:'tool-calls'}));
      assert.equal(monitor.observe(pid,ticks,5,100).diagnosis,'progressing_or_uncertain',name);
      assert.equal(monitor.observe(pid,ticks,200,100).diagnosis,'step_finished_silent',name);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('watchdog differentiates running tools, intermediate tool results and complete steps', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-boundaries-'));
  try {
    const file=join(dir,'log');writeFileSync(file,'');
    const monitor=new InvocationActivity(file,0,0,()=>({...readProcStat(pid),state:'S'}));
    appendFileSync(file,event('step_start'));
    appendFileSync(file,JSON.stringify({type:'tool_use',sessionID:'ses_live',
      part:{type:'tool',state:{status:'running'}}})+'\n');
    assert.equal(monitor.observe(pid,ticks,1000,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,1200,100).diagnosis,'tool_running_silent');
    appendFileSync(file,JSON.stringify({type:'tool_use',sessionID:'ses_live',
      part:{type:'tool',state:{status:'completed'}}})+'\n');
    assert.equal(monitor.observe(pid,ticks,1300,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,1500,100).diagnosis,'tool_running_silent',
      'other tools may still be in flight');
    appendFileSync(file,event('step_finish',{reason:'tool-calls'}));
    appendFileSync(file,event('text',{text:'after finish'}));
    appendFileSync(file,event('reasoning',{text:'ordinary non-boundary event'}));
    assert.equal(monitor.observe(pid,ticks,1600,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,1800,100).diagnosis,'step_finished_silent');
    appendFileSync(file,event('step_start'));
    assert.equal(monitor.observe(pid,ticks,1900,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,2100,100).diagnosis,'model_step_silent');
    appendFileSync(file,event('step_finish',{reason:'stop'}));
    assert.equal(monitor.observe(pid,ticks,2200,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,2400,100).diagnosis,'step_finished_silent',
      'finished response must not leave an immortal process');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('incomplete frames and unknown errors are reported as unverifiable rather than silently healthy', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-liveness-uncertain-'));
  try {
    const file=join(dir,'log');writeFileSync(file,event('step_start'));
    const monitor=new InvocationActivity(file,0,0,()=>({...readProcStat(pid),state:'S'}));
    appendFileSync(file,'{\"type\":\"text\",\"sessionID\":\"ses_live\"');
    assert.equal(monitor.observe(pid,ticks,100,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,250,100).diagnosis,'unverifiable_silent');
    appendFileSync(file,'}\n');
    assert.equal(monitor.observe(pid,ticks,300,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,500,100).diagnosis,'model_step_silent',
      'complete non-boundary frames cannot erase a confirmed model step');
    appendFileSync(file,'bad non-JSON output\n');
    assert.equal(monitor.observe(pid,ticks,600,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,800,100).diagnosis,'unverifiable_silent');
    appendFileSync(file,event('step_start'));
    assert.equal(monitor.observe(pid,ticks,900,100).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,1100,100).diagnosis,'model_step_silent');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('silent startup is checked sooner than in-flight model work', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-startup-timeout-'));
  try {
    const file=join(dir,'log');writeFileSync(file,'');
    const monitor=new InvocationActivity(file,0,0,()=>({...readProcStat(pid),state:'S'}));
    assert.equal(monitor.observe(pid,ticks,89_000).diagnosis,'progressing_or_uncertain');
    assert.equal(monitor.observe(pid,ticks,90_000).diagnosis,'startup_silent');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
