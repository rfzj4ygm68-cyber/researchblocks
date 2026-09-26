import {generateJwt} from '@coinbase/cdp-sdk/auth';
import {isAddress, keccak256, recoverTypedDataAddress, toBytes} from 'viem';

// Server-owned receiving settings. No request, environment variable, wallet
// secret or caller metadata can change the recipient, network or token.
export const MERCHANT = Object.freeze({
  payTo: '0x3a8De0b03EdAF430338a9CC871F2634882B1b75A',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  network: 'eip155:8453', chainId: 8453, decimals: 6,
  domain: Object.freeze({name: 'USD Coin', version: '2', chainId: 8453,
    verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'}),
});
export const authorizationTypes = Object.freeze({TransferWithAuthorization: Object.freeze([
  {name:'from',type:'address'}, {name:'to',type:'address'}, {name:'value',type:'uint256'},
  {name:'validAfter',type:'uint256'}, {name:'validBefore',type:'uint256'}, {name:'nonce',type:'bytes32'},
].map(Object.freeze))});

const MESSAGES = Object.freeze({
  invalid_payment: 'Invalid payment signature.',
  payment_mismatch: 'Payment must match the exact quoted network, token, recipient and amount.',
  payment_expired: 'Payment authorization is expired, not yet valid or exceeds the quoted lifetime.',
  invalid_signature: 'Wallet signature could not be verified. This release supports EOA wallets only.',
  invalid_requirements: 'Payment configuration is unavailable.',
  provider_unavailable: 'Payment status is unavailable. Keep the existing receipt and check it again; do not pay again.',
});
export class PaymentError extends Error {
  constructor(code, status=400) {
    super(MESSAGES[code] ?? MESSAGES.provider_unavailable);
    this.name='PaymentError'; this.code=code; this.status=status;
  }
}
const unavailable=()=>new PaymentError('provider_unavailable',503);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hash=value=>typeof value==='string'&&/^0x[\da-fA-F]{64}$/.test(value);
const decimal=value=>typeof value==='string'&&/^(0|[1-9]\d{0,12})$/.test(value);
const topic=address=>'0x'+address.slice(2).toLowerCase().padStart(64,'0');
const uint=value=>{if(typeof value!=='string'||!/^0x[\da-fA-F]{1,64}$/.test(value))throw unavailable();return BigInt(value);};
const AUTH=keccak256(toBytes('AuthorizationUsed(address,bytes32)'));
const TRANSFER=keccak256(toBytes('Transfer(address,address,uint256)'));

function exactObject(value, allowed, required=allowed) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))
    throw new PaymentError('invalid_payment');
}

export function paymentRequirements(amount, maxTimeoutSeconds=300) {
  const units=String(amount);
  // A deliberately bounded launch contract, not an unlimited-charge facility.
  if(!decimal(units)||BigInt(units)<1n||BigInt(units)>100_000_000n||
    !Number.isInteger(maxTimeoutSeconds)||maxTimeoutSeconds<1||maxTimeoutSeconds>300)
    throw new PaymentError('invalid_requirements',503);
  return {scheme:'exact',network:MERCHANT.network,asset:MERCHANT.asset,amount:units,
    payTo:MERCHANT.payTo,maxTimeoutSeconds,extra:{name:'USD Coin',version:'2'}};
}

function checkedRequirements(requirements) {
  try {
    exactObject(requirements,['scheme','network','asset','amount','payTo','maxTimeoutSeconds','extra']);
    exactObject(requirements.extra,['name','version']);
    const fixed=paymentRequirements(requirements.amount,requirements.maxTimeoutSeconds);
    if(Object.keys(fixed).some(key=>key==='extra'
      ? requirements.extra.name!=='USD Coin'||requirements.extra.version!=='2'
      : requirements[key]!==fixed[key]))throw Error();
    return fixed;
  }catch {throw new PaymentError('invalid_requirements',503);}
}

/** Strict x402 v2 EIP-3009 authorization. now is UTC Unix milliseconds. */
export async function parseAndValidatePayment(encoded, requirements, now=Date.now()) {
  const expected=checkedRequirements(requirements);
  let payment;
  try {
    if(typeof encoded!=='string'||encoded.length===0||encoded.length>12000||encoded.length%4!==0||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Error();
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded)throw Error();
    payment=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch {throw new PaymentError('invalid_payment');}
  exactObject(payment,['x402Version','accepted','payload','resource','extensions'],['x402Version','accepted','payload']);
  exactObject(payment.payload,['signature','authorization']);
  const accepted=payment.accepted;
  exactObject(accepted,['scheme','network','asset','amount','payTo','maxTimeoutSeconds','extra']);
  exactObject(accepted.extra,['name','version']);
  if(payment.x402Version!==2||Object.keys(expected).some(key=>key==='extra'
    ? accepted.extra.name!==expected.extra.name||accepted.extra.version!==expected.extra.version
    : accepted[key]!==expected[key]))throw new PaymentError('payment_mismatch');
  const a=payment.payload.authorization;
  exactObject(a,['from','to','value','validAfter','validBefore','nonce']);
  if(typeof a.from!=='string'||!isAddress(a.from)||/^0x0{40}$/i.test(a.from)||
    !same(a.to,MERCHANT.payTo)||a.value!==expected.amount||!decimal(a.validAfter)||!decimal(a.validBefore)||
    !hash(a.nonce)||typeof payment.payload.signature!=='string'||!/^0x[\da-fA-F]{130}$/.test(payment.payload.signature))
    throw new PaymentError('payment_mismatch');
  if(!Number.isSafeInteger(now)||now<0)throw new PaymentError('invalid_requirements',503);
  const seconds=BigInt(Math.floor(now/1000));
  if(BigInt(a.validAfter)>=seconds||BigInt(a.validBefore)<=seconds+5n||
    BigInt(a.validBefore)>seconds+BigInt(expected.maxTimeoutSeconds))throw new PaymentError('payment_expired');
  let recovered;
  try {
    recovered=await recoverTypedDataAddress({domain:MERCHANT.domain,types:authorizationTypes,
      primaryType:'TransferWithAuthorization',message:{...a,value:BigInt(a.value),
        validAfter:BigInt(a.validAfter),validBefore:BigInt(a.validBefore)},signature:payment.payload.signature});
  }catch {throw new PaymentError('invalid_signature');}
  if(!same(recovered,a.from))throw new PaymentError('invalid_signature');
  // Never forward caller URLs, arbitrary extensions or private request content.
  return {x402Version:2,accepted:expected,payload:{signature:payment.payload.signature,authorization:{...a}}};
}

/** One bounded JSON request; no redirects, retries or provider error echoing. */
export async function providerJson(url, options, fetchImpl=fetch) {
  const controller=new AbortController(); let reader,timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},15000);});
  try {
    const response=await Promise.race([fetchImpl(url,{...options,signal:controller.signal,redirect:'error'}),timeout]);
    if(response.status!==200||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||
      Number(response.headers.get('content-length'))>131072)throw unavailable();
    reader=response.body?.getReader(); if(!reader)throw unavailable();
    const chunks=[]; let length=0;
    for(;;) {
      const part=await Promise.race([reader.read(),timeout]); if(part.done)break;
      length+=part.value.length; if(length>131072)throw unavailable(); chunks.push(part.value);
    }
    const bytes=new Uint8Array(length); let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch {throw unavailable();}
  finally {clearTimeout(timer);controller.abort();if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
}

function validReconciliationRow(row) {
  if(!row||!Number.isSafeInteger(row.from_block)||row.from_block<0||
    typeof row.payer!=='string'||!isAddress(row.payer)||!hash(row.nonce)||
    !decimal(String(row.amount))||BigInt(row.amount)<1n||BigInt(row.amount)>100_000_000n||
    (row.transaction_hash!=null&&!hash(row.transaction_hash)))throw unavailable();
}

/** Read-only evidence check. One successor block is required; this is not L1 finality. */
export function receiptMatches(receipt,row,transaction,block,height) {
  try {
    validReconciliationRow(row);
    if(!Number.isSafeInteger(height)||height<0||!hash(transaction)||!receipt||receipt.status!=='0x1'||
      !same(receipt.transactionHash,transaction)||!hash(receipt.blockHash)||!block||
      !same(block.hash,receipt.blockHash)||!Array.isArray(receipt.logs)||receipt.logs.length>1024)return false;
    const number=uint(receipt.blockNumber);
    if(number!==uint(block.number)||number<BigInt(row.from_block)||BigInt(height)<number+1n)return false;
    const logs=receipt.logs.filter(log=>!log.removed&&same(log.address,MERCHANT.asset));
    const authorizations=logs.filter(log=>log.topics?.length===3&&same(log.topics[0],AUTH)&&
      same(log.topics[1],topic(row.payer))&&same(log.topics[2],row.nonce));
    if(authorizations.length!==1)return false;
    const authorization=authorizations[0];
    // Circle USDC emits AuthorizationUsed immediately before this authorization's
    // Transfer. Pair log indices so unrelated transfers in a batched transaction
    // cannot masquerade as payment for the saved nonce.
    const transfers=logs.filter(log=>log.topics?.length===3&&same(log.topics[0],TRANSFER)&&
      same(log.topics[1],topic(row.payer))&&same(log.topics[2],topic(MERCHANT.payTo))&&
      uint(log.logIndex)===uint(authorization.logIndex)+1n);
    return transfers.length===1&&uint(transfers[0].data)===BigInt(row.amount);
  }catch {return false;}
}

/**
 * The only mutating API is settlement of the caller's locally verified exact
 * authorization. The caller MUST durably claim that authorization before one
 * settle call. Ambiguous replies require reconcile(); never retry settle().
 * CDP API credentials authenticate the facilitator, not merchant-wallet signing.
 */
export function createProvider(credentials={},fetchImpl=fetch) {
  const {apiKeyId,apiKeySecret}=credentials;
  async function authenticated(action,method,body) {
    if(!['verify','settle','supported'].includes(action)||
      (action==='supported'?method!=='GET':method!=='POST'))throw unavailable();
    let jwt;
    try {
      if(typeof apiKeyId!=='string'||!apiKeyId||typeof apiKeySecret!=='string'||!apiKeySecret)throw Error();
      jwt=await generateJwt({apiKeyId,apiKeySecret,requestMethod:method,requestHost:'api.cdp.coinbase.com',
        requestPath:'/platform/v2/x402/'+action,expiresIn:120});
    }catch {throw unavailable();}
    return providerJson('https://api.cdp.coinbase.com/platform/v2/x402/'+action,
      {method,headers:{Authorization:'Bearer '+jwt,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})},fetchImpl);
  }
  async function cdp(action,payload,requirements) {
    if(!['verify','settle'].includes(action))throw unavailable();
    const normalized=await parseAndValidatePayment(Buffer.from(JSON.stringify(payload)).toString('base64'),requirements);
    const value=await authenticated(action,'POST',
      {x402Version:2,paymentPayload:normalized,paymentRequirements:normalized.accepted});
    const payer=normalized.payload.authorization.from;
    if(action==='verify') {
      if(value?.isValid===false)return {isValid:false};
      if(value?.isValid!==true||!same(value.payer,payer))throw unavailable();
      return {isValid:true,payer};
    }
    if(value?.success===false)return {success:false,errorReason:'settlement_not_confirmed'};
    if(value?.success!==true||value.network!==MERCHANT.network||!same(value.payer,payer)||
      !hash(value.transaction)||(value.amount!==undefined&&String(value.amount)!==requirements.amount))throw unavailable();
    return {success:true,network:MERCHANT.network,payer,transaction:value.transaction,amount:requirements.amount};
  }
  async function rpc(method,params) {
    if(!['eth_chainId','eth_blockNumber','eth_getTransactionReceipt','eth_getBlockByNumber','eth_getLogs'].includes(method))throw unavailable();
    const value=await providerJson('https://mainnet.base.org',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},fetchImpl);
    if(value?.jsonrpc!=='2.0'||value.id!==1||value.error||!Object.hasOwn(value,'result'))throw unavailable();
    return value.result;
  }
  async function head() {
    if(uint(await rpc('eth_chainId',[]))!==8453n)throw unavailable();
    const height=uint(await rpc('eth_blockNumber',[]));
    if(height>BigInt(Number.MAX_SAFE_INTEGER))throw unavailable(); return Number(height);
  }
  return Object.freeze({
    async supported() {
      // No credentials are needed to construct the disabled service or use its
      // receipt reader. Readiness must never be mistaken for a live settlement.
      if(!apiKeyId||!apiKeySecret)return false;
      const result=await authenticated('supported','GET');
      if(!result||!Array.isArray(result.kinds)||result.kinds.length>256)throw unavailable();
      return result.kinds.some(kind=>kind?.x402Version===2&&kind.scheme==='exact'&&kind.network===MERCHANT.network);
    },
    verify:(payload,requirements)=>cdp('verify',payload,requirements),
    settle:(payload,requirements)=>cdp('settle',payload,requirements),head,
    async reconcile(row) {
      validReconciliationRow(row);
      const height=await head(); if(height<row.from_block)throw unavailable();
      let transaction=row.transaction_hash;
      if(!transaction) {
        // This fixed window spans >30 minutes at normal Base block cadence,
        // comfortably beyond a 300-second authorization, without an unbounded scan.
        const logs=await rpc('eth_getLogs',[{address:MERCHANT.asset,fromBlock:'0x'+row.from_block.toString(16),
          toBlock:'0x'+Math.min(height,row.from_block+1000).toString(16),topics:[AUTH,topic(row.payer),row.nonce]}]);
        if(!Array.isArray(logs)||logs.length>2)throw unavailable();
        const matches=logs.filter(log=>!log.removed&&same(log.address,MERCHANT.asset)&&log.topics?.length===3&&
          same(log.topics[0],AUTH)&&same(log.topics[1],topic(row.payer))&&same(log.topics[2],row.nonce)&&hash(log.transactionHash));
        if(matches.length===0)return null;
        if(matches.length!==1)throw unavailable(); transaction=matches[0].transactionHash;
      }
      const receipt=await rpc('eth_getTransactionReceipt',[transaction]); if(receipt===null)return null;
      // A freshly included receipt is pending until the next block, not a failed payment.
      if(receipt&&uint(receipt.blockNumber)+1n>BigInt(height))return null;
      const block=await rpc('eth_getBlockByNumber',[receipt?.blockNumber,false]);
      if(!receiptMatches(receipt,row,transaction,block,height))throw unavailable();
      return {success:true,transaction,network:MERCHANT.network,payer:row.payer,amount:String(row.amount)};
    },
  });
}
