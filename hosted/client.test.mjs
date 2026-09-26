import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQuote,execute,recover,resumeSavedAuthorization} from './client.mjs';

const ORIGIN='https://researchblocks.example';
const TO='0x3a8De0b03EdAF430338a9CC871F2634882B1b75A';
const ASSET='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FROM='0x1111111111111111111111111111111111111111';
const ID='11111111-1111-4111-8111-111111111111';
const REQUEST={candidates:[{id:'example',label:'Example API',official_domains:['EXAMPLE.COM']}],
  criteria:[{id:'pricing',question:'What is the published pricing unit?'}],max_age_hours:24,max_cost_usd:'0.500000'};
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const requirements=()=>({scheme:'exact',network:'eip155:8453',asset:ASSET,amount:'500000',payTo:TO,maxTimeoutSeconds:300,extra:{name:'USD Coin',version:'2'}});

function fixture(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'researchblocks-client-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'private-receipt.json'),calls=[],signed=[];let order,quoteLost=false,submitted=false;
  const config={...options};
  const fetchImpl=async(url,opts)=>{
    assert.equal(opts.redirect,'error');assert.equal(new URL(url).origin,ORIGIN);assert.equal(new URL(url).search,'');
    assert.equal(url.includes(opts.headers.Authorization.slice(7)),false);
    calls.push({url,method:opts.method,body:opts.body,headers:opts.headers});
    if(url===ORIGIN+'/v1/quote'){
      assert.equal(opts.method,'POST');
      const request=JSON.parse(opts.body).request;
      if(!order)order={id:ID,state:'quoted',request_hash:createHash('sha256').update(stable(request)).digest('hex'),amount_units:'500000',
        network:'eip155:8453',pay_to:TO,quote_expires_at:Date.now()+(config.expiresIn??600000),transaction:null,result:null,error_code:null};
      if(config.loseQuote&&!quoteLost){quoteLost=true;throw new Error('Untrusted provider text must not escape');}
      return Response.json({...order,payment:requirements()},{status:201});
    }
    assert.ok(order);
    if(url===ORIGIN+'/v1/orders/'+ID){assert.equal(opts.method,'GET');return Response.json(order,{status:order.state==='working'?202:200});}
    assert.equal(url,ORIGIN+'/v1/orders/'+ID+'/execute');assert.equal(opts.method,'POST');assert.equal(opts.body,'{}');
    if(!opts.headers['PAYMENT-SIGNATURE']){
      const challenge={x402Version:2,resource:{url:config.resource??url,description:'Comparison',mimeType:'application/json'},
        accepts:[{...requirements(),...config.paymentPatch}]};
      return Response.json(challenge,{status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(challenge)).toString('base64')}});
    }
    signed.push(JSON.parse(Buffer.from(opts.headers['PAYMENT-SIGNATURE'],'base64').toString('utf8')));
    if(submitted){
      assert.equal(config.allowResume,true,'ordinary execution must never repeat a signed submission');
      assert.equal(order.state,'result_ready','only an explicitly resumable order can receive the original authorization again');
      assert.deepEqual(signed[1],signed[0],'resume must use the original signature, nonce and payment terms');
      order.state='settling';
      if(config.loseResume)throw new Error('lost original-authorization recovery acknowledgment');
      return Response.json(order,{status:202});
    }
    submitted=true;order.state='working';
    if(config.loseSubmit)throw new Error('Untrusted body including secrets must not escape');
    return Response.json(order,{status:202});
  };
  let signatures=0,typed;
  const signer={address:FROM,async signTypedData(value){signatures++;typed=value;return '0x'+'ab'.repeat(65);}};
  return {path,dir,config,fetchImpl,calls,signed,signer,get signatures(){return signatures;},get typed(){return typed;},
    setState(state){order.state=state;if(state==='paid')order.transaction='0x'+'12'.repeat(32);},quote:()=>createQuote(path,{origin:ORIGIN,request:REQUEST,fetchImpl})};
}

test('lost quote acknowledgment is recovered with the same durable token and exact normalized body',async t=>{
  const f=fixture(t,{loseQuote:true});
  await assert.rejects(f.quote(),{code:'request_outcome_unknown'});
  const initial=readFileSync(f.path,'utf8');assert.equal(statSync(f.path).mode&0o777,0o600);
  assert.equal((await recover(f.path,{fetchImpl:f.fetchImpl})).state,'quote_acknowledgment_unknown');
  assert.equal(f.calls.length,1,'GET recovery must not create another quote');
  const result=await f.quote();assert.equal(result.state,'quoted');assert.equal(f.calls.length,2);
  assert.equal(f.calls[0].headers.Authorization,f.calls[1].headers.Authorization);assert.equal(f.calls[0].body,f.calls[1].body);
  assert.equal(readFileSync(f.path,'utf8'),initial);assert.equal(Object.hasOwn(result,'token'),false);
  assert.equal(JSON.parse(f.calls[0].body).request.candidates[0].official_domains[0],'example.com');
  assert.equal(JSON.parse(f.calls[0].body).request.max_cost_usd,'0.5');
});

test('receipt origin, request and initial spending ceiling cannot be replaced',async t=>{
  const f=fixture(t);await f.quote();const initial=readFileSync(f.path,'utf8'),count=f.calls.length;
  for(const change of [{origin:'https://other.example'},{request:{...REQUEST,max_age_hours:12}},{maxAmountUnits:600000}]){
    await assert.rejects(createQuote(f.path,{origin:ORIGIN,request:REQUEST,fetchImpl:f.fetchImpl,...change}),{code:'receipt_parameters_changed'});
  }
  assert.equal(f.calls.length,count);assert.equal(readFileSync(f.path,'utf8'),initial);
});

test('repeated execute signs and submits only once; retries and recovery use GET',async t=>{
  const f=fixture(t);await f.quote();
  const first=await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});assert.equal(first.state,'working');
  const n=f.calls.length;
  await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});await execute(f.path,{fetchImpl:f.fetchImpl});await recover(f.path,{fetchImpl:f.fetchImpl});
  assert.equal(f.signatures,1);assert.equal(f.signed.length,1);assert.ok(f.calls.slice(n).every(call=>call.method==='GET'));
  assert.equal(f.typed.domain.chainId,8453);assert.equal(f.typed.domain.verifyingContract,ASSET);
  assert.equal(f.typed.message.to,TO);assert.equal(f.typed.message.value,500000n);
  const auth=f.signed[0].payload.authorization,claim=JSON.parse(readFileSync(f.path+'.payment-claim.json','utf8'));
  assert.equal(auth.nonce,claim.authorization.nonce);assert.match(auth.nonce,/^0x[a-f0-9]{64}$/);
  assert.equal(Number(auth.validBefore)-Number(auth.validAfter),241);
  assert.equal(f.signed[0].payload.signature,'0x'+'ab'.repeat(65));
  for(const file of readdirSync(f.dir))assert.equal(statSync(join(f.dir,file)).mode&0o777,0o600);
});

test('concurrent execute calls have a single durable signing winner',async t=>{
  const f=fixture(t);await f.quote();
  await Promise.all([execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl}),execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl})]);
  assert.equal(f.signatures,1);assert.equal(f.signed.length,1);
});

for(const [name,patch] of Object.entries({recipient:{payTo:FROM},price:{amount:'500001'},network:{network:'eip155:1'},asset:{asset:FROM},timeout:{maxTimeoutSeconds:900}})){
  test('changed '+name+' in the payment challenge is blocked before signing',async t=>{
    const f=fixture(t,{paymentPatch:patch});await f.quote();
    await assert.rejects(execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl}),{code:'payment_requirements_mismatch'});
    assert.equal(f.signatures,0);assert.equal(f.signed.length,0);assert.equal(readdirSync(f.dir).some(name=>name.includes('claim')),false);
  });
}

test('a substituted resource URL never receives a token or signature',async t=>{
  const f=fixture(t,{resource:'https://other.example/v1/orders/'+ID+'/execute'});await f.quote();
  await assert.rejects(execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl}),{code:'payment_resource_mismatch'});
  assert.equal(f.signatures,0);assert.equal(f.signed.length,0);
});

test('ambiguous signed submission stops and subsequent execute only reads the original order',async t=>{
  const f=fixture(t,{loseSubmit:true});await f.quote();
  await assert.rejects(execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl}),{code:'request_outcome_unknown'});
  const n=f.calls.length;
  const result=await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});assert.equal(result.state,'working');assert.equal(result.recovery_only,true);
  assert.equal(f.signatures,1);assert.equal(f.signed.length,1);assert.ok(f.calls.slice(n).every(call=>call.method==='GET'));
});

test('signing failure or crash claim survives restart and cannot trigger another signature',async t=>{
  const f=fixture(t);await f.quote();let attempts=0;
  const signer={address:FROM,async signTypedData(){attempts++;assert.ok(statSync(f.path+'.payment-claim.json').isFile());throw new Error('simulated interruption');}};
  await assert.rejects(execute(f.path,{signer,fetchImpl:f.fetchImpl}),{code:'signing_outcome_unknown_recover_only'});
  const n=f.calls.length;
  const result=await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});assert.equal(result.state,'quoted');assert.equal(result.recovery_only,true);
  assert.equal(attempts,1);assert.equal(f.signatures,0);assert.equal(f.signed.length,0);assert.ok(f.calls.slice(n).every(call=>call.method==='GET'));
});

test('an old quote without the full server lifetime margin is refused before signing',async t=>{
  const f=fixture(t,{expiresIn:119000});await f.quote();
  await assert.rejects(execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl}),{code:'quote_too_close_to_expiry'});
  assert.equal(f.signatures,0);assert.equal(f.signed.length,0);
});

test('spending ceiling and HTTPS origin are enforced before networking',async t=>{
  const f=fixture(t);
  await assert.rejects(createQuote(f.path,{origin:ORIGIN,request:REQUEST,maxAmountUnits:499999,fetchImpl:f.fetchImpl}),{code:'budget_below_price_or_out_of_range'});
  await assert.rejects(createQuote(f.path,{origin:'http://researchblocks.example',request:REQUEST,fetchImpl:f.fetchImpl}),{code:'invalid_origin'});
  assert.equal(f.calls.length,0);assert.equal(readdirSync(f.dir).length,0);
});

test('private receipt symlinks are refused without overwriting their target',async t=>{
  const f=fixture(t),target=join(f.dir,'target');writeFileSync(target,'keep',{mode:0o600});symlinkSync(target,f.path);
  await assert.rejects(f.quote(),{code:'receipt_unreadable'});assert.equal(readFileSync(target,'utf8'),'keep');assert.equal(f.calls.length,0);
});

test('a saved deliverable resumes once using the exact original authorization without a signer',async t=>{
  const f=fixture(t,{allowResume:true});await f.quote();await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});
  f.setState('result_ready');
  const ordinary=await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});assert.equal(ordinary.state,'result_ready');assert.equal(f.signed.length,1);
  const result=await resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl});assert.equal(result.state,'settling');assert.equal(result.client_state,'saved_authorization_resume_claimed');
  assert.equal(f.signatures,1);assert.equal(f.signed.length,2);assert.deepEqual(f.signed[1],f.signed[0]);
  assert.equal(statSync(f.path+'.resume-claim.json').mode&0o777,0o600);
  const n=f.calls.length;await resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl});
  assert.ok(f.calls.slice(n).every(call=>call.method==='GET'));assert.equal(f.signed.length,2);
});

test('working, settling and paid orders never resend a saved authorization',async t=>{
  const f=fixture(t);await f.quote();await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});const n=f.calls.length;
  await resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl});f.setState('settling');await resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl});
  f.setState('paid');await resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl});
  assert.ok(f.calls.slice(n).every(call=>call.method==='GET'));assert.equal(f.signatures,1);assert.equal(f.signed.length,1);
});

test('an uncertain explicit resume cannot be retried even if the server still reports result_ready',async t=>{
  const f=fixture(t,{allowResume:true,loseResume:true});await f.quote();await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});f.setState('result_ready');
  await assert.rejects(resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl}),{code:'request_outcome_unknown'});
  f.setState('result_ready');const n=f.calls.length;await resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl});
  assert.ok(f.calls.slice(n).every(call=>call.method==='GET'));assert.equal(f.signatures,1);assert.equal(f.signed.length,2);
});

test('an unavailable private status cannot trigger an authorization resume',async t=>{
  const f=fixture(t);await f.quote();await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});
  await assert.rejects(resumeSavedAuthorization(f.path,{fetchImpl:async()=>{throw new Error('offline');}}),{code:'request_outcome_unknown'});
  assert.equal(f.signatures,1);assert.equal(f.signed.length,1);
});

test('a saved authorization close to expiry cannot be renewed or resubmitted',async t=>{
  const f=fixture(t,{allowResume:true});await f.quote();await execute(f.path,{signer:f.signer,fetchImpl:f.fetchImpl});f.setState('result_ready');
  const now=Date.now();t.mock.method(Date,'now',()=>now+220000);
  await assert.rejects(resumeSavedAuthorization(f.path,{fetchImpl:f.fetchImpl}),{code:'saved_authorization_expired_recover_only'});
  assert.equal(f.signatures,1);assert.equal(f.signed.length,1);
});
