/**
 * Private-receipt agent client. The caller supplies an ALREADY AUTHORIZED EOA
 * signer; this module never loads a private key or asks for a wallet secret.
 * Keep the receipt and every adjacent sidecar together in a private directory.
 * Never delete a signing/submission claim to retry an uncertain payment.
 */
import {createHash, randomBytes} from 'node:crypto';
import {closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {validateRequest} from './worker.mjs';

const PIN = Object.freeze({
  network:'eip155:8453', chainId:8453, amount:'500000',
  payTo:'0x3a8De0b03EdAF430338a9CC871F2634882B1b75A',
  asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
});
const DOMAIN = Object.freeze({name:'USD Coin',version:'2',chainId:PIN.chainId,verifyingContract:PIN.asset});
const TYPES = Object.freeze({TransferWithAuthorization:Object.freeze([
  {name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
  {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'},
].map(Object.freeze))});
const STATES = new Set(['quoted','working','result_ready','settling','paid','research_failed','interrupted','expired']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':
  value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);

export class ClientError extends Error {
  constructor(code){super(code);this.name='ResearchBlocksClientError';this.code=code;}
}
const fail=code=>{throw new ClientError(code);};
const need=(ok,code)=>{if(!ok)fail(code);};
function budget(value){
  need((typeof value==='number'&&Number.isSafeInteger(value)) || (typeof value==='string'&&/^[1-9]\d{0,8}$/.test(value)), 'invalid_budget');
  const n=BigInt(value);need(n>=BigInt(PIN.amount)&&n<=100000000n,'budget_below_price_or_out_of_range');return String(n);
}
function checkedOrigin(value){
  let url;try{url=new URL(value);}catch{fail('invalid_origin');}
  need(typeof value==='string'&&url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash&&
    value.replace(/\/$/,'')===url.origin,'invalid_origin');return url.origin;
}
function privateRead(path,optional=false){
  let fd;
  try{
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    need(stat.isFile()&&(stat.mode&0o777)===0o600&&stat.size<=1048576,'unsafe_receipt_file');
    if(typeof process.getuid==='function')need(stat.uid===process.getuid(),'unsafe_receipt_file');
    return JSON.parse(readFileSync(fd,'utf8'));
  }catch(e){if(optional&&e.code==='ENOENT')return null;if(e instanceof ClientError)throw e;fail('receipt_unreadable');}
  finally{if(fd!==undefined)closeSync(fd);}
}
function syncDirectory(path){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}
/** Install a complete fsynced file without ever replacing an existing path. */
function installOnce(path,value){
  const parent=dirname(path);let fd,tmp;
  try{
    mkdirSync(parent,{recursive:true,mode:0o700});need(!lstatSync(parent).isSymbolicLink(),'unsafe_receipt_directory');
    tmp=path+'.tmp-'+randomBytes(16).toString('hex');
    fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
    try{linkSync(tmp,path);}catch(e){if(e.code==='EEXIST')return false;throw e;}
    syncDirectory(parent);return true;
  }catch(e){if(e instanceof ClientError)throw e;fail('receipt_write_failed');}
  finally{if(fd!==undefined)closeSync(fd);if(tmp&&existsSync(tmp)){unlinkSync(tmp);syncDirectory(parent);}}
}
function load(receiptPath){
  need(typeof receiptPath==='string'&&receiptPath.length>0,'invalid_receipt_path');
  const path=resolve(receiptPath),receipt=privateRead(path);
  let request;try{request=validateRequest(receipt.request);}catch{fail('invalid_receipt');}
  need(receipt.version===1&&/^[a-f0-9]{64}$/.test(receipt.token)&&receipt.origin===checkedOrigin(receipt.origin)&&
    canonical(request)===canonical(receipt.request)&&hash(canonical(request))===receipt.request_hash&&
    budget(receipt.max_amount_units)===receipt.max_amount_units,'invalid_receipt');
  return {path,receipt};
}
function checkedRequirements(value,ceiling){
  need(value&&value.scheme==='exact'&&value.network===PIN.network&&value.asset===PIN.asset&&value.payTo===PIN.payTo&&
    value.amount===PIN.amount&&BigInt(value.amount)<=BigInt(ceiling)&&value.maxTimeoutSeconds===300&&
    value.extra?.name==='USD Coin'&&value.extra?.version==='2','payment_requirements_mismatch');
  need(Object.keys(value).length===7&&Object.keys(value.extra).length===2,'payment_requirements_mismatch');
  return {scheme:'exact',network:PIN.network,asset:PIN.asset,amount:PIN.amount,payTo:PIN.payTo,
    maxTimeoutSeconds:300,extra:{name:'USD Coin',version:'2'}};
}
function checkedOrder(value,receipt,quote){
  need(value&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id)&&STATES.has(value.state)&&
    value.request_hash===receipt.request_hash&&value.amount_units===PIN.amount&&value.network===PIN.network&&value.pay_to===PIN.payTo&&
    Number.isSafeInteger(value.quote_expires_at)&&value.quote_expires_at>0,'order_mismatch');
  if(quote)need(value.id===quote.id&&value.quote_expires_at===quote.quote_expires_at,'order_mismatch');
  if(value.state==='paid')need(typeof value.transaction==='string'&&/^0x[\da-fA-F]{64}$/.test(value.transaction),'paid_receipt_unconfirmed');
  // Do not return tokens, signatures or arbitrary provider fields to callers.
  return {id:value.id,state:value.state,request_hash:value.request_hash,amount_units:value.amount_units,
    network:value.network,pay_to:value.pay_to,quote_expires_at:value.quote_expires_at,
    transaction:typeof value.transaction==='string'?value.transaction:null,
    error_code:typeof value.error_code==='string'&&/^[a-z_]{1,60}$/.test(value.error_code)?value.error_code:null,
    result_expired:value.result_expired===true,result:value.state==='paid'?value.result??null:null};
}
async function requestJson(url,{receipt,method='GET',payment,body,fetchImpl=fetch}){
  need(typeof fetchImpl==='function','invalid_fetch');
  const controller=new AbortController();let timer,reader;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ClientError('request_outcome_unknown'));},20000);});
  try{
    const response=await Promise.race([fetchImpl(url,{method,redirect:'error',signal:controller.signal,
      headers:{Authorization:'Bearer '+receipt.token,...(body===undefined?{}:{'Content-Type':'application/json'}),...(payment?{'PAYMENT-SIGNATURE':payment}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}),timeout]);
    need(!response.redirected&&(!response.url||response.url===url),'redirect_refused');
    need(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='application/json','response_invalid');
    need(Number(response.headers.get('content-length')||0)<=1048576,'response_too_large');
    reader=response.body?.getReader();need(reader,'response_invalid');
    const chunks=[];let bytes=0;
    for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;bytes+=part.value.length;need(bytes<=1048576,'response_too_large');chunks.push(part.value);}
    let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('response_invalid');}
    return {status:response.status,headers:response.headers,value};
  }catch(e){if(e instanceof ClientError)throw e;fail('request_outcome_unknown');}
  finally{clearTimeout(timer);controller.abort();if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
}
function quoteBinding(order,payment){return {id:order.id,request_hash:order.request_hash,amount_units:order.amount_units,
  network:order.network,pay_to:order.pay_to,quote_expires_at:order.quote_expires_at,payment};}
function readQuote(path,receipt){
  const quote=privateRead(path+'.quote.json',true);if(!quote)return null;
  checkedOrder({...quote,state:'quoted'},receipt);checkedRequirements(quote.payment,receipt.max_amount_units);return quote;
}

/** Persist the receipt BEFORE networking; repeating an unacknowledged quote is free and idempotent. */
export async function createQuote(receiptPath,{origin,request,maxAmountUnits=500000,fetchImpl=fetch}={}){
  const cleanOrigin=checkedOrigin(origin),ceiling=budget(maxAmountUnits);
  let normalized;try{normalized=validateRequest(request);}catch{fail('invalid_request');}
  need(typeof receiptPath==='string'&&receiptPath.length>0,'invalid_receipt_path');
  const path=resolve(receiptPath);
  installOnce(path,{version:1,origin:cleanOrigin,token:randomBytes(32).toString('hex'),request:normalized,
    request_hash:hash(canonical(normalized)),max_amount_units:ceiling,created_at:Date.now()});
  const {receipt}=load(path);
  need(receipt.origin===cleanOrigin&&canonical(receipt.request)===canonical(normalized)&&receipt.max_amount_units===ceiling,'receipt_parameters_changed');
  if(readQuote(path,receipt))return recover(path,{fetchImpl});
  const response=await requestJson(receipt.origin+'/v1/quote',{receipt,method:'POST',body:{request:receipt.request},fetchImpl});
  need(response.status===201,'quote_not_created');
  const order=checkedOrder(response.value,receipt),payment=checkedRequirements(response.value.payment,ceiling);
  const binding=quoteBinding(order,payment);
  if(!installOnce(path+'.quote.json',binding))need(canonical(readQuote(path,receipt))===canonical(binding),'quote_binding_changed');
  return {...order,client_state:'quoted',recovery_only:false};
}

/** Private GET only: never signs, submits, retries settlement or creates a new quote. */
export async function recover(receiptPath,{fetchImpl=fetch}={}){
  const {path,receipt}=load(receiptPath),quote=readQuote(path,receipt);
  if(!quote)return {state:'quote_acknowledgment_unknown',client_state:'repeat_create_quote_with_same_receipt',recovery_only:true};
  const response=await requestJson(receipt.origin+'/v1/orders/'+quote.id,{receipt,fetchImpl});
  need(response.status===200||response.status===202,'recovery_unavailable');
  const order=checkedOrder(response.value,receipt,quote),claimed=privateRead(path+'.payment-claim.json',true)!==null;
  return {...order,client_state:claimed?'payment_attempt_claimed':'quoted',recovery_only:claimed};
}

/** At most one signer call and signed POST per receipt, even after uncertain outcomes. */
export async function execute(receiptPath,{signer,maxAmountUnits=500000,fetchImpl=fetch}={}){
  const {path,receipt}=load(receiptPath),ceiling=budget(maxAmountUnits),quote=readQuote(path,receipt);
  need(quote,'quote_required');
  checkedRequirements(quote.payment,ceiling);checkedRequirements(quote.payment,receipt.max_amount_units);
  if(privateRead(path+'.payment-claim.json',true))return recover(path,{fetchImpl});
  need(signer&&typeof signer.address==='string'&&/^0x[\da-fA-F]{40}$/.test(signer.address)&&!/^0x0{40}$/i.test(signer.address)&&
    typeof signer.signTypedData==='function','authorized_eoa_signer_required');
  const url=receipt.origin+'/v1/orders/'+quote.id+'/execute';
  const response=await requestJson(url,{receipt,method:'POST',body:{},fetchImpl});
  if(response.status===200||response.status===202){const order=checkedOrder(response.value,receipt,quote);return {...order,client_state:'existing_order',recovery_only:true};}
  need(response.status===402&&response.value?.x402Version===2&&Array.isArray(response.value.accepts)&&response.value.accepts.length===1,
    'payment_challenge_required');
  const challenge=response.value;
  need(challenge.resource?.url===url&&challenge.resource?.mimeType==='application/json','payment_resource_mismatch');
  const encoded=response.headers.get('payment-required');
  let header;try{header=JSON.parse(Buffer.from(encoded||'','base64').toString('utf8'));}catch{fail('payment_challenge_mismatch');}
  need(canonical(header)===canonical(challenge),'payment_challenge_mismatch');
  const accepted=checkedRequirements(challenge.accepts[0],ceiling);
  need(canonical(accepted)===canonical(quote.payment),'payment_requirements_changed');
  const now=Math.floor(Date.now()/1000),validBefore=Math.min(Math.floor(quote.quote_expires_at/1000),now+240);
  need(validBefore>now+120,'quote_too_close_to_expiry');
  const authorization={from:signer.address,to:PIN.payTo,value:PIN.amount,validAfter:String(now-1),validBefore:String(validBefore),nonce:'0x'+randomBytes(32).toString('hex')};
  const claim={version:1,order_id:quote.id,origin:receipt.origin,request_hash:receipt.request_hash,accepted,authorization,claimed_at:Date.now()};
  if(!installOnce(path+'.payment-claim.json',claim))return recover(path,{fetchImpl});
  // A signing error or process death leaves this claim in place permanently.
  // Do not guess whether the caller's signer produced an authorization.
  let signature;
  try{signature=await signer.signTypedData({domain:{...DOMAIN},types:{TransferWithAuthorization:TYPES.TransferWithAuthorization.map(x=>({...x}))},
    primaryType:'TransferWithAuthorization',message:{...authorization,value:BigInt(authorization.value),validAfter:BigInt(authorization.validAfter),validBefore:BigInt(authorization.validBefore)}});}
  catch{fail('signing_outcome_unknown_recover_only');}
  need(typeof signature==='string'&&/^0x[\da-fA-F]{130}$/.test(signature),'signature_invalid_recover_only');
  const payment={x402Version:2,accepted,payload:{signature,authorization}};
  need(installOnce(path+'.signature.json',payment),'signature_already_recorded');
  need(Number(authorization.validBefore)>Math.floor(Date.now()/1000)+120,'authorization_too_close_to_expiry_recover_only');
  if(!installOnce(path+'.submission-claim.json',{version:1,order_id:quote.id,claimed_at:Date.now()}))return recover(path,{fetchImpl});
  const result=await requestJson(url,{receipt,method:'POST',body:{},payment:Buffer.from(JSON.stringify(payment)).toString('base64'),fetchImpl});
  need(result.status===200||result.status===202,'submission_not_confirmed_recover_only');
  return {...checkedOrder(result.value,receipt,quote),client_state:'payment_attempt_claimed',recovery_only:true};
}

/**
 * Explicit recovery for a worker crash AFTER saving its deliverable but BEFORE
 * claiming settlement. This is the sole exception to GET-only recovery: a
 * freshly read result_ready order may receive the EXACT saved authorization
 * once more. It never signs or creates a nonce, and never retries an uncertain
 * settlement. The server and EIP-3009 nonce both enforce one settlement.
 */
export async function resumeSavedAuthorization(receiptPath,{fetchImpl=fetch}={}){
  const {path,receipt}=load(receiptPath),quote=readQuote(path,receipt);
  need(quote,'quote_required');
  const order=await recover(path,{fetchImpl});
  if(order.state!=='result_ready'||privateRead(path+'.resume-claim.json',true))return order;
  const claim=privateRead(path+'.payment-claim.json',true),payment=privateRead(path+'.signature.json',true),submitted=privateRead(path+'.submission-claim.json',true);
  need(claim&&payment&&submitted&&claim.order_id===quote.id&&submitted.order_id===quote.id&&claim.origin===receipt.origin&&
    claim.request_hash===receipt.request_hash,'original_authorization_required');
  const accepted=checkedRequirements(payment.accepted,receipt.max_amount_units);
  need(canonical(accepted)===canonical(quote.payment)&&canonical(accepted)===canonical(claim.accepted)&&payment.x402Version===2&&
    Object.keys(payment).length===3&&Object.keys(payment.payload||{}).length===2&&
    typeof payment.payload?.signature==='string'&&/^0x[\da-fA-F]{130}$/.test(payment.payload.signature)&&
    canonical(payment.payload.authorization)===canonical(claim.authorization),'original_authorization_required');
  const auth=payment.payload.authorization;
  need(auth&&Object.keys(auth).length===6&&typeof auth.from==='string'&&/^0x[\da-fA-F]{40}$/.test(auth.from)&&!/^0x0{40}$/i.test(auth.from)&&
    auth.to===PIN.payTo&&auth.value===PIN.amount&&typeof auth.nonce==='string'&&/^0x[\da-fA-F]{64}$/.test(auth.nonce)&&
    typeof auth.validAfter==='string'&&/^\d{1,13}$/.test(auth.validAfter)&&typeof auth.validBefore==='string'&&/^\d{1,13}$/.test(auth.validBefore),
    'original_authorization_required');
  const now=Math.floor(Date.now()/1000);
  need(Number(auth.validAfter)<now&&Number(auth.validBefore)>now+30&&Number(auth.validBefore)<=Math.floor(quote.quote_expires_at/1000)&&
    Number(auth.validBefore)-Number(auth.validAfter)<=241,'saved_authorization_expired_recover_only');
  if(!installOnce(path+'.resume-claim.json',{version:1,order_id:quote.id,nonce:auth.nonce,claimed_at:Date.now()}))return recover(path,{fetchImpl});
  const result=await requestJson(receipt.origin+'/v1/orders/'+quote.id+'/execute',{receipt,method:'POST',body:{},
    payment:Buffer.from(JSON.stringify(payment)).toString('base64'),fetchImpl});
  need(result.status===200||result.status===202,'saved_authorization_resume_unknown_recover_only');
  return {...checkedOrder(result.value,receipt,quote),client_state:'saved_authorization_resume_claimed',recovery_only:true};
}
