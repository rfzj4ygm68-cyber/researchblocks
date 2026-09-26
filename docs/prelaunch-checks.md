# Candidate reliability fixes

26 September 2026. Base public commit: `5ef089a4dfe653da81666baf008ca24fd7f0c3da`.

Two moderate reliability defects were reproduced offline against the public alpha:

1. A delayed status response could replace a completed or failed job with `running`, and a delayed polling error could attach a transient error to an already completed job. Sequential stale responses could also move `running` back to `pending`.
2. Completed output rejected for off-domain evidence was classified as temporarily unavailable. Each result retry repeated the provider GET; the durable row remained `completed` with no error and no usable block.

The local patch uses conditional database updates and preserves forward progress. Invalid completed output now has a typed error and durable `result_invalid` state. Retrieval stops for that state; the existing idempotency key still returns the same job. Transient transport errors can recover by retrieving the original result without another submission.

Verification: 80 tests passed, comprising the existing 76 checks and four new regression tests. The new tests fail against the public base with five failed assertions/subtests, while the transport-recovery guard passes there. The races use controlled threads and events; provider requests use injected mock transport only. No external provider request, real charge, payment settlement, wallet operation, or deployment was performed.

These changes are saved on the hosted-service-prelaunch source branch and have not been released as a wheel or installed skill update. Before any later release, synchronize the two changed runtime modules (`engine.py`, `providers.py`) into the bundled repository skill and the managed personal skill through its normal update workflow; rebuild the distribution wheel; bump release metadata; and verify distribution contents. Those copies deliberately remain unchanged during this review.

Passing offline software checks does not establish hosted service readiness, factual research quality, paid delivery, settlement, or profitability. The existing alpha has no ResearchBlocks merchant payment endpoint or wallet settlement integration.
