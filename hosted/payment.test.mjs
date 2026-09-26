import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256,toBytes} from 'viem';
import {MERCHANT,authorizationTypes,paymentRequirements,parseAndValidatePayment,
  createProvider,providerJson,receiptMatches,PaymentError} from './payment.mjs';

// Public deterministic fixture key, used solely to sign local synthetic data.
const account=privateKeyToAccount('0x'+'11'.repeat(32));
const other=privateKeyToAccount('0x'+'22'.repeat(32));
const nonce='0x'+'ab'.repeat(32),transaction='0x'+'cd'.repeat(32),blockHash='0x'+'ef'.repeat(32);
const topic=address=>'0x'+address.slice(2).toLowerCase().padStart(64,'0');
const AUTH=keccak256(toBytes('AuthorizationUsed(address,bytes32)'));
const TRANSFER=keccak256(toBytes('Transfer(address,address,uint256)'));
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64');
const units='25000';
async function signed({now=Date.now(),authorization={},signer=account,requirements=paymentRequirements(units)}={}) {
  const seconds=Math.floor(now/1000);
  const a={from:account.address,to:MERCHANT.payTo,value:requirements.amount,
    validAfter:String(seconds-10),validBefore:String(seconds+240),nonce,...authorization};
  const signature=await signer.signTypedData({domain:MERCHANT.domain,types:authorizationTypes,
    primaryType:'TransferWithAuthorization',message:{...a,value:BigInt(a.value),
      validAfter:BigInt(a.validAfter),validBefore:BigInt(a.validBefore)}});
  return {x402Version:2,accepted:requirements,payload:{signature,authorization:a}};
}
function evidence() {
  const row={from_block:100,payer:account.address,nonce,amount:units,transaction_hash:transaction};
  const receipt={status:'0x1',transactionHash:transaction,blockHash,blockNumber:'0x65',logs:[
    {address:MERCHANT.asset,topics:[AUTH,topic(account.address),nonce],data:'0x',logIndex:'0x7'},
    {address:MERCHANT.asset,topics:[TRANSFER,topic(account.address),topic(MERCHANT.payTo)],
      data:'0x'+BigInt(units).toString(16).padStart(64,'0'),logIndex:'0x8'},
  ]};
  return {row,receipt,block:{hash:blockHash,number:'0x65'},height:102};
}
const code=expected=>error=>error instanceof PaymentError&&error.code===expected&&!String(error).includes('secret-fixture');
function syntheticCredentials() {
  const {privateKey}=generateKeyPairSync('ed25519');
  const jwk=privateKey.export({format:'jwk'});
  return {apiKeyId:'00000000-0000-4000-8000-000000000001',
    apiKeySecret:Buffer.concat([Buffer.from(jwk.d,'base64url'),Buffer.from(jwk.x,'base64url')]).toString('base64')};
}

test('requirements pin the existing wallet, Base USDC and bounded exact price',()=>{
  const requirements=paymentRequirements(25000);
  assert.equal(requirements.payTo,'0x3a8De0b03EdAF430338a9CC871F2634882B1b75A');
  assert.equal(requirements.network,'eip155:8453');
  assert.equal(requirements.asset,'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(requirements.amount,'25000');
  for(const amount of [0,-1,0.5,NaN,Infinity,'01','1e5',100_000_001])
    assert.throws(()=>paymentRequirements(amount),code('invalid_requirements'));
  for(const seconds of [0,301,1.1])assert.throws(()=>paymentRequirements(units,seconds),code('invalid_requirements'));
});

test('valid EOA payment recovers signer and strips untrusted forwarding metadata',async()=>{
  const now=Date.now(),requirements=paymentRequirements(units),payment=await signed({now});
  payment.resource={url:'https://attacker.invalid/private-token'};
  payment.extensions={unsafe:{headers:{Authorization:'secret-fixture'}}};
  const result=await parseAndValidatePayment(encode(payment),requirements,now);
  assert.equal(result.payload.authorization.from,account.address);
  assert.deepEqual(Object.keys(result),['x402Version','accepted','payload']);
  assert.ok(!JSON.stringify(result).includes('secret-fixture'));
});

test('v2 requirements reject changed price, recipient, chain, asset and lifetime',async()=>{
  const requirements=paymentRequirements(units),payment=await signed();
  for(const [key,value] of Object.entries({scheme:'upto',network:'eip155:1',asset:other.address,
    amount:'25001',payTo:other.address,maxTimeoutSeconds:299})) {
    const changed=structuredClone(payment);changed.accepted[key]=value;
    await assert.rejects(parseAndValidatePayment(encode(changed),requirements),code('payment_mismatch'));
  }
  const changed=structuredClone(payment);changed.x402Version=1;
  await assert.rejects(parseAndValidatePayment(encode(changed),requirements),code('payment_mismatch'));
  await assert.rejects(parseAndValidatePayment(encode(payment),{...requirements,payTo:other.address}),code('invalid_requirements'));
});

test('signed authorization binds payer, recipient, amount and nonce',async()=>{
  const requirements=paymentRequirements(units);
  for(const authorization of [{to:other.address},{value:'25001'}]) {
    await assert.rejects(parseAndValidatePayment(encode(await signed({authorization})),requirements),code('payment_mismatch'));
  }
  await assert.rejects(parseAndValidatePayment(encode(await signed({signer:other})),requirements),code('invalid_signature'));
  const changed=await signed();changed.payload.authorization.nonce='0x'+'12'.repeat(32);
  await assert.rejects(parseAndValidatePayment(encode(changed),requirements),code('invalid_signature'));
});

test('authorization must currently be valid, retain settlement margin and respect 300-second quote',async()=>{
  const now=Date.now(),seconds=Math.floor(now/1000),requirements=paymentRequirements(units);
  for(const authorization of [{validAfter:String(seconds)},{validBefore:String(seconds+5)},
    {validBefore:String(seconds+301)},{validBefore:String(seconds-1)}]) {
    await assert.rejects(parseAndValidatePayment(encode(await signed({now,authorization})),requirements,now),code('payment_expired'));
  }
});

test('malformed, oversized and extra executable fields are rejected',async()=>{
  const requirements=paymentRequirements(units);
  for(const value of ['', 'x'.repeat(12004),'%%%%',encode([]),encode(null),Buffer.from([0xff]).toString('base64')])
    await assert.rejects(parseAndValidatePayment(value,requirements),code('invalid_payment'));
  const changed=await signed();changed.payload.approval='unlimited';
  await assert.rejects(parseAndValidatePayment(encode(changed),requirements),code('invalid_payment'));
});

test('provider JSON errors are redacted, bounded and never retried',async()=>{
  for(const reply of [()=>{throw Error('secret-fixture');},()=>Response.json({error:'secret-fixture'},{status:401}),
    ()=>new Response('x'.repeat(131073),{headers:{'Content-Type':'application/json'}}),
    ()=>new Response('<html>secret-fixture',{headers:{'Content-Type':'text/html'}}),
    ()=>new Response('{bad json',{headers:{'Content-Type':'application/json'}})]) {
    let calls=0;
    await assert.rejects(providerJson('https://example.invalid',{method:'POST'},async(url,options)=>{
      calls++;assert.equal(options.redirect,'error');assert.ok(options.signal);return reply();
    }),code('provider_unavailable'));
    assert.equal(calls,1);
  }
});

test('CDP verification sends only normalized buyer authorization and returns no provider internals',async()=>{
  const payment=await signed(),calls=[];
  payment.resource={url:'https://secret-fixture.invalid'};
  const provider=createProvider(syntheticCredentials(),async(url,options)=>{
    calls.push(url);assert.match(options.headers.Authorization,/^Bearer /);
    const body=JSON.parse(options.body);
    assert.equal(body.x402Version,2);assert.equal(body.paymentPayload.resource,undefined);
    assert.equal(body.paymentRequirements.payTo,MERCHANT.payTo);
    return Response.json({isValid:true,payer:account.address,internal:'secret-fixture'});
  });
  assert.deepEqual(await provider.verify(payment,paymentRequirements(units)),{isValid:true,payer:account.address});
  assert.deepEqual(calls,['https://api.cdp.coinbase.com/platform/v2/x402/verify']);
});

test('settlement is one request; ambiguous response never triggers automatic retry',async()=>{
  const payment=await signed();let calls=0;
  const provider=createProvider(syntheticCredentials(),async(url)=>{
    calls++;assert.equal(url,'https://api.cdp.coinbase.com/platform/v2/x402/settle');
    throw Error('secret-fixture transport failed after possible broadcast');
  });
  await assert.rejects(provider.settle(payment,paymentRequirements(units)),code('provider_unavailable'));
  assert.equal(calls,1);
});

test('provider rejects unsigned or invalid caller payment before any external request',async()=>{
  let calls=0;const provider=createProvider(syntheticCredentials(),async()=>{calls++;throw Error();});
  await assert.rejects(provider.settle(await signed({signer:other}),paymentRequirements(units)),code('invalid_signature'));
  assert.equal(calls,0);
  assert.equal(Object.hasOwn(provider,'sign'),false);assert.equal(Object.hasOwn(provider,'transfer'),false);
});

test('provider readiness is authenticated read-only Base exact v2 discovery',async()=>{
  let calls=0;
  const provider=createProvider(syntheticCredentials(),async(url,options)=>{
    calls++;assert.equal(url,'https://api.cdp.coinbase.com/platform/v2/x402/supported');
    assert.equal(options.method,'GET');assert.equal(options.body,undefined);
    assert.match(options.headers.Authorization,/^Bearer /);
    return Response.json({kinds:[{x402Version:1,scheme:'exact',network:'eip155:8453'},
      {x402Version:2,scheme:'exact',network:'eip155:8453'}],internal:'secret-fixture'});
  });
  assert.equal(await provider.supported(),true);assert.equal(calls,1);
  const disabled=createProvider({},async()=>{calls++;throw Error();});
  assert.equal(await disabled.supported(),false);assert.equal(calls,1);
});

test('readiness rejects unsupported networks and malformed oversized capability lists',async()=>{
  for(const kinds of [[{x402Version:2,scheme:'exact',network:'eip155:84532'}],
    [{x402Version:1,scheme:'exact',network:'eip155:8453'}],[{x402Version:2,scheme:'upto',network:'eip155:8453'}]]) {
    const provider=createProvider(syntheticCredentials(),async()=>Response.json({kinds}));
    assert.equal(await provider.supported(),false);
  }
  for(const response of [{kinds:{}},{kinds:Array(257).fill({})}]) {
    const provider=createProvider(syntheticCredentials(),async()=>Response.json(response));
    await assert.rejects(provider.supported(),code('provider_unavailable'));
  }
});

test('receipt requires canonical successful Base USDC authorization paired with exact transfer',()=>{
  const {row,receipt,block,height}=evidence();
  assert.equal(receiptMatches(receipt,row,transaction,block,height),true);
  for(const change of [r=>{r.status='0x0';},r=>{r.logs[1].data='0x1';},
    r=>{r.logs[0].topics[2]='0x'+'11'.repeat(32);},r=>{r.logs[1].topics[2]=topic(other.address);},
    r=>{r.logs[1].address=other.address;},r=>{r.logs[0].removed=true;},
    r=>{r.blockHash='0x'+'33'.repeat(32);},r=>{r.logs[1].logIndex='0xa';}]) {
    const changed=structuredClone(receipt);change(changed);
    assert.equal(receiptMatches(changed,row,transaction,block,height),false);
  }
  assert.equal(receiptMatches(receipt,row,transaction,block,101),false);
  assert.equal(receiptMatches(receipt,{...row,from_block:102},transaction,block,height),false);
});

test('read-only reconciliation can recover a lost settlement response without credentials',async()=>{
  const {row,receipt,block,height}=evidence(),calls=[];row.transaction_hash=null;
  const provider=createProvider({},async(url,options)=>{
    assert.equal(url,'https://mainnet.base.org');
    const {method,params}=JSON.parse(options.body);calls.push({method,params});
    const results={eth_chainId:'0x2105',eth_blockNumber:'0x'+height.toString(16),
      eth_getLogs:[{...receipt.logs[0],transactionHash:transaction}],eth_getTransactionReceipt:receipt,eth_getBlockByNumber:block};
    return Response.json({jsonrpc:'2.0',id:1,result:results[method]});
  });
  assert.deepEqual(await provider.reconcile(row),{success:true,transaction,network:MERCHANT.network,payer:account.address,amount:units});
  assert.deepEqual(calls.map(call=>call.method),['eth_chainId','eth_blockNumber','eth_getLogs','eth_getTransactionReceipt','eth_getBlockByNumber']);
  assert.equal(calls[2].params[0].fromBlock,'0x64');
});

test('missing receipt stays pending and known hash skips log scanning',async()=>{
  const {row}=evidence(),calls=[];
  const provider=createProvider({},async(url,options)=>{
    const {method}=JSON.parse(options.body);calls.push(method);
    return Response.json({jsonrpc:'2.0',id:1,result:{eth_chainId:'0x2105',eth_blockNumber:'0x66',eth_getTransactionReceipt:null}[method]});
  });
  assert.equal(await provider.reconcile(row),null);
  assert.deepEqual(calls,['eth_chainId','eth_blockNumber','eth_getTransactionReceipt']);
});

test('reconciliation scan is bounded; wrong chains and invalid saved rows fail closed',async()=>{
  const {row}=evidence();row.transaction_hash=null;let calls=0;
  const provider=createProvider({},async(url,options)=>{
    calls++;const {method,params}=JSON.parse(options.body);
    if(method==='eth_getLogs')assert.equal(params[0].toBlock,'0x44c');
    return Response.json({jsonrpc:'2.0',id:1,result:{eth_chainId:'0x2105',eth_blockNumber:'0x100000',eth_getLogs:[]}[method]});
  });
  assert.equal(await provider.reconcile(row),null);assert.equal(calls,3);
  await assert.rejects(provider.reconcile({...row,from_block:-1}),code('provider_unavailable'));
  assert.equal(calls,3);
  const wrongChain=createProvider({},async()=>Response.json({jsonrpc:'2.0',id:1,result:'0x1'}));
  await assert.rejects(wrongChain.reconcile(row),code('provider_unavailable'));
});
