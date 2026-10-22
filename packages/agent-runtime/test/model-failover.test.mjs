import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { idleMeta, validateAgentMetadata } from '../dist/packages/agent-runtime/src/metadata.js';
import {
  MODEL_COOLDOWN_SECONDS, TRANSIENT_MODEL_RETRIES, agentModelFailover,
  coolDownAgentModel, eligibleAgentModel, recordAgentModel,
} from '../dist/packages/agent-runtime/src/model-failover.js';
import {
  classifyBackendFailure, buildAgentCommand,
} from '../dist/packages/agent-runtime/src/backend.js';

const prefs = ['openai/gpt-6-luna', 'opencode-go/beam-free', 'opencode-go/longcat-2.5-preview-free']
  .map(model => ({model, comment: 'mock'}));
const NOW = 1792600000;

function testMeta() {
  const meta = idleMeta('model-test-agent', '/tmp', 'test');
  validateAgentMetadata(meta);
  return meta;
}

test('per-agent exhaustion, cooldown persistence and six-hour recovery', () => {
  const a = testMeta();
  const b = testMeta();
  assert.equal(eligibleAgentModel(a,prefs,NOW),prefs[0].model);
  recordAgentModel(a,prefs[0].model);
  coolDownAgentModel(a,prefs[0].model,'quota_exhausted',NOW);
  validateAgentMetadata(a);
  const persisted = JSON.parse(JSON.stringify(a));
  validateAgentMetadata(persisted);
  assert.equal(agentModelFailover(persisted).selected_model,prefs[0].model);
  assert.equal(eligibleAgentModel(persisted,prefs,NOW + 60),prefs[1].model);
  assert.equal(eligibleAgentModel(b,prefs,NOW + 60),prefs[0].model);
  assert.equal(eligibleAgentModel(persisted,prefs,NOW+MODEL_COOLDOWN_SECONDS-1),prefs[1].model);
  assert.equal(eligibleAgentModel(persisted,prefs,NOW+MODEL_COOLDOWN_SECONDS),prefs[0].model);
  coolDownAgentModel(persisted,prefs[1].model,'transient_backend',NOW + 100);
  assert.equal(eligibleAgentModel(persisted,prefs,NOW+200),prefs[2].model);
  assert.equal(TRANSIENT_MODEL_RETRIES,2);
});

test('cooldowns track opaque model IDs across preference reordering', () => {
  const a=testMeta();
  coolDownAgentModel(a,prefs[0].model,'quota_exhausted',NOW);
  assert.equal(eligibleAgentModel(a,[prefs[2],prefs[0],prefs[1]],NOW+10),prefs[2].model);
  assert.equal(eligibleAgentModel(a,[prefs[0]],NOW+10),null);
  coolDownAgentModel(a,prefs[0].model,'rate_limited',NOW+100);
  assert.equal(agentModelFailover(a).cooldowns.length,1);
  assert.equal(agentModelFailover(a).cooldowns[0].until,NOW+100+MODEL_COOLDOWN_SECONDS);
});

test('malformed failover records are rejected by the canonical metadata schema', () => {
  const invalid=[
    {selected_model:'example/test',cooldowns:[{model:'example/test',reason:'quota_exhausted',until:-1}]},
    {selected_model:'bad',cooldowns:[]},
    {selected_model:null,cooldowns:[{model:'example/test',reason:'bogus',until:4}]},
    {selected_model:null,cooldowns:[{model:'example/test',reason:'rate_limited',until:3},{model:'example/test',reason:'rate_limited',until:4}]},
    {selected_model:null,cooldowns:[],surprise:true},
  ];
  for(const entry of invalid){
    const a=testMeta();a.model_failover=entry;
    assert.throws(()=>validateAgentMetadata(a),/model_failover/);
  }
});

test('specific backend errors distinguish exhausted quota, throttling, model absence, auth and generic failures', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-failover-'));
  try{
    const path=join(dir,'log');
    const apiError = (message, statusCode) => JSON.stringify({
      type:'error',sessionID:'ses_realcase',error:{
        name:'APIError',data:{message,statusCode,isRetryable:true},
      },
    });
    const cases=[
      ['Error: insufficient_quota', 'model_quota_exhausted'],
      ['Error: The usage limit has been reached', 'model_quota_exhausted'],
      [apiError('The usage limit has been reached',429), 'model_quota_exhausted'],
      [apiError('Temporary provider throttle',429), 'upstream_rate_limited'],
      [apiError('Gateway error',503), 'transient_backend_server_error'],
      [apiError('Invalid argument',400), 'unrecognized_backend_failure'],
      [JSON.stringify({type:'text',part:{text:'statusCode 429'},error:{
        name:'APIError',data:{statusCode:429},
      }}), 'unrecognized_backend_failure'],
      ['Error: You have reached your usage limit', 'model_quota_exhausted'],
      ['Error: model_not_found', 'model_unavailable'],
      ['Error: invalid_api_key', 'backend_authentication_failed'],
      ['Error: Payment Required', 'backend_billing_required'],
      ['Error: Rate limit exceeded. Please try again later.', 'upstream_rate_limited'],
      ['Error: Endpoint is unavailable', 'upstream_endpoint_unavailable'],
      ['Error: Unexpected server error', 'transient_backend_server_error'],
      ['Error: failed to compile project', 'unrecognized_backend_failure'],
    ];
    for(const [line, classification] of cases){
      writeFileSync(path,line+'\n');
      const result=classifyBackendFailure(path,0,1,true);
      assert.equal(result?.classification,classification,line);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
