import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createHash, timingSafeEqual} from 'node:crypto';
import {openStore} from './store.mjs';
import {MERCHANT, paymentRequirements, parseAndValidatePayment, createProvider} from './payment.mjs';
import {createWorker, validateRequest, workerPolicy} from './worker.mjs';

export const PRICE_UNITS = 500000;
export const VERSION = '0.2.0-alpha.1';
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const hash = s => createHash('sha256').update(s).digest('hex');
const txHash = x => typeof x==='string' && /^0x[0-9a-fA-F]{64}$/.test(x);
class HttpError extends Error { constructor(code,status=400){super(code);this.code=code;this.status=status;} }
const need=(test,code,status)=>{if(!test)throw new HttpError(code,status);};
const exact=(v,keys)=>{need(v && Object.getPrototypeOf(v)===Object.prototype && Object.keys(v).every(k=>keys.includes(k)) && keys.every(k=>Object.hasOwn(v,k)),'invalid_body');};

export function readConfig(env=process.env){
  return {
    enabled:env.RESEARCHBLOCKS_PAYMENTS_ENABLED==='true',
    liveVerified:env.RESEARCHBLOCKS_LIVE_RESEARCH_VERIFIED==='true',
    database:env.RESEARCHBLOCKS_DATABASE || '/data/researchblocks.sqlite',
    apiKeyId:env.RESEARCHBLOCKS_CDP_API_KEY_ID || '',
    apiKeySecret:env.RESEARCHBLOCKS_CDP_API_KEY_SECRET || '',
    researchApiKey:env.OPENAI_API_KEY || '',
    operatorToken:env.RESEARCHBLOCKS_OPERATOR_TOKEN || '',
    publicOrigin:env.RESEARCHBLOCKS_PUBLIC_ORIGIN || '',
    port:Number(env.PORT || 8080),
  };
}

function view(row,now){
  const expired=Boolean(row.result_expired)||(row.result_expires!=null&&now>=row.result_expires);
  return {id:row.id,state:row.state,request_hash:row.request_hash,amount_units:String(row.amount),amount_usdc:(row.amount/1e6).toFixed(6),network:MERCHANT.network,pay_to:MERCHANT.payTo,created_at:row.created,quote_expires_at:row.expires,transaction:row.transaction_hash || null,error_code:row.error_code || null,operator_review_required:row.state==='settling'&&now>(Number(row.valid_before)+300)*1000,result_expired:expired,result:row.state==='paid'&&!expired?row.result_json:null};
}

export function createApplication({store,provider,worker,config={},providerReady=false,clock=Date.now}){
  const active=new Set();
  const rates=new Map();
  const enabled=()=>Boolean(config.enabled && config.liveVerified && providerReady && worker.configured);
  const capacity=()=>{const s=store.summary();return s.supplier_jobs_remaining>0&&s.supplier_budget_remaining_micros>=150000;};
  const status=()=>({product:'ResearchBlocks',version:VERSION,payments_enabled:enabled()&&capacity(),research_provider_configured:Boolean(worker.configured),payment_provider_ready:providerReady,live_research_verified:Boolean(config.liveVerified),accepting_new_jobs:enabled()&&capacity(),network:MERCHANT.network,asset:MERCHANT.asset,pay_to:MERCHANT.payTo,price_usdc:'0.500000',price_units:String(PRICE_UNITS),service:'official-source-comparison',max_candidates:3,max_criteria:5,requires_authorized_eoa:true,charges_after_result_is_saved:true,failed_research_is_not_charged:true,result_recovery_days:7,discovery_is_free:true});
  const reply=(data,code=200,headers={})=>Response.json(data,{status:code,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers}});
  const limiter=(name,max)=>{const minute=Math.floor(clock()/60000);const old=rates.get(name);const n=old?.minute===minute?old.n+1:1;rates.set(name,{minute,n});need(n<=max,'rate_limited',429);};
  const authorize=req=>{const value=req.headers.get('authorization')||'';need(/^Bearer [a-f0-9]{64}$/.test(value),'receipt_token_required',401);return value.slice(7);};
  const body=async(req,limit=14000)=>{
    need(req.headers.get('content-type')?.split(';')[0].trim()==='application/json','json_required',415);
    const reader=req.body?.getReader();if(!reader)throw new HttpError('invalid_body');
    let total=0;const chunks=[];
    try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.length;need(total<=limit,'body_too_large',413);chunks.push(part.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
    catch(e){if(e instanceof HttpError)throw e;throw new HttpError('invalid_json');}
    finally{void reader.cancel().catch(()=>{});}
  };
  const reconcile=async row=>{
    if(row.state!=='settling')return row;
    try{
      const result=await provider.reconcile(row);
      if(result?.success===true && result.network===MERCHANT.network && same(result.payer,row.payer) && String(result.amount)===String(row.amount) && txHash(result.transaction)){
        store.recordTransaction(row.id,{transaction_hash:result.transaction,now:clock()});
        store.markPaid(row.id,{transaction_hash:result.transaction,now:clock()});
      }
    }catch{}
    return store.raw(row.id);
  };
  const settle=async(id,payment)=>{
    const row=store.raw(id);
    // No charging on an expired signature, after operator pause, or without a
    // durable deliverable. A ready result can be recovered with the SAME auth.
    if(!enabled() || Number(row.valid_before)<=Math.floor(clock()/1000)+15)return;
    store.claimSettlement(id,clock());
    try{
      const r=await provider.settle(payment,payment.accepted);
      if(r?.success===true && r.network===MERCHANT.network && same(r.payer,row.payer) && txHash(r.transaction) && (r.amount===undefined||String(r.amount)===String(row.amount)))store.recordTransaction(id,{transaction_hash:r.transaction,now:clock()});
    }catch{}
    // The settlement claim is never cleared, including timeout, rejection,
    // process failure or a malformed reply. Only chain reconciliation follows.
    await reconcile(store.raw(id));
  };
  const run=async(id,request,payment)=>{
    try{
      const result=await worker.run(request);
      store.saveResult(id,{block:result.block,usage:{...result.usage,estimated_cost_usd:result.estimated_cost_usd},now:clock()});
    }catch(e){try{store.failWork(id,'research_failed',clock());}catch{}return;}
    try{await settle(id,payment);}catch{}
  };
  const background=promise=>{active.add(promise);void promise.catch(()=>{}).finally(()=>active.delete(promise));};

  async function handle(req){
    try{
      const url=new URL(req.url),path=url.pathname;
      need(!url.search,'unexpected_query');
      if(req.method==='GET' && path==='/health')return reply({ok:true,version:VERSION,ready:enabled()});
      if(req.method==='GET' && (path==='/v1/status'||path==='/.well-known/researchblocks.json'))return reply(status());
      if(req.method==='GET' && path==='/')return reply({name:'ResearchBlocks',...status(),usage:'Create a private quote, submit an existing authorized wallet payment signature, and poll while your agent continues other work.',documentation:'/openapi.json',limitations:'Model-generated comparison; source URLs are checked against provider evidence and allowed domains. Factual support and source retrieval times are not independently certified.'});
      if(req.method==='GET' && path==='/openapi.json')return reply(openapi(config.publicOrigin));
      if(req.method==='GET' && path==='/robots.txt')return new Response('User-agent: *\nAllow: /\nDisallow: /v1/orders/\n',{headers:{'content-type':'text/plain'}});
      if(req.method==='GET' && path==='/operator/summary'){
        const token=req.headers.get('authorization')?.replace(/^Bearer /,'')||'';
        need(typeof config.operatorToken==='string'&&config.operatorToken.length>=32&&timingSafeEqual(Buffer.from(hash(token)),Buffer.from(hash(config.operatorToken))),'not_found',404);
        return reply(store.summary());
      }
      if(req.method==='POST')need(!req.headers.has('origin') && req.headers.get('sec-fetch-site')!=='cross-site','direct_agent_requests_only',403);
      if(req.method==='POST' && path==='/v1/quote'){
        limiter('quote',30);const token=authorize(req);const input=await body(req);exact(input,['request']);
        let request;try{request=validateRequest(input.request);}catch{throw new HttpError('invalid_request');}
        need(Number(request.max_cost_usd)>=PRICE_UNITS/1e6,'budget_below_price',422);
        need(enabled(),'checkout_not_ready',503);
        need(capacity(),'service_capacity_exhausted',503);
        const row=store.create({token,request,amount:PRICE_UNITS,now:clock()});
        return reply({...view(row,clock()),payment:paymentRequirements(PRICE_UNITS),terms:'0.50 USDC for one comparison meeting the documented evidence threshold. Failed or insufficient research is not charged. Model claims remain unverified; unknown facts stay explicit. Keep the receipt token and reuse it for recovery.'},201);
      }
      const match=/^\/v1\/orders\/([a-f0-9-]{36})(\/execute)?$/.exec(path);
      need(match,'not_found',404);
      need((!match[2]&&req.method==='GET') || (match[2]&&req.method==='POST'),'method_not_allowed',405);
      const token=authorize(req);let row=store.get(match[1],token);need(row,'not_found',404);
      if(row.state==='settling'){limiter('reconcile',30);row=await reconcile(row);return reply(view(row,clock()),row.state==='paid'?200:202,{'Retry-After':'5'});}
      if(!match[2] || row.state==='paid')return reply(view(row,clock()),['working','result_ready'].includes(row.state)?202:200);
      const input=await body(req,64);exact(input,[]);
      if(row.state==='working')return reply(view(row,clock()),202,{'Retry-After':'5'});
      need(['quoted','result_ready'].includes(row.state),'order_not_executable',409);
      need(clock()<row.expires,'quote_expired',410);
      need(enabled(),'checkout_not_ready',503);
      const signature=req.headers.get('payment-signature');
      if(!signature){const required={x402Version:2,resource:{url:config.publicOrigin?config.publicOrigin+path:url.href,description:'ResearchBlocks official-source comparison',mimeType:'application/json'},accepts:[paymentRequirements(row.amount)]};return reply(required,402,{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(required)).toString('base64')});}
      limiter('verify',20);
      const payment=await parseAndValidatePayment(signature,paymentRequirements(row.amount),clock());
      const auth=payment.payload.authorization;
      need(Number(auth.validBefore)<=Math.floor(row.expires/1000),'payment_exceeds_quote',400);
      need(Number(auth.validBefore)>Math.floor(clock()/1000)+(row.state==='quoted'?120:20),'payment_lifetime_too_short',400);
      if(row.state==='result_ready')need(same(auth.from,row.payer)&&same(auth.nonce,row.nonce)&&auth.validBefore===row.valid_before,'original_authorization_required',409);
      const verified=await provider.verify(payment,payment.accepted);
      need(verified?.isValid===true && same(verified.payer,auth.from),'payment_not_verified',402);
      if(row.state==='result_ready'){background(settle(row.id,payment));return reply(view(store.raw(row.id),clock()),202,{'Retry-After':'5'});}
      const from_block=await provider.head();need(Number.isSafeInteger(from_block)&&from_block>=0,'network_unavailable',503);
      need(Number(auth.validBefore)>Math.floor(clock()/1000)+Math.ceil(workerPolicy.deadline_ms/1000)+30,'payment_lifetime_too_short',400);
      store.claimWork(row.id,{payer:auth.from,nonce:auth.nonce,valid_before:auth.validBefore,from_block,now:clock()});
      background(run(row.id,row.request_json,payment));
      return reply(view(store.raw(row.id),clock()),202,{'Retry-After':'5'});
    }catch(e){
      const safeCode=typeof e?.code==='string'&&/^[a-z_]{1,60}$/.test(e.code)?e.code:'temporarily_unavailable';
      const status=Number.isInteger(e?.status)&&e.status>=400&&e.status<600?e.status:503;
      return reply({error:safeCode,message:'Keep the original receipt and check its status. Do not send a second payment after an uncertain outcome.'},status);
    }
  }
  return {handle,status,drain:async()=>{while(active.size)await Promise.allSettled([...active]);}};
}

export function openapi(origin=''){
  return {openapi:'3.1.0',info:{title:'ResearchBlocks',version:VERSION,description:'Asynchronous source-linked comparisons for agents. Requires an authorized Base USDC EOA. Never supply a private key.'},servers:origin?[{url:origin}]:[],paths:{'/v1/status':{get:{summary:'Free readiness and price',responses:{200:{description:'Availability; not a sales count'}}}},'/v1/quote':{post:{summary:'Create or recover quote with client-generated private receipt',security:[{receipt:[]}],requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['request'],properties:{request:{$ref:'#/components/schemas/ResearchRequest'}},additionalProperties:false}}}},responses:{201:{description:'Quote; no funds moved'},503:{description:'Checkout not ready'}}}},'/v1/orders/{id}':{get:{summary:'Private job status and paid result recovery',parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}],security:[{receipt:[]}],responses:{200:{description:'Current state or confirmed paid result'},202:{description:'Work or settlement pending'}}}},'/v1/orders/{id}/execute':{post:{summary:'Authorize research and eventual exact payment after result is saved',parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}},{name:'PAYMENT-SIGNATURE',in:'header',schema:{type:'string'}}],security:[{receipt:[]}],requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false}}}},responses:{202:{description:'Job accepted; not confirmed revenue'},402:{description:'x402 payment requirements'},409:{description:'Conflict; recover original receipt'}}}}},components:{securitySchemes:{receipt:{type:'http',scheme:'bearer',description:'Client-generated 32 random bytes encoded as lowercase hex; persist before quoting.'}},schemas:{ResearchRequest:{type:'object',additionalProperties:false,required:['candidates','criteria','max_age_hours','max_cost_usd'],properties:{candidates:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,required:['id','label','official_domains'],properties:{id:{type:'string'},label:{type:'string'},official_domains:{type:'array',minItems:1,maxItems:10,items:{type:'string'}}}}},criteria:{type:'array',minItems:1,maxItems:5,items:{type:'object',additionalProperties:false,required:['id','question'],properties:{id:{type:'string'},question:{type:'string'}}}},max_age_hours:{type:'number',exclusiveMinimum:0,maximum:8760},max_cost_usd:{type:'string',description:'Maximum seller charge, at least 0.50 for this service.'}}}}}};
}

export async function start(config=readConfig()){
  need(!config.publicOrigin || /^https:\/\/[a-z0-9.-]+$/.test(config.publicOrigin),'invalid_public_origin');
  const store=openStore(config.database);store.recoverInterrupted(Date.now());
  const worker=createWorker({apiKey:config.researchApiKey});
  const provider=createProvider({apiKeyId:config.apiKeyId,apiKeySecret:config.apiKeySecret});
  let providerReady=false;
  try{providerReady=Boolean(await provider.supported());}catch{}
  const app=createApplication({store,provider,worker,config,providerReady});
  const server=http.createServer(async(req,res)=>{
    try{
      const chunks=[];let size=0;
      for await(const b of req){size+=b.length;if(size>14000){res.writeHead(413,{'content-type':'application/json','connection':'close'});res.end('{"error":"body_too_large"}');req.destroy();return;}chunks.push(b);}
      const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
      const response=await app.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"temporarily_unavailable"}');}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;
  await new Promise(resolve=>server.listen(config.port,'0.0.0.0',resolve));
  console.log(JSON.stringify({event:'ready',version:VERSION,payments_enabled:app.status().payments_enabled,provider_ready:providerReady,research_configured:worker.configured,startup_financial_requests:0}));
  return {server,store,app};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)start().catch(()=>{console.error('ResearchBlocks startup failed; check configuration without exposing credentials.');process.exitCode=1;});
