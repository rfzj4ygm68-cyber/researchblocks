import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {createApplication,PRICE_UNITS} from './server.mjs';
import {openStore} from './store.mjs';
import {MERCHANT,authorizationTypes,paymentRequirements} from './payment.mjs';
import {createQuote,execute,recover} from './client.mjs';

const account=privateKeyToAccount('0x'+'19'.repeat(32)); // Unfunded synthetic signer, never a live wallet.
const input={candidates:[{id:'alpha',label:'Alpha',official_domains:['example.com']}],criteria:[{id:'price',question:'Published price?'}],max_age_hours:24,max_cost_usd:'0.5'};
const token=()=>randomBytes(32).toString('hex');
function setup(t,overrides={}){
  const dir=mkdtempSync(join(tmpdir(),'rb-server-'));const store=openStore(join(dir,'orders.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const now=Date.now();let time=now;
  const calls={verify:0,head:0,work:0,settle:0,reconcile:0};
  const provider={verify:async p=>{calls.verify++;return {isValid:true,payer:p.payload.authorization.from};},head:async()=>{calls.head++;return 100;},settle:async p=>{calls.settle++;return {success:true,network:MERCHANT.network,payer:p.payload.authorization.from,transaction:'0x'+'a1'.repeat(32)};},reconcile:async row=>{calls.reconcile++;return {success:true,network:MERCHANT.network,payer:row.payer,transaction:'0x'+'a1'.repeat(32),amount:String(row.amount)};},...overrides.provider};
  const worker={configured:true,run:async()=>{calls.work++;return {block:{synthetic_fixture:true},usage:{synthetic_fixture:true},estimated_cost_usd:'0'};},...overrides.worker};
  const config={enabled:true,liveVerified:true,operatorToken:'operator-fixture-only-'+token(),publicOrigin:'https://research.example',...overrides.config};
  const app=createApplication({store,provider,worker,config,providerReady:true,clock:()=>time});
  const request=(path,{method='GET',receipt,body,signature}={})=>app.handle(new Request('https://research.example'+path,{method,headers:{...(receipt?{Authorization:'Bearer '+receipt}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...(signature?{'payment-signature':signature}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}));
  const quote=async(receipt=token(),requestInput=input)=>{const r=await request('/v1/quote',{method:'POST',receipt,body:{request:requestInput}});return {receipt,response:r,quote:await r.json()};};
  const sign=async(until=240)=>{
    const authorization={from:account.address,to:MERCHANT.payTo,value:String(PRICE_UNITS),validAfter:String(Math.floor(time/1000)-1),validBefore:String(Math.floor(time/1000)+until),nonce:'0x'+token()};
    const signature=await account.signTypedData({domain:MERCHANT.domain,types:authorizationTypes,primaryType:'TransferWithAuthorization',message:{...authorization,value:BigInt(authorization.value),validAfter:BigInt(authorization.validAfter),validBefore:BigInt(authorization.validBefore)}});
    return Buffer.from(JSON.stringify({x402Version:2,accepted:paymentRequirements(PRICE_UNITS),payload:{authorization,signature}})).toString('base64');
  };
  const execute=({quote:q,receipt},signature)=>request('/v1/orders/'+q.id+'/execute',{method:'POST',receipt,body:{},signature});
  return {store,calls,app,config,request,quote,sign,execute,advance:ms=>{time+=ms;}};
}

test('public discovery and unsigned payment challenge spend nothing',async t=>{
  const s=setup(t);assert.equal((await s.request('/health')).status,200);
  const q=await s.quote();assert.equal(q.response.status,201);
  assert.equal((await s.execute(q)).status,402);await s.app.drain();
  assert.deepEqual(s.calls,{verify:0,head:0,work:0,settle:0,reconcile:0});
  assert.equal(s.store.summary().confirmed_paid_orders,0);
});
test('quote retries bind private token to original request and do not duplicate orders',async t=>{
  const s=setup(t),receipt=token();const a=await s.quote(receipt),b=await s.quote(receipt);
  assert.equal(a.quote.id,b.quote.id);
  assert.equal((await s.quote(receipt,{...input,max_age_hours:48})).response.status,409);
  assert.equal((await s.request('/v1/orders/'+a.quote.id,{receipt:token()})).status,404);
});
test('result is saved before settlement and released only after confirmation',async t=>{
  const s=setup(t,{provider:{settle:async p=>{s.calls.settle++;assert.equal(s.store.summary().counts.settling,1);assert.deepEqual(s.store.raw(q.quote.id).result_json,{synthetic_fixture:true});return {success:true,payer:p.payload.authorization.from,network:MERCHANT.network,transaction:'0x'+'a1'.repeat(32)};}}});
  const q=await s.quote();assert.equal((await s.execute(q,await s.sign())).status,202);await s.app.drain();
  const response=await s.request('/v1/orders/'+q.quote.id,{receipt:q.receipt});const result=await response.json();
  assert.equal(result.state,'paid');assert.deepEqual(result.result,{synthetic_fixture:true});assert.equal(s.calls.work,1);assert.equal(s.calls.settle,1);
});
test('concurrent authorized retries dispatch one worker and one settlement',async t=>{
  const s=setup(t),q=await s.quote(),signature=await s.sign();
  await Promise.all([s.execute(q,signature),s.execute(q,signature)]);await s.app.drain();
  assert.equal(s.calls.work,1);assert.equal(s.calls.settle,1);
  await s.execute(q,signature);await s.app.drain();assert.equal(s.calls.settle,1);
});
test('invalid signatures and failed research never reach settlement',async t=>{
  const s=setup(t,{worker:{run:async()=>{s.calls.work++;throw Error('secret source text');}}});
  const q=await s.quote();assert.equal((await s.execute(q,'not-a-signature')).status,400);assert.equal(s.calls.work,0);
  await s.execute(q,await s.sign());await s.app.drain();
  assert.equal(s.store.raw(q.quote.id).state,'research_failed');assert.equal(s.calls.settle,0);
  assert.equal(s.store.summary().supplier_jobs_started,1);
});
test('lost settlement acknowledgement stays pending and recovers without another charge',async t=>{
  let confirm=false;
  const s=setup(t,{provider:{settle:async()=>{s.calls.settle++;throw Error('lost acknowledgement');},reconcile:async row=>{s.calls.reconcile++;return confirm?{success:true,network:MERCHANT.network,payer:row.payer,amount:String(row.amount),transaction:'0x'+'c2'.repeat(32)}:null;}}});
  const q=await s.quote(),signature=await s.sign();await s.execute(q,signature);await s.app.drain();
  assert.equal(s.store.raw(q.quote.id).state,'settling');
  let response=await s.execute(q,signature);assert.equal(response.status,202);assert.equal((await response.json()).result,null);
  confirm=true;response=await s.request('/v1/orders/'+q.quote.id,{receipt:q.receipt});assert.equal((await response.json()).state,'paid');assert.equal(s.calls.settle,1);
});
test('lost lifetime during provider checks stops before supplier work',async t=>{
  const s=setup(t,{provider:{head:async()=>{s.calls.head++;s.advance(45000);return 100;}}});
  const q=await s.quote();const response=await s.execute(q,await s.sign(150));await s.app.drain();
  assert.equal(response.status,400);assert.equal((await response.json()).error,'payment_lifetime_too_short');assert.equal(s.calls.work,0);assert.equal(s.calls.settle,0);
});
test('startup interruption is terminal and never resubmits research',async t=>{
  const s=setup(t),q=await s.quote();s.store.claimWork(q.quote.id,{payer:account.address,nonce:'0x'+token(),valid_before:String(Math.floor(Date.now()/1000)+250),from_block:100});
  s.store.recoverInterrupted();const response=await s.execute(q,await s.sign());await s.app.drain();
  assert.equal(response.status,409);assert.equal(s.store.raw(q.quote.id).state,'interrupted');assert.equal(s.calls.work,0);assert.equal(s.calls.settle,0);
});
test('missing launch gates expose unavailable checkout and refuse quotes',async t=>{
  const s=setup(t,{config:{liveVerified:false}});
  assert.equal((await (await s.request('/v1/status')).json()).payments_enabled,false);
  assert.equal((await s.quote()).response.status,503);assert.equal(s.calls.work,0);
});
test('operator totals require an independent secret and expose no order data',async t=>{
  const s=setup(t);assert.equal((await s.request('/operator/summary')).status,404);
  const response=await s.app.handle(new Request('https://research.example/operator/summary',{headers:{Authorization:'Bearer '+s.config.operatorToken}}));
  assert.equal(response.status,200);const raw=await response.text();assert.ok(!raw.includes('token_hash'));assert.ok(!raw.includes('request_json'));
});

test('actual agent client interoperates with actual HTTP application and private ledger',async t=>{
  const s=setup(t),dir=mkdtempSync(join(tmpdir(),'rb-integrated-client-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receipt=join(dir,'job.receipt.json');
  const transport=(url,options)=>s.app.handle(new Request(url,options));
  const quote=await createQuote(receipt,{origin:'https://research.example',request:input,fetchImpl:transport});
  assert.equal(quote.state,'quoted');
  const accepted=await execute(receipt,{signer:account,fetchImpl:transport});
  assert.ok(['working','settling','paid'].includes(accepted.state));
  await s.app.drain();
  const result=await recover(receipt,{fetchImpl:transport});assert.equal(result.state,'paid');
  assert.deepEqual(result.result,{synthetic_fixture:true});assert.equal(s.calls.work,1);assert.equal(s.calls.settle,1);
});
