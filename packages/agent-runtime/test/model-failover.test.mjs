import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { idleMeta, validateAgentMetadata } from '../dist/packages/agent-runtime/src/metadata.js';
import {
  MODEL_COOLDOWN_SECONDS, TRANSIENT_MODEL_RETRIES, agentModelFailover,
  coolDownAgentModel, eligibleAgentModel, excludeAgentProvider,
  modelCooldownSeconds, PERMANENT_EXCLUSION_UNTIL, TRANSIENT_UNRELIABLE_SECONDS,
  RATE_LIMIT_BACKOFF_SECONDS, recordAgentModel,
} from '../dist/packages/agent-runtime/src/model-failover.js';
import {
  classifyBackendFailure, quotaResetDelaySeconds, buildAgentCommand,
} from '../dist/packages/agent-runtime/src/backend.js';

const prefs = ['openai/gpt-6-luna', 'opencode-go/beam-free', 'opencode-go/longcat-2.5-preview-free']
  .map(model => ({model, comment: 'mock'}));
const NOW = 1792600000;

function testMeta() {
  const meta = idleMeta('model-test-agent', '/tmp', 'test');
  validateAgentMetadata(meta);
  return meta;
}

test('quota reset diagnostic wins over the fixed six-hour cooldown when reliable', () => {
  const dir=mkdtempSync(join(tmpdir(),'antonina-provider-quota-'));
  try {
    const path=join(dir,'log');
    const resetAt=NOW+5400;
    const payload=JSON.stringify({responseBody:JSON.stringify({
      error:{type:'usage_limit_reached',message:'The usage limit has been reached',resets_at:resetAt}
    })});
    writeFileSync(path,payload);
    assert.equal(quotaResetDelaySeconds(path,0,NOW),5520);
    // Do not attribute a prior invocation's provider reset to a new failure.
    writeFileSync(path,payload+'\n'+'Unrecognized backend failure');
    assert.equal(quotaResetDelaySeconds(path,payload.length+1,NOW),null);
    writeFileSync(path,payload.replace('usage_limit_reached','random_error'));
    assert.equal(quotaResetDelaySeconds(path,0,NOW),null);
    writeFileSync(path,payload.replace(String(resetAt),String(NOW-1)));
    assert.equal(quotaResetDelaySeconds(path,0,NOW),null);
    writeFileSync(path,payload.replace(String(resetAt),String(NOW+7*3600)));
    assert.equal(quotaResetDelaySeconds(path,0,NOW),null);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

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
  assert.equal(agentModelFailover(a).cooldowns[0].until,NOW+100+RATE_LIMIT_BACKOFF_SECONDS);
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
      [apiError('Unauthorized',401), 'backend_authentication_failed'],
      [apiError('Payment Required',402), 'backend_billing_required'],
      [apiError('model_not_found',404), 'model_unavailable'],
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

test('healthy preference outranks all transiently unreliable choices', () => {
  const meta=testMeta();
  coolDownAgentModel(meta,prefs[0].model,'transient_backend',NOW);
  coolDownAgentModel(meta,prefs[1].model,'transient_backend',NOW);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1),prefs[2].model);
  assert.equal(agentModelFailover(meta).cooldowns[0].until,NOW+TRANSIENT_UNRELIABLE_SECONDS);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+TRANSIENT_UNRELIABLE_SECONDS),prefs[0].model);
});

test('all transiently unreliable models are randomly selected rather than excluded', () => {
  const meta=testMeta();
  for(const pref of prefs)coolDownAgentModel(meta,pref.model,'transient_backend',NOW);
  validateAgentMetadata(meta);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1,()=>0),prefs[0].model);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1,()=>1),prefs[1].model);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1,()=>2),prefs[2].model);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1,()=>1,new Set([prefs[0].model])),prefs[2].model);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1,()=>0,new Set(prefs.map(p=>p.model))),null);
  assert.throws(()=>eligibleAgentModel(meta,prefs,NOW+1,()=>100),/lottery index/);
});

test('quota and rate-limit candidates stay outside the transient random pool', () => {
  const meta=testMeta();
  coolDownAgentModel(meta,prefs[0].model,'quota_exhausted',NOW);
  coolDownAgentModel(meta,prefs[1].model,'rate_limited',NOW);
  coolDownAgentModel(meta,prefs[2].model,'transient_backend',NOW);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1,()=>0),prefs[2].model);
  coolDownAgentModel(meta,prefs[2].model,'model_unavailable',NOW);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+1,()=>0),null);
  assert.equal(agentModelFailover(meta).cooldowns[2].until,PERMANENT_EXCLUSION_UNTIL);
  assert.equal(eligibleAgentModel(meta,prefs,NOW+RATE_LIMIT_BACKOFF_SECONDS+1),prefs[1].model);
});

test('hard model exclusion persists until changed, while adding a new model works', () => {
  const meta=testMeta();
  coolDownAgentModel(meta,prefs[0].model,'model_unavailable',NOW);
  assert.equal(eligibleAgentModel(meta,[prefs[0]],NOW+100000000),null);
  assert.equal(eligibleAgentModel(meta,[{model:'openai/replacement',comment:'new'}],NOW+1),'openai/replacement');
  assert.equal(modelCooldownSeconds('provider_authentication_failed'),PERMANENT_EXCLUSION_UNTIL);
});

test('provider authentication and billing failures exclude its models, not other providers', () => {
  const meta=testMeta();
  const all=[{model:'openai/a',comment:''},{model:'openai/b',comment:''},{model:'opencode-go/c',comment:''}];
  excludeAgentProvider(meta,'openai/a',all,'provider_authentication_failed',NOW);
  validateAgentMetadata(meta);
  assert.equal(eligibleAgentModel(meta,all,NOW+1),all[2].model);
  assert.equal(eligibleAgentModel(meta,all.slice(0,2),NOW+1),null);
  assert.deepEqual(agentModelFailover(meta).cooldowns.map(x=>x.reason),
    ['provider_authentication_failed','provider_authentication_failed']);
  excludeAgentProvider(meta,'opencode-go/c',all,'provider_billing_required',NOW);
  assert.equal(eligibleAgentModel(meta,all,NOW+1),null);
});
