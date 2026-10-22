import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, updateMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const LUNA='example.test/luna';
const BEAM='example.test/beam';

async function exercise(t, fixture) {
  const root=mkdtempSync(join(tmpdir(),'antonina-live-failover-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config','antonina');
  mkdirSync(config,{recursive:true});
  writeFileSync(join(config,'config.json'),JSON.stringify({models:[
    {model:LUNA,comment:'fixture'}, {model:BEAM,comment:'fixture'},
  ]}));
  const bin=join(root,'opencode');
  const calls=join(root,'calls.log');
  const script='#!/bin/sh\n'
    +'if [ "$1" = "session" ]; then echo "[]"; exit 0; fi\n'
    +'model=""\nsession=""\nformat=""\nprev=""\n'
    +'for x in "$@"; do\n'
    +'  if [ "$prev" = "--model" ]; then model="$x"; fi\n'
    +'  if [ "$prev" = "--session" ]; then session="$x"; fi\n'
    +'  if [ "$prev" = "--format" ]; then format="$x"; fi\n'
    +'  prev="$x"\n'
    +'done\n'
    +'[ "$format" = "json" ] || exit 48\n'
    +'echo "$model" >> "$ANTONINA_LIVENESS_CALLS"\n'
    +'if [ "$model" = "example.test/luna" ]; then\n'
    +(fixture==='pending-tool'
      ? '  printf \'{"type":"step_finish","sessionID":"ses_liveness","part":{"reason":"tool-calls"}}\\n\'\n'
      : fixture==='no-session'
        ? '  echo "unstructured backend output"\n'
        : '  printf \'{"type":"step_start","sessionID":"ses_liveness","part":{"type":"step-start"}}\\n\'\n')
    +'  sleep 3600\n'
    +'  exit 1\n'
    +'fi\n'
    +'[ "$session" = "ses_liveness" ] || exit 49\n'
    +'echo "BACKEND_SUCCEEDED"\n'
    +'exit 0\n';
  writeFileSync(bin,script,{mode:0o755});
  const env={
    XDG_CONFIG_HOME:join(root,'config'),
    XDG_STATE_HOME:join(root,'state'),
    ANTONINA_OPENCODE_BIN:bin,
    ANTONINA_LIVENESS_CALLS:calls,
    ANTONINA_RUNNER_OWNER_TOKEN:mintRunnerReservationOwnerToken(),
  };
  mkdirSync(env.XDG_STATE_HOME,{recursive:true});
  const id='liveness-'+fixture;
  const cwd=join(root,'work');
  mkdirSync(cwd);
  const options={env,modelStepSilenceMs:700,livenessPollMs:200};
  assert.equal(createAgentDirectory(id,options),true);
  const meta=idleMeta(id,cwd,null);
  const mode=fixture==='resume'?'continue':'new';
  if (mode==='continue') meta.native_session_id='ses_liveness';
  meta.runner_gen=1;
  meta.runner_reservation={
    state:'reserved',gen:1,mode,reserved_at:1,
    owner_pid:process.pid,owner_start_ticks:procStartTicks(process.pid),owner_token:env.ANTONINA_RUNNER_OWNER_TOKEN,
  };
  meta.pending_prompt='Work on a pure thought experiment.';
  writeMeta(id,meta,options);
  const original={};
  for(const [k,v] of Object.entries(env)) {original[k]=process.env[k]; process.env[k]=v;}
  try{
    const promise=runManagedRunner(id,mode,1,options);
    if(fixture==='pending-tool' || fixture==='no-session') {
      // These are intentionally unverified model requests. The agent must
      // stay alive through multiple silence windows until an operator stops it.
      await sleep(2300);
      const during=readMeta(id,options);
      assert.equal(during.state,'running');
      assert.equal(during.model_failover?.cooldowns?.length??0,0);
      await updateMeta(id,m=>{m.intent='stop';},options);
    }
    await promise;
  }finally {
    for(const k of Object.keys(env)) {
      if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];
    }
  }
  const finished=readMeta(id,options);
  const called=readFileSync(calls,'utf8').trim().split('\n');
  if(fixture==='pending-tool' || fixture==='no-session') {
    assert.equal(finished.state,'stopped');
    assert.deepEqual(called,[LUNA]);
    assert.equal(finished.model_failover.cooldowns.length,0);
  }else{
    assert.equal(finished.state,'succeeded',JSON.stringify({state:finished.state,error:finished.error}));
    assert.equal(finished.model_failover.selected_model,BEAM);
    assert.equal(finished.model_failover.cooldowns[0].reason,'transient_backend');
    assert.equal(finished.native_session_id,'ses_liveness');
    assert.deepEqual(called,[LUNA,BEAM]);
  }
}

test('quiet model step with session switches to Beam and resumes the exact conversation', {timeout:45000},t=>exercise(t,'fresh'));
test('quiet resumed model step switches to Beam with the same native session', {timeout:45000},t=>exercise(t,'resume'));
test('quiet period after tool-call finish does not interrupt an executing tool', {timeout:45000},t=>exercise(t,'pending-tool'));
test('unstructured silence without recorded session never authorizes a restart', {timeout:45000},t=>exercise(t,'no-session'));
