import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PRICE_MICROS = 500_000;
export const SUPPLIER_RESERVE_MICROS = 150_000;
export const MAX_SUPPLIER_JOBS = 10;
export const MAX_ACTIVE_QUOTES = 1000;
export const LIFETIME_SUPPLIER_BUDGET_MICROS = 1_500_000;
export const QUOTE_TTL_MS = 10 * 60 * 1000;
export const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class StoreError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (code, status) => { throw new StoreError(code, status); };
const timestamp = (now = Date.now()) => {
  if (!Number.isSafeInteger(now) || now < 0) fail('invalid_time', 400);
  return now;
};
const tokenHash = token => {
  if (typeof token !== 'string' || !/^[a-fA-F0-9]{64}$/.test(token)) fail('invalid_token', 400);
  return sha256(Buffer.from(token, 'hex'));
};
const transactionHash = value => {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(value)) fail('invalid_transaction', 400);
  return value.toLowerCase();
};

function canonical(value, depth = 0) {
  if (depth > 20) fail('invalid_request', 400);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  }
  fail('invalid_request', 400);
}

function authorization({ payer, nonce, valid_before, from_block }) {
  if (typeof payer !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(payer)
      || typeof nonce !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(nonce)) fail('invalid_authorization', 400);
  let before;
  let block;
  try {
    if (!['string', 'number', 'bigint'].includes(typeof valid_before)
        || !/^\d{1,78}$/.test(String(valid_before))
        || (typeof valid_before === 'number' && !Number.isSafeInteger(valid_before))) throw new Error();
    before = BigInt(valid_before);
    if (before < 1n || before >= 2n ** 256n) throw new Error();
    if (!['string', 'number', 'bigint'].includes(typeof from_block)
        || !/^(0x[0-9a-fA-F]+|\d+)$/.test(String(from_block))
        || (typeof from_block === 'number' && !Number.isSafeInteger(from_block))) throw new Error();
    block = BigInt(from_block);
    if (block < 0n || block > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
  } catch { fail('invalid_authorization', 400); }
  return { payer: payer.toLowerCase(), nonce: nonce.toLowerCase(), valid_before: String(before), from_block: Number(block) };
}

/** Private, synchronous SQLite ledger. Never give the caller direct SQL access. */
export function openStore(file) {
  if (typeof file !== 'string' || !file) fail('invalid_store_path', 500);
  if (file !== ':memory:') {
    file = resolve(file);
    const parent = dirname(file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink()) fail('unsafe_store_path', 500);
    chmodSync(parent, 0o700);
    // O_NOFOLLOW prevents substituting a symlink for the private ledger.
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      source TEXT,
      amount INTEGER NOT NULL CHECK(amount = 500000),
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('quoted','working','result_ready','settling','paid','research_failed','interrupted','expired')),
      payer TEXT,
      nonce TEXT,
      valid_before TEXT,
      from_block INTEGER,
      result_json TEXT,
      usage_json TEXT,
      result_expires INTEGER,
      transaction_hash TEXT,
      started INTEGER,
      paid_at INTEGER,
      error_code TEXT,
      reserved_micros INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS authorization_once ON orders(payer,nonce) WHERE nonce IS NOT NULL;
    CREATE INDEX IF NOT EXISTS orders_state ON orders(state);
    CREATE TABLE IF NOT EXISTS lifetime_budget (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      supplier_jobs INTEGER NOT NULL DEFAULT 0,
      reserved_micros INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO lifetime_budget(id) VALUES(1);
  `);
  const read = db.prepare('SELECT * FROM orders WHERE id = ?');
  const need = id => read.get(id) || fail('not_found', 404);
  const decode = (row, now = Date.now()) => {
    if (!row) return null;
    const resultExpired = row.result_expires !== null && row.result_expires <= now;
    return {
      ...row,
      request_json: JSON.parse(row.request_json),
      result_json: row.result_json && !resultExpired ? JSON.parse(row.result_json) : null,
      usage_json: row.usage_json ? JSON.parse(row.usage_json) : null,
      result_expired: resultExpired,
    };
  };
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    let result;
    try { result = fn(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    // Returning an error allows an expiry transition to commit before rejection.
    if (result instanceof Error) throw result;
    return result;
  };
  const requireState = (row, state) => { if (row.state !== state) fail('invalid_state'); };

  return {
    create({ token, request, amount = PRICE_MICROS, now = Date.now() }) {
      now = timestamp(now);
      const hash = tokenHash(token);
      if (amount !== PRICE_MICROS) fail('invalid_amount', 400);
      if (!request || typeof request !== 'object' || Array.isArray(request)) fail('invalid_request', 400);
      const body = canonical(request);
      if (Buffer.byteLength(body) > 65536) fail('invalid_request', 400);
      const requestHash = sha256(body);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM orders WHERE token_hash = ?').get(hash);
        if (existing) {
          if (existing.request_hash !== requestHash || existing.amount !== amount) fail('token_conflict');
          return decode(existing, now);
        }
        // Expired discovery-only quotes must not permanently exhaust capacity.
        // The existing-token lookup above preserves a still-present quote's
        // idempotent response, even after expiry. Never collect started orders,
        // reserved supplier work, or any record bound to an authorization.
        db.prepare(`DELETE FROM orders WHERE state IN ('quoted','expired')
          AND expires<=? AND started IS NULL AND reserved_micros=0
          AND payer IS NULL AND nonce IS NULL AND transaction_hash IS NULL
          AND paid_at IS NULL AND result_json IS NULL`).run(now);
        if (db.prepare("SELECT COUNT(*) AS count FROM orders WHERE started IS NULL AND state IN ('quoted','expired')").get().count >= MAX_ACTIVE_QUOTES) {
          fail('quote_capacity_exhausted', 503);
        }
        const id = randomUUID();
        const source = typeof request.source === 'string' ? request.source.slice(0, 120) : null;
        db.prepare(`INSERT INTO orders(id,token_hash,request_hash,request_json,source,amount,created,expires,state)
          VALUES(?,?,?,?,?,?,?,?,'quoted')`).run(id, hash, requestHash, body, source, amount, now, now + QUOTE_TTL_MS);
        return decode(need(id), now);
      });
    },
    get(id, token, now = Date.now()) {
      now = timestamp(now);
      let hash;
      try { hash = tokenHash(token); } catch { return null; }
      const row = read.get(id);
      if (!row || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) return null;
      return decode(row, now);
    },
    raw(id, now = Date.now()) { return decode(read.get(id), timestamp(now)); },
    claimWork(id, { payer, nonce, valid_before, from_block, now = Date.now() }) {
      now = timestamp(now);
      const auth = authorization({ payer, nonce, valid_before, from_block });
      if (BigInt(auth.valid_before) <= BigInt(Math.floor(now / 1000))) fail('authorization_expired', 402);
      return transaction(() => {
        const row = need(id);
        requireState(row, 'quoted');
        if (row.expires <= now) {
          db.prepare("UPDATE orders SET state='expired',error_code='quote_expired' WHERE id=?").run(id);
          return new StoreError('quote_expired', 410);
        }
        if (db.prepare('SELECT id FROM orders WHERE payer=? AND nonce=?').get(auth.payer, auth.nonce)) fail('authorization_reused');
        const budget = db.prepare('SELECT * FROM lifetime_budget WHERE id=1').get();
        if (budget.supplier_jobs >= MAX_SUPPLIER_JOBS
            || budget.reserved_micros + SUPPLIER_RESERVE_MICROS > LIFETIME_SUPPLIER_BUDGET_MICROS) fail('budget_exhausted', 503);
        if (db.prepare("SELECT id FROM orders WHERE state='working' LIMIT 1").get()) fail('worker_busy', 429);
        db.prepare("UPDATE orders SET state='working',payer=?,nonce=?,valid_before=?,from_block=?,started=?,reserved_micros=? WHERE id=?")
          .run(auth.payer, auth.nonce, auth.valid_before, auth.from_block, now, SUPPLIER_RESERVE_MICROS, id);
        db.prepare('UPDATE lifetime_budget SET supplier_jobs=supplier_jobs+1,reserved_micros=reserved_micros+? WHERE id=1')
          .run(SUPPLIER_RESERVE_MICROS);
        return decode(need(id), now);
      });
    },
    saveResult(id, { block, usage, now = Date.now() }) {
      now = timestamp(now);
      if (!block || typeof block !== 'object' || Array.isArray(block)) fail('invalid_result', 400);
      const result = canonical(block);
      const usageJSON = canonical(usage ?? {});
      if (Buffer.byteLength(result) > 2_000_000 || Buffer.byteLength(usageJSON) > 65536) fail('invalid_result', 400);
      return transaction(() => {
        requireState(need(id), 'working');
        db.prepare("UPDATE orders SET state='result_ready',result_json=?,usage_json=?,result_expires=?,error_code=NULL WHERE id=?")
          .run(result, usageJSON, now + RESULT_RETENTION_MS, id);
        return decode(need(id), now);
      });
    },
    failWork(id, code, now = Date.now()) {
      now = timestamp(now);
      if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(code)) fail('invalid_error_code', 400);
      return transaction(() => {
        requireState(need(id), 'working');
        db.prepare("UPDATE orders SET state='research_failed',error_code=? WHERE id=?").run(code, id);
        return decode(need(id), now);
      });
    },
    claimSettlement(id, now = Date.now()) {
      now = timestamp(now);
      return transaction(() => {
        const row = need(id);
        requireState(row, 'result_ready');
        if (!row.result_json || row.result_expires <= now) fail('result_expired', 410);
        if (BigInt(row.valid_before) <= BigInt(Math.floor(now / 1000))) fail('authorization_expired', 402);
        db.prepare("UPDATE orders SET state='settling' WHERE id=?").run(id);
        return decode(need(id), now);
      });
    },
    recordTransaction(id, { transaction_hash, now = Date.now() }) {
      now = timestamp(now);
      const tx = transactionHash(transaction_hash);
      return transaction(() => {
        const row = need(id);
        if (!['settling', 'paid'].includes(row.state)) fail('invalid_state');
        if (row.transaction_hash && row.transaction_hash !== tx) fail('transaction_conflict');
        if (!row.transaction_hash) db.prepare('UPDATE orders SET transaction_hash=? WHERE id=?').run(tx, id);
        return decode(need(id), now);
      });
    },
    markPaid(id, { transaction_hash, now = Date.now() }) {
      now = timestamp(now);
      const tx = transactionHash(transaction_hash);
      return transaction(() => {
        const row = need(id);
        if (row.transaction_hash !== tx) fail('transaction_not_recorded');
        if (row.state === 'paid') return decode(row, now);
        requireState(row, 'settling');
        db.prepare("UPDATE orders SET state='paid',paid_at=?,error_code=NULL WHERE id=?").run(now, id);
        return decode(need(id), now);
      });
    },
    recoverInterrupted(now = Date.now()) {
      timestamp(now);
      return transaction(() => Number(db.prepare("UPDATE orders SET state='interrupted',error_code='process_interrupted' WHERE state='working'").run().changes));
    },
    purgeExpiredResults(now = Date.now()) {
      now = timestamp(now);
      return transaction(() => Number(db.prepare('UPDATE orders SET result_json=NULL WHERE result_json IS NOT NULL AND result_expires<=?').run(now).changes));
    },
    summary() {
      const counts = {};
      for (const row of db.prepare('SELECT state,COUNT(*) AS count FROM orders GROUP BY state').all()) counts[row.state] = row.count;
      const budget = db.prepare('SELECT supplier_jobs,reserved_micros FROM lifetime_budget WHERE id=1').get();
      const paid = db.prepare("SELECT COUNT(*) AS orders,COALESCE(SUM(amount),0) AS gross_receipts_micros FROM orders WHERE state='paid'").get();
      return { counts, supplier_jobs_started: budget.supplier_jobs, supplier_reserved_micros: budget.reserved_micros,
        supplier_jobs_remaining: Math.max(0, MAX_SUPPLIER_JOBS - budget.supplier_jobs),
        budget_remaining_micros: Math.max(0, LIFETIME_SUPPLIER_BUDGET_MICROS - budget.reserved_micros),
        supplier_budget_remaining_micros: Math.max(0, LIFETIME_SUPPLIER_BUDGET_MICROS - budget.reserved_micros),
        confirmed_paid_orders: paid.orders, gross_receipts_micros: paid.gross_receipts_micros };
    },
    close() { db.close(); },
  };
}
