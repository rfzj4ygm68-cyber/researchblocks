import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openStore, StoreError, QUOTE_TTL_MS, RESULT_RETENTION_MS } from './store.mjs';

const NOW = Date.now();
const TOKEN = () => randomBytes(32).toString('hex');
const NONCE = () => `0x${TOKEN()}`;
const PAYER = `0x${'ab'.repeat(20)}`;
const TX = () => `0x${TOKEN()}`;
const REQUEST = { vendors: ['example'], facts: ['pricing'], source: 'agent_challenge' };
const BLOCK = { schema_version: '1', cells: [{ vendor: 'example', fact: 'pricing', value: 'Example evidence' }] };
const auth = (extra = {}) => ({ payer: PAYER, nonce: NONCE(), valid_before: String(Math.floor(NOW / 1000) + 600), from_block: 12345, now: NOW, ...extra });
const code = expected => error => error instanceof StoreError && error.code === expected;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rb-ledger-'));
  const file = join(directory, 'private', 'orders.sqlite');
  const store = openStore(file);
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, file, directory };
}
function quote(store, request = REQUEST) {
  const token = TOKEN();
  return { token, ...store.create({ token, request, now: NOW }) };
}
function ready(store, extra = {}) {
  const row = quote(store);
  store.claimWork(row.id, auth(extra));
  store.saveResult(row.id, { block: BLOCK, usage: { requests: 2 }, now: NOW + 1 });
  return row;
}

test('creates a private fixed-price quote and stores only a token digest', t => {
  const { store, file } = fixture(t);
  const row = quote(store);
  assert.equal(row.state, 'quoted');
  assert.equal(row.amount, 500000);
  assert.equal(row.expires, NOW + QUOTE_TTL_MS);
  assert.equal(row.source, 'agent_challenge');
  assert.match(row.request_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.token_hash, row.token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(store.raw(row.id)).includes(row.token), false);
});

test('same token and canonical body recover the exact original quote', t => {
  const { store } = fixture(t);
  const row = quote(store, { a: 1, nested: { x: 2, y: 3 } });
  const retry = store.create({ token: row.token.toUpperCase(), request: { nested: { y: 3, x: 2 }, a: 1 }, now: NOW + 100 });
  assert.equal(retry.id, row.id);
  assert.equal(retry.created, NOW);
  assert.equal(retry.expires, row.expires);
  assert.equal(store.summary().counts.quoted, 1);
});

test('changing a body for an existing token is a conflict', t => {
  const { store } = fixture(t);
  const row = quote(store);
  assert.throws(() => store.create({ token: row.token, request: { ...REQUEST, facts: ['other'] } }), code('token_conflict'));
  assert.equal(store.summary().counts.quoted, 1);
});

test('wrong, malformed and missing receipt tokens cannot read an order', t => {
  const { store } = fixture(t);
  const row = quote(store);
  assert.equal(store.get(row.id, TOKEN()), null);
  assert.equal(store.get(row.id, 'bad'), null);
  assert.equal(store.get(row.id, undefined), null);
  assert.equal(store.get('missing', row.token), null);
  assert.equal(store.get(row.id, row.token).id, row.id);
});

test('rejects weak receipt tokens', t => {
  const { store } = fixture(t);
  for (const token of ['secret', 'x'.repeat(64), 'a'.repeat(63), null, 123]) {
    assert.throws(() => store.create({ token, request: REQUEST }), code('invalid_token'));
  }
});

test('caller cannot choose a cheaper or malformed price', t => {
  const { store } = fixture(t);
  for (const amount of [0, 1, 499999, 500001, '500000', Infinity, NaN]) {
    assert.throws(() => store.create({ token: TOKEN(), request: REQUEST, amount }), code('invalid_amount'));
  }
});

test('rejects noncanonical, cyclic and oversized request bodies', t => {
  const { store } = fixture(t);
  const cycle = {}; cycle.self = cycle;
  for (const request of [[], null, { x: undefined }, { x: NaN }, { x: new Date() }, cycle, { x: 'a'.repeat(65536) }]) {
    assert.throws(() => store.create({ token: TOKEN(), request }), code('invalid_request'));
  }
});

test('quote expiry commits without starting research or reserving supplier budget', t => {
  const { store } = fixture(t);
  const row = quote(store);
  assert.throws(() => store.claimWork(row.id, auth({ now: NOW + QUOTE_TTL_MS, valid_before: String(Math.floor(NOW / 1000) + 3600) })), code('quote_expired'));
  assert.equal(store.raw(row.id).state, 'expired');
  assert.equal(store.summary().supplier_jobs_started, 0);
});

test('expired authorization never claims an otherwise current quote', t => {
  const { store } = fixture(t);
  const row = quote(store);
  assert.throws(() => store.claimWork(row.id, auth({ valid_before: String(Math.floor(NOW / 1000)) })), code('authorization_expired'));
  assert.equal(store.raw(row.id).state, 'quoted');
});

test('authorization values are validated without unsafe numeric coercion', t => {
  const { store } = fixture(t);
  const row = quote(store);
  for (const bad of [{ payer: '0x1' }, { nonce: '0x2' }, { valid_before: '1e30' }, { valid_before: 2 ** 60 }, { from_block: -1 }, { from_block: 2 ** 60 }]) {
    assert.throws(() => store.claimWork(row.id, auth(bad)), code('invalid_authorization'));
  }
  assert.equal(store.summary().supplier_jobs_started, 0);
});

test('claim durably binds the authorization and reserves the full supplier allowance', t => {
  const { store } = fixture(t);
  const row = quote(store);
  const authorization = auth({ payer: `0x${'AB'.repeat(20)}`, from_block: '0x3039' });
  const working = store.claimWork(row.id, authorization);
  assert.equal(working.state, 'working');
  assert.equal(working.payer, PAYER);
  assert.equal(working.nonce, authorization.nonce);
  assert.equal(working.from_block, 12345);
  assert.equal(working.reserved_micros, 150000);
  assert.equal(store.summary().supplier_reserved_micros, 150000);
});

test('a repeated work claim cannot start duplicate provider work', t => {
  const { store } = fixture(t);
  const row = quote(store);
  const authorization = auth();
  store.claimWork(row.id, authorization);
  assert.throws(() => store.claimWork(row.id, authorization), code('invalid_state'));
  assert.equal(store.summary().supplier_jobs_started, 1);
});

test('only one research job can be active across unrelated quotes', t => {
  const { store } = fixture(t);
  const a = quote(store); const b = quote(store);
  store.claimWork(a.id, auth());
  assert.throws(() => store.claimWork(b.id, auth()), code('worker_busy'));
  assert.equal(store.raw(b.id).state, 'quoted');
  assert.equal(store.summary().supplier_jobs_started, 1);
});

test('payer and nonce cannot be reused after failed research', t => {
  const { store } = fixture(t);
  const authorization = auth();
  const a = quote(store); const b = quote(store);
  store.claimWork(a.id, authorization);
  store.failWork(a.id, 'supplier_unavailable', NOW);
  assert.throws(() => store.claimWork(b.id, { ...authorization, payer: `0x${'AB'.repeat(20)}` }), code('authorization_reused'));
  assert.equal(store.summary().supplier_jobs_started, 1);
});

test('the same nonce from another payer remains independent', t => {
  const { store } = fixture(t);
  const authorization = auth();
  const a = quote(store); const b = quote(store);
  store.claimWork(a.id, authorization);
  store.failWork(a.id, 'supplier_unavailable', NOW);
  assert.equal(store.claimWork(b.id, { ...authorization, payer: `0x${'cd'.repeat(20)}` }).state, 'working');
});

test('failed and interrupted jobs permanently consume lifetime reservations', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 10; i++) {
    const row = quote(store);
    store.claimWork(row.id, auth());
    if (i % 2) store.recoverInterrupted(NOW); else store.failWork(row.id, 'supplier_failed', NOW);
  }
  const eleventh = quote(store);
  assert.throws(() => store.claimWork(eleventh.id, auth()), code('budget_exhausted'));
  const summary = store.summary();
  assert.equal(summary.supplier_jobs_started, 10);
  assert.equal(summary.supplier_reserved_micros, 1500000);
  assert.equal(summary.supplier_budget_remaining_micros, 0);
  assert.equal(summary.supplier_jobs_remaining, 0);
  assert.equal(summary.confirmed_paid_orders, 0);
});

test('saveResult makes evidence durable before settlement becomes claimable', t => {
  const { store } = fixture(t);
  const row = ready(store);
  assert.equal(store.raw(row.id).state, 'result_ready');
  assert.deepEqual(store.get(row.id, row.token).result_json, BLOCK);
  assert.deepEqual(store.raw(row.id).usage_json, { requests: 2 });
  assert.equal(store.summary().gross_receipts_micros, 0);
});

test('result cannot be injected before authorized work', t => {
  const { store } = fixture(t);
  const row = quote(store);
  assert.throws(() => store.saveResult(row.id, { block: BLOCK, usage: {} }), code('invalid_state'));
});

test('late provider callbacks cannot overwrite the original result', t => {
  const { store } = fixture(t);
  const row = ready(store);
  assert.throws(() => store.saveResult(row.id, { block: { changed: true } }), code('invalid_state'));
  assert.throws(() => store.failWork(row.id, 'late_failure'), code('invalid_state'));
  assert.deepEqual(store.raw(row.id).result_json, BLOCK);
});

test('errors are bounded machine codes, never raw provider messages', t => {
  const { store } = fixture(t);
  const row = quote(store); store.claimWork(row.id, auth());
  assert.throws(() => store.failWork(row.id, 'Bearer secret token'), code('invalid_error_code'));
  assert.equal(store.failWork(row.id, 'provider_invalid_result').error_code, 'provider_invalid_result');
});

test('settlement can be claimed exactly once', t => {
  const { store } = fixture(t);
  const row = ready(store);
  assert.equal(store.claimSettlement(row.id, NOW + 2).state, 'settling');
  assert.throws(() => store.claimSettlement(row.id, NOW + 3), code('invalid_state'));
  assert.equal(store.summary().confirmed_paid_orders, 0);
});

test('expired authorization leaves result ready without attempting settlement', t => {
  const { store } = fixture(t);
  const row = ready(store);
  assert.throws(() => store.claimSettlement(row.id, NOW + 700000), code('authorization_expired'));
  assert.equal(store.raw(row.id).state, 'result_ready');
});

test('paid requires a previously recorded matching transaction', t => {
  const { store } = fixture(t);
  const row = ready(store); store.claimSettlement(row.id, NOW + 2);
  const transaction_hash = TX();
  assert.throws(() => store.markPaid(row.id, { transaction_hash, now: NOW + 3 }), code('transaction_not_recorded'));
  store.recordTransaction(row.id, { transaction_hash, now: NOW + 3 });
  assert.equal(store.summary().gross_receipts_micros, 0);
  assert.throws(() => store.markPaid(row.id, { transaction_hash: TX(), now: NOW + 3 }), code('transaction_not_recorded'));
  const paid = store.markPaid(row.id, { transaction_hash, now: NOW + 4 });
  assert.equal(paid.state, 'paid');
  assert.equal(paid.paid_at, NOW + 4);
  assert.equal(store.summary().gross_receipts_micros, 500000);
});

test('transaction and paid replays are idempotent without changing original paid time', t => {
  const { store } = fixture(t);
  const row = ready(store); store.claimSettlement(row.id, NOW + 2);
  const transaction_hash = TX();
  store.recordTransaction(row.id, { transaction_hash });
  store.markPaid(row.id, { transaction_hash, now: NOW + 3 });
  store.recordTransaction(row.id, { transaction_hash });
  assert.equal(store.markPaid(row.id, { transaction_hash, now: NOW + 100 }).paid_at, NOW + 3);
  assert.equal(store.summary().confirmed_paid_orders, 1);
  assert.throws(() => store.recordTransaction(row.id, { transaction_hash: TX() }), code('transaction_conflict'));
});

test('separately bound authorizations can share a batched settlement transaction', t => {
  const { store } = fixture(t);
  const a = ready(store); const b = ready(store);
  store.claimSettlement(a.id, NOW + 2); store.claimSettlement(b.id, NOW + 2);
  const transaction_hash = TX();
  store.recordTransaction(a.id, { transaction_hash });
  store.recordTransaction(b.id, { transaction_hash });
  assert.equal(store.raw(a.id).transaction_hash, store.raw(b.id).transaction_hash);
  assert.notEqual(store.raw(a.id).nonce, store.raw(b.id).nonce);
});

test('a malformed transaction cannot contaminate the durable candidate', t => {
  const { store } = fixture(t);
  const row = ready(store); store.claimSettlement(row.id, NOW + 2);
  assert.throws(() => store.recordTransaction(row.id, { transaction_hash: 'receipt says success' }), code('invalid_transaction'));
  assert.equal(store.raw(row.id).transaction_hash, null);
});

test('recovery interrupts unfinished supplier work and prohibits stale callbacks', t => {
  const { store } = fixture(t);
  const row = quote(store); store.claimWork(row.id, auth());
  assert.equal(store.recoverInterrupted(NOW + 10), 1);
  assert.equal(store.raw(row.id).state, 'interrupted');
  assert.equal(store.recoverInterrupted(NOW + 11), 0);
  assert.throws(() => store.saveResult(row.id, { block: BLOCK }), code('invalid_state'));
  assert.throws(() => store.claimWork(row.id, auth()), code('invalid_state'));
  assert.equal(store.summary().supplier_reserved_micros, 150000);
});

test('recovery preserves result-ready and settling rows without automatic recharge', t => {
  const { store } = fixture(t);
  const a = ready(store); const b = ready(store);
  store.claimSettlement(b.id, NOW + 2);
  assert.equal(store.recoverInterrupted(NOW + 10), 0);
  assert.equal(store.raw(a.id).state, 'result_ready');
  assert.equal(store.raw(b.id).state, 'settling');
  assert.throws(() => store.claimSettlement(b.id, NOW + 11), code('invalid_state'));
});

test('reopening the database retains state and lifetime reservations', t => {
  const { store, file } = fixture(t);
  const row = quote(store); store.claimWork(row.id, auth()); store.close();
  const reopened = openStore(file);
  try {
    assert.equal(reopened.raw(row.id).state, 'working');
    assert.equal(reopened.summary().supplier_jobs_started, 1);
    reopened.recoverInterrupted(NOW + 100);
    assert.equal(reopened.get(row.id, row.token).state, 'interrupted');
  } finally { reopened.close(); }
});

test('results expire after seven days while paid ledger and nonce reservation persist', t => {
  const { store } = fixture(t);
  const row = ready(store); store.claimSettlement(row.id, NOW + 2);
  const transaction_hash = TX();
  store.recordTransaction(row.id, { transaction_hash }); store.markPaid(row.id, { transaction_hash });
  const expiry = NOW + 1 + RESULT_RETENTION_MS;
  assert.deepEqual(store.get(row.id, row.token, expiry - 1).result_json, BLOCK);
  assert.equal(store.get(row.id, row.token, expiry).result_json, null);
  assert.equal(store.get(row.id, row.token, expiry).result_expired, true);
  assert.equal(store.purgeExpiredResults(expiry), 1);
  assert.equal(store.raw(row.id, expiry).state, 'paid');
  assert.equal(store.raw(row.id, expiry).transaction_hash, transaction_hash);
  assert.equal(store.summary().gross_receipts_micros, 500000);
  assert.equal(store.summary().supplier_reserved_micros, 150000);
});

test('an expired result is never charged', t => {
  const { store } = fixture(t);
  const row = ready(store, { valid_before: String(Math.floor(NOW / 1000) + 864000) });
  assert.throws(() => store.claimSettlement(row.id, NOW + 1 + RESULT_RETENTION_MS), code('result_expired'));
  assert.equal(store.raw(row.id).state, 'result_ready');
});

test('summary has no customer tokens, inputs, wallet addresses or transaction hashes', t => {
  const { store } = fixture(t);
  const row = quote(store); store.claimWork(row.id, auth());
  const summary = JSON.stringify(store.summary());
  for (const privateValue of [row.token, row.token_hash, row.request_hash, PAYER, row.id, 'example', 'agent_challenge']) assert.equal(summary.includes(privateValue), false);
});

test('active quote cap survives restart but expires without a permanent discovery lockout', t => {
  const { store, file } = fixture(t);
  const first = quote(store);
  for (let i = 1; i < 1000; i++) quote(store);
  assert.throws(() => quote(store), code('quote_capacity_exhausted'));
  assert.equal(store.create({ token: first.token, request: REQUEST, now: NOW + 1000 }).id, first.id);
  store.close();
  const reopened = openStore(file);
  try {
    assert.throws(() => quote(reopened), code('quote_capacity_exhausted'));
    assert.equal(reopened.summary().counts.quoted, 1000);
    // A matching or conflicting receipt is resolved before collecting rows.
    const afterExpiry = NOW + QUOTE_TTL_MS;
    assert.equal(reopened.create({ token: first.token, request: REQUEST, now: afterExpiry }).id, first.id);
    assert.throws(() => reopened.create({ token: first.token, request: { changed: true }, now: afterExpiry }), code('token_conflict'));
    assert.equal(reopened.summary().counts.quoted, 1000);
    const fresh = reopened.create({ token: TOKEN(), request: REQUEST, now: afterExpiry });
    assert.equal(fresh.state, 'quoted');
    assert.equal(fresh.created, afterExpiry);
    assert.equal(reopened.summary().counts.quoted, 1);
    assert.equal(reopened.raw(first.id), null);
  } finally { reopened.close(); }
});

test('expired discovery collection preserves every started state and replay reservation', t => {
  const { store } = fixture(t);
  const failed = quote(store); store.claimWork(failed.id, auth()); store.failWork(failed.id, 'supplier_failed', NOW);
  const interrupted = quote(store); store.claimWork(interrupted.id, auth()); store.recoverInterrupted(NOW);
  const resultReady = ready(store);
  const settling = ready(store); store.claimSettlement(settling.id, NOW + 2);
  const paid = ready(store); store.claimSettlement(paid.id, NOW + 2);
  const transaction_hash = TX(); store.recordTransaction(paid.id, { transaction_hash }); store.markPaid(paid.id, { transaction_hash });
  const working = quote(store); store.claimWork(working.id, auth());
  const started = [failed, interrupted, resultReady, settling, paid, working].map(row => store.raw(row.id));
  const untouchedBudget = store.summary().supplier_reserved_micros;
  const untouchedJobs = store.summary().supplier_jobs_started;
  const expired = quote(store);
  const afterExpiry = NOW + QUOTE_TTL_MS;
  assert.throws(() => store.claimWork(expired.id, auth({ now: afterExpiry, valid_before: String(Math.floor(NOW / 1000) + 3600) })), code('quote_expired'));
  const neverStarted = quote(store);
  const fresh = store.create({ token: TOKEN(), request: REQUEST, now: afterExpiry });
  assert.equal(store.raw(expired.id), null);
  assert.equal(store.raw(neverStarted.id), null);
  for (const row of started) {
    const retained = store.raw(row.id);
    assert.equal(retained.state, row.state);
    assert.equal(retained.payer, row.payer);
    assert.equal(retained.nonce, row.nonce);
    assert.equal(retained.reserved_micros, row.reserved_micros);
  }
  assert.equal(store.summary().supplier_reserved_micros, untouchedBudget);
  assert.equal(store.summary().supplier_jobs_started, untouchedJobs);
  assert.equal(store.summary().gross_receipts_micros, 500000);
  assert.throws(() => store.claimWork(fresh.id, auth({
    payer: started[0].payer, nonce: started[0].nonce, now: afterExpiry,
    valid_before: String(Math.floor(NOW / 1000) + 3600),
  })), code('authorization_reused'));
});

test('the database refuses a symlink target', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rb-symlink-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'target'); writeFileSync(target, 'untouched');
  const file = join(directory, 'linked'); symlinkSync(target, file);
  assert.throws(() => openStore(file));
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

function runChild(file, id, authorization) {
  const storeURL = pathToFileURL(new URL('./store.mjs', import.meta.url).pathname).href;
  const source = `import {openStore} from ${JSON.stringify(storeURL)};const s=openStore(process.argv[1]);try{s.claimWork(process.argv[2],JSON.parse(process.argv[3]));process.stdout.write('claimed')}catch(e){process.stdout.write(e.code||'unexpected')}s.close();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, file, id, JSON.stringify(authorization)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', part => { output += part; });
    child.stderr.on('data', part => { errors += part; });
    child.on('error', reject);
    child.on('exit', status => status === 0 ? resolve(output) : reject(new Error(errors)));
  });
}

test('independent processes race to claim one worker and only one reserves budget', async t => {
  const { store, file } = fixture(t);
  const a = quote(store); const b = quote(store);
  const outcomes = await Promise.all([runChild(file, a.id, auth()), runChild(file, b.id, auth())]);
  assert.deepEqual(outcomes.sort(), ['claimed', 'worker_busy']);
  assert.equal(store.summary().supplier_jobs_started, 1);
  assert.equal(store.summary().supplier_reserved_micros, 150000);
});

test('independent processes cannot claim the same order twice', async t => {
  const { store, file } = fixture(t);
  const row = quote(store); const authorization = auth();
  const outcomes = await Promise.all([runChild(file, row.id, authorization), runChild(file, row.id, authorization)]);
  assert.deepEqual(outcomes.sort(), ['claimed', 'invalid_state']);
  assert.equal(store.summary().supplier_jobs_started, 1);
});

test('abrupt process exit after work claim retains WAL commit for recovery', t => {
  const { store, file } = fixture(t);
  const row = quote(store);
  const source = `import {openStore} from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)};const s=openStore(process.argv[1]);s.claimWork(process.argv[2],JSON.parse(process.argv[3]));process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, file, row.id, JSON.stringify(auth())], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(store.raw(row.id).state, 'working');
  assert.equal(store.recoverInterrupted(NOW + 100), 1);
  assert.equal(store.raw(row.id).state, 'interrupted');
  assert.equal(store.summary().supplier_reserved_micros, 150000);
});
