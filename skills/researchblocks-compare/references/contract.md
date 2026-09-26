# Evidence contract

Use Python 3 and UTF-8 JSON. Set request `max_cost_usd` to the decimal string `"0"` for native evidence import; it controls no host or upstream research cost. Native import requires no paid provider credentials. Identifiers use lowercase letters, digits, hyphens or underscores and start with a letter.

## Request

Use exactly these fields:

```json
{
  "candidates": [
    {"id": "api_a", "label": "API A", "official_domains": ["docs.example.com"]}
  ],
  "criteria": [
    {"id": "unit_price", "question": "What is the published unit price and billing basis?"}
  ],
  "max_age_hours": 24,
  "max_cost_usd": "0"
}
```

Domains are plain public DNS hostnames without URL prefixes or paths; their subdomains are allowed. Include the exact official host when a broader root is unnecessary. Preserve at most three candidates and five criteria.

## Imported evidence

The import command requires a complete object with exactly `schema_version`, `request`, `cells` and `provenance`. Set `schema_version` to `"1.0"`; copy the normalized request exactly; provide the full matrix in `cells`. It validates existing request binding and synthetic provenance before replacing run metadata.

Set `provenance` to exactly `{"provider": "import", "run_id": null, "generated_at": "ACTUAL_UTC_CREATION_TIMESTAMP", "is_demo": false, "actual_cost_usd": null, "estimated_cost_usd": null}` for factual evidence. Replace the timestamp placeholder with the actual UTC creation time. Preserve `is_demo: true` for any synthetic fixture. Do not relabel synthetic content.

Use exactly these fields for each element of `cells`:

```json
{
  "candidate": "api_a",
  "criterion": "unit_price",
  "value": null,
  "unit": null,
  "currency": null,
  "billing_basis": null,
  "scope": {"plan": null, "version": null, "region": null},
  "evidence_status": "not_found",
  "sources": [],
  "reason": "No source was supplied for this criterion."
}
```

Provide exactly one cell for every candidate and criterion, even when the answer is missing. Values are JSON scalars or null. Currency, when known, is an uppercase code. Source records use exactly `url`, `excerpt` and `retrieved_at`; retrieval timestamps are UTC ISO8601 (`2026-09-26T14:00:00Z`) or null. Never copy the example timestamp into research evidence. Each excerpt is at most 600 characters, and normal source quotation limits still apply across the complete output. Cite at most ten distinct URLs across the block. URLs must be HTTPS on that candidate's approved official domains, without credentials or nonstandard ports.

| Evidence status | Requirement |
| --- | --- |
| `supported` | Non-null value plus cited evidence that supports the claim. This is the submitter's assessment, not independent certification. |
| `conflicting` | At least two distinct cited URLs and an explanation of the disagreement. |
| `not_found` | Null value; explain search scope or missing information. |
| `stale` | Cited evidence older than the freshness window. |
| `unverified` | Support or freshness not established; keep the limitation explicit. |

The validator downgrades supported/conflicting evidence to `stale` when old, and to `unverified` when retrieval time is unknown. It retains disagreement information in the reason. Do not rewrite dates merely to avoid downgrades.

Read `result` to obtain the complete normalized block with request, cells and provenance. An import run has `provider: "import"`, preserves the supplied `is_demo` flag, has unknown total `actual_cost_usd`, and local processing cost zero in its job summary. Those fields describe the formatting operation, not how the source evidence was originally obtained. Do not relabel synthetic fixtures as factual imports.
