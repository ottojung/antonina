import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const LUNA='example.test/luna';
const BEAM='example.test/beam';

async function exercise(t, kind) {
  const root=mkdtempSync(join(tmpdir(), 'antonina-model-failover-e2e-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'config','antonina');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'config.json'),JSON.stringify({models:[
    {model:LUNA,comment:'fixture'}, {model:BEAM,comment:'fixture'},
  ]}));
  const bin=join(root,'opencode');
  const trace=join(root,'calls.log');
  const script = '#!/bin/sh\n'
    + 'if [ "$1" = "models" ]; then printf "example.test/luna\\nexample.test/beam\\n"; exit 0; fi\n'
    + 'model=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "--model" ]; then model="$a"; fi; prev="$a"; done\n'
    + 'printf "%s\\n" "$model" >> "$ANTONINA_TEST_TRACE"\n'
    + 'sleep 0.12\n'
    + (kind==='quota'
        ? 'if [ "$model" = "example.test/luna" ]; then echo "Error: insufficient_quota" >&2; exit 1; fi\n'
        : 'if [ "$model" = "example.test/luna" ]; then echo "Error: Endpoint is unavailable" >&2; exit 1; fi\n')
    + 'echo "SUCCESS"; exit 0\n';
  writeFileSync(bin,script,{mode:0o755});
  const probe=spawnSync(bin,['--help'],{encoding:'utf8',timeout:5000});
  if(probe.error){t.skip('temporary fixture filesystem not executable');return;}
  assert.equal(probe.status,0);
  const env={
    XDG_CONFIG_HOME:join(root,'config'),
    XDG_STATE_HOME:join(root,'state'),
    ANTONINA_OPENCODE_BIN:bin,
    ANTONINA_TEST_TRACE:trace,
  };
  mkdirSync(env.XDG_STATE_HOME,{recursive:true});
  const token=mintRunnerReservationOwnerToken();
  env.ANTONINA_RUNNER_OWNER_TOKEN=token;
  const options={env};
  const id=kind==='quota'?'model-quota':'model-transient';
  const cwd=join(root,'work');
  mkdirSync(cwd);
  assert.equal(createAgentDirectory(id,options),true);
  const meta=idleMeta(id,cwd,null);
  meta.native_session_id='ses_fixed';
  meta.runner_gen=1;
  meta.runner_reservation={
    state:'reserved',gen:1,mode:'continue',reserved_at:1,
    owner_pid:process.pid,owner_start_ticks:procStartTicks(process.pid),owner_token:token,
  };
  meta.pending_prompt='Continue the test work.';
  writeMeta(id,meta,options);
  const prev={};
  for(const [key,value] of Object.entries(env)){prev[key]=process.env[key];process.env[key]=value;}
  try{
    await runManagedRunner(id,'continue',1,options);
  }finally{
    for(const key of Object.keys(env)){
      if(prev[key]===undefined) delete process.env[key];
      else process.env[key]=prev[key];
    }
  }
  const result=readMeta(id,options);
  assert.equal(result.state,'succeeded',JSON.stringify({state:result.state,error:result.error,backend_error:result.backend_error}));
  assert.equal(result.exit_code,0);
  assert.equal(result.model_failover.selected_model,BEAM);
  assert.equal(result.model_failover.cooldowns[0].model,LUNA);
  assert.equal(result.model_failover.cooldowns[0].reason,kind==='quota'?'quota_exhausted':'transient_backend');
  const actual=readFileSync(trace,'utf8').trim().split('\n');
  assert.deepEqual(actual.filter(model => model === LUNA || model === BEAM),kind==='quota'?[LUNA,BEAM]:[LUNA,LUNA,LUNA,BEAM]);
}

test('quota failure switches model within the same agent and same recorded session', {timeout:150000},async t=>exercise(t,'quota'));
test('transient failure gets two retries before model failover', {timeout:150000},async t=>exercise(t,'transient'));
