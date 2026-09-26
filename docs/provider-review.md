# Parallel adapter review

Checked 26 September 2026 (Asia/Bangkok). This is a local, single-customer BYOK adapter in an alpha build. It has **not been live-tested**. All automated provider tests use explicit mock responses; no provider call, charge, factual-quality benchmark or integration certification occurred.

## Commercial conclusion

Parallel's [Customer Terms](https://parallel.ai/customer-terms), effective 11 August 2026, permit customer-application integration in §2(b), subject to primarily single-customer output use. Sections 2(c)(iv), (vi), (xii) restrict resale, data-selling businesses, competitive uses and diversion through prior outputs; §4(b) reinforces sharing restrictions. Section 2(c)(viii) requires prior written consent for published benchmarks/evaluations.

**Implementation decision:** local caller-funded integration, without shared output resale or cross-customer caching. Obtain supplier confirmation for the exact hosted workflow, retention and publication plans, or select suitable alternative terms before offering managed research. BYOK does not override the caller's agreement. This is a product decision from the wording, not a legal determination.

## Supplier cost

The [official pricing page](https://docs.parallel.ai/getting-started/pricing) lists core at **USD 25 per 1,000 successful Task Runs**, or **USD 0.025 per successful run**, regardless of field count. This adapter selects core exactly once per submission. The quote is a dated list-price estimate, not a receipt, a customer selling price, a promise of research quality, or a supplier-enforced spending cap. Actual cost remains null. Failed runs are described by the supplier as unbilled, but the adapter does not reconcile invoices. No automatic upgrade, follow-up task or POST retry is implemented. The engine also checks explicit paid opt-in and idempotency before submission.

## API contract and controls

- [Create Task Run](https://docs.parallel.ai/api-reference/tasks/create-task-run): authenticated POST `/v1/tasks/runs`, processor `core`; response includes a run ID. The adapter requests a JSON output schema and sends a source policy containing the union of candidate official domains.
- [Retrieve Task Run](https://docs.parallel.ai/api-reference/tasks/retrieve-task-run): GET `/v1/tasks/runs/{run_id}`. Queued maps to pending. Unsupported action-required state raises an explicit error; it is never silently treated as completion.
- [Retrieve Task Run Result](https://docs.parallel.ai/api-reference/tasks/retrieve-task-run-result): GET `/v1/tasks/runs/{run_id}/result?timeout=1`; reads completed matching run and `output.content`. Short server wait avoids holding the parent agent for a whole research job.
- [Task Spec](https://docs.parallel.ai/task-api/guides/specify-a-task): provider schema omits unsupported constraint keywords. Local validation imposes the actual matrix, field and citation limits.
- [Source Policy](https://docs.parallel.ai/resources/source-policy): official-domain restriction is sent to the provider; returned citations are independently checked against the correct candidate's allowed hosts by the local validator. This is domain validation, not verification of page contents.

Fixed HTTPS origin `api.parallel.ai`; default TLS certificate verification; redirects refused; environment proxy use disabled. Ten-second socket timeout and a read-loop deadline; one-MiB response ceiling and bounded request. Errors expose a generic diagnostic or HTTP status, never response body, submitted content, or key. A lost or malformed submission acknowledgement is ambiguous and must be reconciled instead of automatically resubmitted. No API key is included in the output block.

## Evidence and freshness

The [Research Basis documentation](https://docs.parallel.ai/task-api/guides/access-research-basis) provides citations containing URL and excerpts, associated with fields and list-element paths. The adapter maps `cells.0`, `cells.1`, etc. to the corresponding returned cells. Parent `cells` citations are deliberately not spread over every cell. Excerpts are bounded to 600 characters.

Documented citation objects do **not** include a source retrieval timestamp. Source observations are requested in generated content, but those are provider assertions. Missing source dates stay null. A result-fetch timestamp never becomes a source-retrieval timestamp. Returned findings remain `unverified`, with a reason explaining absent dates or provider-supplied dates and lack of independent source fetching. A provider's reported conflict is retained in that reason. `not_found` is the provider's reported absence of evidence, not proof the fact does not exist. Completion means a job completed; it is not proof the answer is correct.

## Remaining release checks

Before encouraging live use, run an explicitly authorized small live request with a caller-owned account and inspect real output schema and evidence mapping. Apply the commercial conditions above before publication or managed hosting; measure variable costs and implement accountable metering. The current adapter provides no seller wallet, hosted checkout, billing or claims of profit.
