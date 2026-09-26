# ResearchBlocks hosted service — prelaunch

This is the paid-service implementation, **not an active checkout or announcement of launch**. No production service URL or successful live payment exists for this version. Keep both enablement flags false until the activation checks below pass.

An agent submits up to three named technical vendors and five questions. Research runs in the background while the parent continues. A private receipt retrieves the structured comparison. The planned price is **0.50 USDC per accepted block**, paid into the existing receiver on Base; this price is a prelaunch setting, not evidence of demand or profitability.

## What counts as delivery

The worker must return exactly one cell for every candidate/question, retain units, scope and explicit unknowns, cite allowed official domains, and use URLs actually present in the supplier's source/citation metadata. At least half the cells and one cell per candidate must contain a non-null cited finding. Missing or inadequate output fails without customer settlement.

Findings and excerpts are model-generated and remain `unverified`. Source retrieval timestamps are unavailable; a requested `max_age_hours` does not turn unknown timestamps into fresh evidence. URL membership checks do not independently prove quotations or facts. Parents should verify material decisions. No synthetic fallback can become a billed result.

## Payment and recovery

1. The client writes a private 32-byte receipt token before creating a quote. Retrying the same token and request recovers the same quote; changing the request conflicts.
2. An existing authorized EOA signer supplies one exact USDC EIP-3009 authorization. No wallet private key is loaded by this package. Smart-contract wallets are not supported in this release.
3. The server verifies the authorization and atomically claims a unique payer/nonce and supplier reservation before work.
4. A validated result is saved durably **before** settlement is claimed. Failed research is not charged.
5. Settlement is attempted once. Lost acknowledgements are recovered with read-only Base transaction/authorization checks. Polling never requests another payment.
6. Result data is released after a canonical receipt with one successor block is observed. This is confirmation, not Base-to-Ethereum finality. Private result recovery lasts seven days from saving the result.

If a process stops while researching, that attempt becomes interrupted and is not automatically repeated or charged. If it stops after saving a result but before settlement, an explicit `resumeSavedAuthorization` can submit only the original persisted signature while it remains valid. An ambiguous settlement never returns to a chargeable state. Some unresolved/failed settlements require operator review; do not create a new authorization merely because a response was lost. `operator_review_required` flags long-unresolved settlements without declaring them paid or unpaid.

This receiver is shared with TaskMint, but the ledger is separate. The 0.50 USDC exact price does not overlap its currently documented jobs or annual prices. Recheck this constraint before either product adds a matching price; signatures do not encode a product/order identifier.

## Supplier and launch limits

The supplier is OpenAI Responses with the pinned `gpt-4.1-mini-2025-04-14` snapshot, official-domain web search, one HTTP submission, at most three tool calls, 4,096 output tokens and a 90-second local deadline. There are no automatic supplier retries. The hosted owner supplies the API connection; buyers do not need a research-provider account.

Ten supplier attempts maximum, one active worker, and a permanent **$0.15 accounting reservation per attempt** limit the initial pilot. Failed or ambiguous attempts retain reservations. The $1.50 aggregate reservation is **not a provider-enforced dollar cap** or an invoice. Pricing estimates can overcount search tokens and exclude hosting, settlement fees, tax and failed-collection risk. Verification is not escrow: a buyer may cancel or spend its balance before settlement, leaving the supplier cost unpaid. No automatic top-ups, withdrawals or refunds are implemented. These limits deliberately require review before expanding the pilot.

Published model rates checked 26 September 2026: $0.40/M input, $1.60/M output, $0.01/search, with 8,000 input tokens/search for this model. Measure actual successful and failed jobs before claiming a margin.

## Run locally

Node 22.13+ is required for SQLite. These commands install known public packages and run offline tests:

```sh
cd hosted
npm ci --ignore-scripts
npm test
```

The default database is `/data/researchblocks.sqlite`; use a private temporary location for development. With no credentials and no enablement flags, the server starts with checkout unavailable. `node preflight.mjs` reports missing variable names and, when credentials exist, performs only an authenticated CDP capability GET. It never performs research or moves funds.

Use `service.env.example` as a list of private configuration names. Never commit populated keys, receipt tokens, signatures or databases. The receiving wallet/network/token cannot be overridden by an environment variable or request. The operator summary requires a separate secret of at least 32 characters and exposes aggregate counts only.

## Agent integration

The HTTP contract is available at `/openapi.json`. `client.mjs` exposes `createQuote`, `execute`, `recover`, and `resumeSavedAuthorization`. Persist its receipt and sidecars on durable private storage. Supply your already-authorized signer; do not create an unfunded wallet or invent a signature.

```js
import {createQuote, execute, recover} from './client.mjs';

// origin must be the actual verified deployment URL once available.
await createQuote('./job.receipt.json', {origin, request, maxAmountUnits:500000});
await execute('./job.receipt.json', {signer, maxAmountUnits:500000});
// Continue the parent agent's other tasks, then poll this same receipt.
const job = await recover('./job.receipt.json');
if (job.state === 'paid') consume(job.result);
```

Quote creation, discovery and unsigned 402 challenges are free and are not sales. The Python local MCP tools remain the free/local workflow; they do not silently enable this paid HTTP client. Hosted blocks use provenance provider `openai`; importing them requires the matching updated validator.

## Activation gates

- A separate service with its own persistent `/data` volume, one active instance and no overlapping deployment using that volume. Stop/drain the previous instance before startup recovery. Do not transplant TaskMint's volume, encrypted vault or installation identity.
- A valid CDP API key ID/secret, authenticated `GET /platform/v2/x402/supported`, and the pinned existing receiving wallet. A wallet secret is unnecessary. TaskMint's old unused raw secret field is not a valid source.
- A funded OpenAI project key authorized for the pinned model and web search. No ChatGPT session token is used.
- One explicitly budgeted real supplier job: inspect output compatibility, actual evidence usefulness, timing and supplier usage. The synthetic tests cannot establish these.
- End-to-end payment compatibility and recovery verification before enabling the public paid route. Do not count a self-test, unsigned probe or synthetic fixture as customer revenue.
- Coordinated source/skill/wheel version handling: this source branch does not silently replace the existing public 0.1.0 release assets or managed skill runtime.

Production defaults remain disabled. Set `RESEARCHBLOCKS_LIVE_RESEARCH_VERIFIED=true` only after the recorded live check; then enable payments once hosting and payment gates have passed. Do not simply set flags to make readiness green.

## Sources

- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/guides/tools-web-search
- https://developers.openai.com/api/docs/pricing
- https://docs.cdp.coinbase.com/x402/seller/production-configuration
- https://docs.railway.com/pricing/plans
