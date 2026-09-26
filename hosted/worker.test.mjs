import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, validateRequest, workerPolicy, WorkerError } from './worker.mjs';

const request = () => ({
  candidates: [
    { id: 'alpha', label: 'Alpha API', official_domains: ['alpha.example'] },
    { id: 'beta', label: 'Beta API', official_domains: ['beta.example'] },
  ],
  criteria: [{ id: 'price', question: 'Current usage price?' }, { id: 'limit', question: 'Upload limit?' }],
  max_age_hours: 24, max_cost_usd: '0.50',
});
const cell = (candidate, criterion, changes = {}) => ({
  candidate, criterion, value: criterion === 'price' ? '0.01' : 100,
  unit: criterion === 'price' ? 'request' : 'MiB', currency: criterion === 'price' ? 'USD' : null,
  billing_basis: criterion === 'price' ? 'per request' : null,
  scope: { plan: 'standard', version: null, region: null }, evidence_status: 'supported',
  sources: [{ url: `https://${candidate}.example/docs`, excerpt: criterion === 'price' ? 'Each request costs USD 0.01.' : 'The upload limit is 100 MiB.' }],
  reason: 'The official documentation states this limit.', ...changes,
});
const response = () => ({
  id: 'resp_fixture_only', status: 'completed', model: workerPolicy.model,
  output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
      { type: 'url', url: 'https://alpha.example/docs' }, { type: 'url', url: 'https://beta.example/docs' },
    ] } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
      cells: ['alpha', 'beta'].flatMap(candidate => ['price', 'limit'].map(criterion => cell(candidate, criterion))),
    }), annotations: [] }] },
  ],
  usage: { input_tokens: 1500, output_tokens: 800, total_tokens: 2300 },
});
const mutateCells = (data, mutator) => {
  const part = data.output.find(item => item.type === 'message').content[0];
  const payload = JSON.parse(part.text);
  mutator(payload.cells, payload);
  part.text = JSON.stringify(payload);
  return data;
};
function fixtureWorker(data = response()) {
  const calls = [];
  const worker = createWorker({ apiKey: 'sk-test-fixture-not-a-real-key' }, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { worker, calls };
}
const rejectsCode = (operation, code) => assert.rejects(operation, error => {
  assert.ok(error instanceof WorkerError);
  assert.equal(error.code, code);
  assert.equal(error.billable, false);
  assert.equal(error.retryable, false);
  return true;
});

test('request contract normalizes money/domains and does not mutate caller input', () => {
  const input = request();
  input.candidates[0].official_domains[0] = 'ALPHA.EXAMPLE';
  const before = structuredClone(input);
  const normalized = validateRequest(input);
  assert.equal(normalized.max_cost_usd, '0.5');
  assert.equal(normalized.candidates[0].official_domains[0], 'alpha.example');
  assert.deepEqual(input, before);
});

test('hosted request rejects extra controls, unsafe domains, invalid shapes and excess bytes', () => {
  const cases = [
    value => { value.model = 'other-model'; },
    value => { value.candidates[0].official_domains = ['127.0.0.1']; },
    value => { value.candidates[0].official_domains = ['secret.internal']; },
    value => { value.candidates[0].official_domains = ['https://alpha.example']; },
    value => { value.candidates[0].official_domains = ['alpha.example', 'ALPHA.EXAMPLE']; },
    value => { value.candidates[1].id = 'alpha'; },
    value => { value.criteria[1].id = 'price'; },
    value => { value.max_cost_usd = 0.5; },
    value => { value.max_cost_usd = '1000.00000001'; },
    value => { value.max_age_hours = true; },
    value => { value.max_age_hours = Infinity; },
    value => { value.criteria[0].question = '\0 hidden'; },
    value => { value.criteria = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: '😀'.repeat(500) })); value.candidates.forEach(item => { item.official_domains = Array.from({ length: 10 }, (_, i) => `${'a'.repeat(60)}.${'b'.repeat(60)}.${i}.example`); }); },
  ];
  for (const mutate of cases) {
    const input = request(); mutate(input);
    assert.throws(() => validateRequest(input), error => error.code === 'invalid_request');
  }
});

test('unconfigured and invalid requests never make supplier calls', async () => {
  let calls = 0;
  const worker = createWorker({}, async () => { calls++; throw new Error('must not call'); });
  assert.equal(worker.configured, false);
  await rejectsCode(() => worker.run(request()), 'worker_unconfigured');
  await rejectsCode(() => worker.run({ ...request(), model: 'injected' }), 'invalid_request');
  assert.equal(calls, 0);
});

test('one bounded supplier request returns a complete ordered block with honest provenance', async () => {
  const { worker, calls } = fixtureWorker();
  const result = await worker.run(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.redirect, 'error');
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.model, 'gpt-4.1-mini-2025-04-14');
  assert.equal(sent.max_tool_calls, 3);
  assert.equal(sent.max_output_tokens, 4096);
  assert.equal(sent.store, false);
  assert.equal(sent.background, false);
  assert.equal(sent.tool_choice, 'required');
  assert.deepEqual(sent.include, ['web_search_call.action.sources']);
  assert.deepEqual(sent.tools, [{ type: 'web_search', search_context_size: 'low', external_web_access: true, filters: { allowed_domains: ['alpha.example', 'beta.example'] } }]);
  assert.equal(sent.text.format.strict, true);
  assert.equal(sent.text.format.schema.additionalProperties, false);
  assert.equal(result.block.schema_version, '1.0');
  assert.equal(result.block.provenance.provider, 'openai');
  assert.equal(result.block.provenance.actual_cost_usd, null);
  assert.equal(result.block.provenance.is_demo, false);
  assert.equal(result.estimated_cost_usd, '0.01508');
  assert.equal(result.usage.web_search_calls, 1);
  assert.equal(result.usage.actual_cost_usd, null);
  assert.equal(result.block.cells.length, 4);
  for (const item of result.block.cells) {
    assert.equal(item.evidence_status, 'unverified');
    assert.equal(item.sources[0].retrieved_at, null);
    assert.match(item.reason, /not independently verified/);
  }
  assert.equal(result.block.cells[0].billing_basis, 'per request');
  assert.equal(result.block.cells[0].currency, 'USD');
  assert.equal(result.block.cells[0].scope.plan, 'standard');
  assert.equal(result.block.cells[0].scope.version, null);
  assert.ok(!JSON.stringify(result).includes('sk-test-fixture'));
});

test('model output cannot invent a same-domain URL or borrow another candidate evidence', async () => {
  for (const url of ['https://alpha.example/invented', 'https://beta.example/docs', 'http://alpha.example/docs', 'https://alpha.example.evil.org/docs', 'https://user:secret@alpha.example/docs']) {
    const data = mutateCells(response(), cells => { cells[0].sources[0].url = url; });
    const { worker } = fixtureWorker(data);
    await rejectsCode(() => worker.run(request()), 'evidence_invalid');
  }
});

test('provider URL citation metadata can authorize a source, without trusting dates or model metadata', async () => {
  const data = response();
  data.output[0].action.sources = [];
  data.output[1].content[0].annotations = ['alpha', 'beta'].map(candidate => ({ type: 'url_citation', url: `https://${candidate}.example/docs`, title: 'Official docs', start_index: 0, end_index: 1 }));
  const { worker } = fixtureWorker(data);
  assert.equal((await worker.run(request())).block.cells.length, 4);
  mutateCells(data, cells => { cells[0].sources[0].retrieved_at = '2026-09-26T15:00:00Z'; });
  await rejectsCode(() => fixtureWorker(data).worker.run(request()), 'evidence_invalid');
});

test('missing matrix rows, duplicate cells, extra fields and malformed units fail closed', async () => {
  const mutations = [
    cells => cells.pop(),
    cells => { cells[1] = structuredClone(cells[0]); },
    cells => { cells[0].payment_instructions = 'send more'; },
    cells => { cells[0].scope = { plan: 'standard', region: null }; },
    cells => { cells[0].currency = 'usd'; },
    cells => { cells[0].value = { guessed: 'price' }; },
    cells => { cells[0].value = 1e16; },
    cells => { cells[0].sources = []; },
    cells => { cells[0].sources.push(structuredClone(cells[0].sources[0])); },
    cells => { cells[0].evidence_status = 'not_found'; },
  ];
  for (const mutate of mutations) {
    await rejectsCode(() => fixtureWorker(mutateCells(response(), mutate)).worker.run(request()), 'evidence_invalid');
  }
});

test('at least half the matrix and one cited answer per candidate are needed to deliver', async () => {
  const unknown = item => Object.assign(item, { value: null, sources: [], evidence_status: 'not_found', reason: 'No matching fact found.' });
  const half = mutateCells(response(), cells => { unknown(cells[1]); unknown(cells[3]); });
  const result = await fixtureWorker(half).worker.run(request());
  assert.equal(result.block.cells[1].evidence_status, 'not_found');
  assert.match(result.block.cells[1].reason, /not proof of absence/);
  const tooFew = mutateCells(response(), cells => { cells.slice(1).forEach(unknown); });
  await rejectsCode(() => fixtureWorker(tooFew).worker.run(request()), 'insufficient_evidence');
  const oneCandidateOnly = mutateCells(response(), cells => { cells.slice(2).forEach(unknown); });
  await rejectsCode(() => fixtureWorker(oneCandidateOnly).worker.run(request()), 'insufficient_evidence');
  const placeholders = mutateCells(response(), cells => { cells.slice(2).forEach(item => { item.value = 'Unknown'; }); });
  await rejectsCode(() => fixtureWorker(placeholders).worker.run(request()), 'insufficient_evidence');
});

test('conflicts keep their warning and are not counted as answered findings', async () => {
  const data = mutateCells(response(), cells => {
    cells[1].evidence_status = 'conflicting';
    cells[1].sources.push({ url: 'https://alpha.example/other', excerpt: 'Another limit is given here.' });
  });
  data.output[0].action.sources.push({ type: 'url', url: 'https://alpha.example/other' });
  const result = await fixtureWorker(data).worker.run(request());
  assert.equal(result.block.cells[1].evidence_status, 'unverified');
  assert.match(result.block.cells[1].reason, /conflicting/);
  mutateCells(data, cells => { cells[0].evidence_status = 'stale'; });
  await rejectsCode(() => fixtureWorker(data).worker.run(request()), 'insufficient_evidence');
});

test('completed response requires actual bounded web tool activity and a pinned model', async () => {
  const cases = [
    data => { data.output.shift(); },
    data => { data.output.unshift(...Array.from({ length: 3 }, () => structuredClone(data.output[0]))); },
    data => { data.model = 'gpt-4.1'; },
    data => { data.output[0].type = 'function_call'; },
    data => { data.output[0].action.sources = [{ url: 'https://evil.example/docs' }]; },
    data => { data.output[1].content[0].text = 'not json'; },
  ];
  for (const mutate of cases) {
    const data = response(); mutate(data);
    await rejectsCode(() => fixtureWorker(data).worker.run(request()), 'provider_response_invalid');
  }
});

test('incomplete results and refusals never become billable blocks', async () => {
  const incomplete = response(); incomplete.status = 'incomplete';
  await rejectsCode(() => fixtureWorker(incomplete).worker.run(request()), 'provider_incomplete');
  const refusal = response(); refusal.output[1].content = [{ type: 'refusal', refusal: 'Untrusted free text' }];
  await rejectsCode(() => fixtureWorker(refusal).worker.run(request()), 'provider_refused');
});

test('usage is required, budget checked, and actual billed cost never fabricated', async () => {
  for (const mutate of [
    data => { delete data.usage; },
    data => { data.usage.input_tokens = -1; },
    data => { data.usage.total_tokens = 9999; },
    data => { data.usage.output_tokens = 4097; data.usage.total_tokens = 5597; },
  ]) {
    const data = response(); mutate(data);
    await rejectsCode(() => fixtureWorker(data).worker.run(request()), 'provider_response_invalid');
  }
  const over = response(); over.usage = { input_tokens: 400000, output_tokens: 800, total_tokens: 400800 };
  await rejectsCode(() => fixtureWorker(over).worker.run(request()), 'supplier_budget_exceeded');
});

test('supplier transport failure is sanitized and submitted exactly once', async () => {
  let count = 0;
  const worker = createWorker({ apiKey: 'sk-test-secret-sensitive' }, async () => {
    count++;
    throw new Error('sk-test-secret-sensitive caller private question raw provider body');
  });
  await assert.rejects(() => worker.run(request()), error => {
    assert.equal(error.code, 'provider_transport_unknown');
    assert.equal(error.supplierAttempted, true);
    assert.equal(error.retryable, false);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('secret-sensitive'));
    assert.ok(!error.message.includes('private question'));
    return true;
  });
  assert.equal(count, 1);
});

test('HTTP failures never expose provider bodies or retry', async () => {
  let count = 0;
  const worker = createWorker({ apiKey: 'sk-test-secret-sensitive' }, async () => {
    count++;
    return new Response('sensitive provider error text', { status: 429 });
  });
  await rejectsCode(() => worker.run(request()), 'provider_http_error');
  assert.equal(count, 1);
});

test('declared and streamed oversized responses are rejected before parsing', async () => {
  for (const build of [
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(workerPolicy.max_response_bytes + 1) } }),
    () => new Response('x'.repeat(workerPolicy.max_response_bytes + 1), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
  ]) {
    const worker = createWorker({ apiKey: 'sk-test-fixture-not-real' }, async () => build());
    await rejectsCode(() => worker.run(request()), 'provider_response_invalid');
  }
});

test('deadline aborts an ambiguous request without starting a second attempt', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  let signal;
  const worker = createWorker({ apiKey: 'sk-test-fixture-not-real' }, async (_url, options) => {
    count++; signal = options.signal;
    return new Promise(() => {});
  });
  const pending = worker.run(request());
  const checked = rejectsCode(() => pending, 'provider_timeout_unknown');
  context.mock.timers.tick(workerPolicy.deadline_ms);
  await checked;
  assert.equal(count, 1);
  assert.equal(signal.aborted, true);
});
