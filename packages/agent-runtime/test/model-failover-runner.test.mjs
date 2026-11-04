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
    + 'if [ "$1" = "session" ]; then echo "[]"; exit 0; fi\n'
    + 'model=""\nsession=""\nformat=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "--model" ]; then model="$a"; fi; if [ "$prev" = "--session" ]; then session="$a"; fi; if [ "$prev" = "--format" ]; then format="$a"; fi; prev="$a"; done\n'
    + 'model="${model%%#*}"\n'
    + 'printf "%s\\n" "$model" >> "$ANTONINA_TEST_TRACE"\n'
    + 'sleep 0.12\n'
    + (kind==='all-transient'
        ? 'if [ "$(wc -l < "$ANTONINA_TEST_TRACE")" -le 6 ]; then echo "Error: Unexpected server error" >&2; exit 1; fi\n'
        : kind==='unknown-json'
          ? 'if [ "$model" = "example.test/luna" ]; then echo \'{"type":"error","error":{"name":"UnknownError","data":{"message":"Type validation failed: choices[0].delta.reasoning expected string, received object"}}}\'; exit 1; fi\n'
        : kind==='fresh-quota'
        ? 'if [ "$model" = "example.test/luna" ]; then [ "$format" = "json" ] || exit 43; printf \'{"type":"step_start","sessionID":"ses_checkpoint_demo","part":{"type":"step-start"}}\\n\'; sleep 0.3; printf \'{"type":"error","sessionID":"ses_checkpoint_demo","error":{"data":{"message":"The usage limit has been reached"}}}\\n\'; exit 1; fi\n'
        : kind==='quota'
          ? 'if [ "$model" = "example.test/luna" ]; then echo "Error: The usage limit has been reached" >&2; exit 1; fi\n'
          : kind==='throttle-json'
            ? 'if [ "$model" = "example.test/luna" ]; then printf \'{"type":"error","error":{"name":"APIError","data":{"message":"Temporary throttle","statusCode":429}}}\\n\'; exit 1; fi\n'
          : kind==='transient-json'
            ? 'if [ "$model" = "example.test/luna" ]; then printf \'{"type":"error","error":{"name":"APIError","data":{"message":"Gateway error","statusCode":503}}}\\n\'; exit 1; fi\n'
          : 'if [ "$model" = "example.test/luna" ]; then echo "Error: Endpoint is unavailable" >&2; exit 1; fi\n')
    + (kind==='fresh-quota' ? '[ "$session" = "ses_checkpoint_demo" ] || exit 44\n' : '')
    + 'echo "SUCCESS"; exit 0\n';
  writeFileSync(bin,script,{mode:0o755});
  const probe=spawnSync(bin,['models'],{encoding:'utf8',timeout:5000});
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
  const id='model-'+kind;
  const cwd=join(root,'work');
  mkdirSync(cwd);
  assert.equal(createAgentDirectory(id,options),true);
  const meta=idleMeta(id,cwd,null);
  meta.native_session_id=kind==='fresh-quota'?null:'ses_fixed';
  meta.runner_gen=1;
  const mode=kind==='fresh-quota'?'new':'continue';
  meta.runner_reservation={
    state:'reserved',gen:1,mode,reserved_at:1,
    owner_pid:process.pid,owner_start_ticks:procStartTicks(process.pid),owner_token:token,
  };
  meta.pending_prompt='Continue the test work.';
  writeMeta(id,meta,options);
  const prev={};
  for(const [key,value] of Object.entries(env)){prev[key]=process.env[key];process.env[key]=value;}
  try{
    await runManagedRunner(id,mode,1,options);
  }finally{
    for(const key of Object.keys(env)){
      if(prev[key]===undefined) delete process.env[key];
      else process.env[key]=prev[key];
    }
  }
  const result=readMeta(id,options);
  if (kind === 'all-transient') {
    assert.deepEqual([...result.observed_models].sort(), [BEAM, LUNA].sort(), 'both genuinely launched; last model chosen randomly');
  } else {
    assert.deepEqual(result.observed_models, [LUNA, BEAM], 'only truly launched models, newest last');
  }
  if (kind==='all-transient') {
    // The old implementation stranded an agent after all configured models
    // returned temporary failures. Exhaustion of a SOFT pool is recoverable.
    assert.equal(result.state, 'clearexit');
    const attempts=readFileSync(trace,'utf8').trim().split('\n');
    assert.equal(attempts.length, 7);
    assert.ok(attempts.includes(LUNA) && attempts.includes(BEAM));
    assert.ok(result.model_failover.cooldowns.every(x=>x.reason==='transient_backend'));
    return;
  }
  assert.equal(result.state,'clearexit',JSON.stringify({state:result.state,error:result.error,backend_error:result.backend_error}));
  assert.equal(result.exit_code,0);
  assert.equal(result.model_failover.selected_model,BEAM);
  if (kind==='fresh-quota') assert.equal(result.native_session_id,'ses_checkpoint_demo');
  assert.equal(result.model_failover.cooldowns[0].model,LUNA);
  assert.equal(result.model_failover.cooldowns[0].reason,(kind.startsWith('transient')||kind==='unknown-json')?'transient_backend':kind==='throttle-json'?'rate_limited':'quota_exhausted');
  const actual=readFileSync(trace,'utf8').trim().split('\n');
  assert.deepEqual(actual.filter(model => model === LUNA || model === BEAM),[LUNA,BEAM]);
}

test('quota failure switches model within the same agent and same recorded session', {timeout:150000},async t=>exercise(t,'quota'));
test('transient failure changes models immediately and reconciles previous effects', {timeout:150000},async t=>exercise(t,'transient'));

test('fresh first-invocation quota failure resumes checkpointed JSON session even when session list is empty', {timeout:150000},async t=>exercise(t,'fresh-quota'));

test('structured HTTP 429 throttling advances directly to Beam', {timeout:150000},async t=>exercise(t,'throttle-json'));
test('structured HTTP 503 fails over and recovers without exhausting the agent', {timeout:150000},async t=>exercise(t,'transient-json'));
test('unknown OpenCode reasoning-schema error switches to another model and reconciles', {timeout:150000},async t=>exercise(t,'unknown-json'));

test('all-transient soft model pool recovers across multiple rounds', {timeout:150000},async t=>exercise(t,'all-transient'));

test('fresh agents learn from two independent unknown-backend failures without an external scheduler',
  {timeout:150000}, async t => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const root = mkdtempSync(join(tmpdir(), 'antonina-cross-agent-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'config', 'antonina');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({models: [
    {model:LUNA,comment:'first preference'}, {model:BEAM,comment:'known alternative'},
  ]}));
  const bin = join(root, 'opencode');
  const trace = join(root, 'attempts');
  writeFileSync(bin, [
    '#!/bin/sh',
    'if [ "$1" = session ]; then echo "[]"; exit 0; fi',
    'model=""; prev=""',
    'for arg in "$@"; do if [ "$prev" = "--model" ]; then model="$arg"; fi; prev="$arg"; done',
    'model="${model%%#*}"',
    'printf "%s %s\\n" "$ANTONINA_AGENT_ID" "$model" >> "$ANTONINA_TEST_TRACE"',
    'sleep 0.15',
    'if [ "$model" = "example.test/luna" ]; then',
    '  echo \'{"type":"error","error":{"name":"UnknownError","data":{"message":"Type validation failed: delta.reasoning expected string, received object"}}}\'',
    '  exit 1',
    'fi',
    'echo "RECOVERED"; exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  const token = mintRunnerReservationOwnerToken();
  const env = {
    XDG_CONFIG_HOME:join(root,'config'), XDG_STATE_HOME:join(root,'state'),
    ANTONINA_OPENCODE_BIN:bin, ANTONINA_TEST_TRACE:trace,
    ANTONINA_RUNNER_OWNER_TOKEN:token,
  };
  const options = {env};
  const prev = {};
  for (const [key,value] of Object.entries(env)) { prev[key]=process.env[key]; process.env[key]=value; }
  async function runAgent(id) {
    const cwd = join(root, 'work-' + id);
    mkdirSync(cwd);
    assert.equal(createAgentDirectory(id, options), true);
    const meta = idleMeta(id, cwd, null);
    meta.runner_gen=1;
    meta.runner_reservation={
      state:'reserved', gen:1, mode:'new', reserved_at:1,
      owner_pid:process.pid, owner_start_ticks:procStartTicks(process.pid), owner_token:token,
    };
    meta.pending_prompt='Reconcile unknown backend failure and continue only unfinished work.';
    writeMeta(id,meta,options);
    await runManagedRunner(id,'new',1,options);
    const result=readMeta(id,options);
    assert.equal(result.state,'clearexit', JSON.stringify(result.backend_error));
    return result.observed_models;
  }
  try {
    assert.deepEqual(await runAgent('firstagent'),[LUNA,BEAM]);
    assert.deepEqual(await runAgent('secondagent'),[LUNA,BEAM]);
    assert.deepEqual(await runAgent('thirdagent'),[BEAM],
      'independent evidence should demote incompatible first-choice model');
    assert.deepEqual(readFileSync(trace,'utf8').trim().split('\n'),[
      'firstagent '+LUNA,'firstagent '+BEAM,
      'secondagent '+LUNA,'secondagent '+BEAM,
      'thirdagent '+BEAM,
    ]);
  } finally {
    for(const key of Object.keys(env)){
      if(prev[key]===undefined) delete process.env[key];
      else process.env[key]=prev[key];
    }
  }
});
