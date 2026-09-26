# ResearchBlocks · local alpha

Development branch: the separate paid HTTP service and agent client are implemented under [hosted/](hosted/README.md). They are awaiting hosting capacity, secure provider connections and live verification; checkout is not active. The existing 0.1.0 release assets and installed skill remain the earlier local alpha.

Fill a comparison table without losing the evidence behind each cell.

ResearchBlocks is a small, local-first Python package for agent workflows. It stores bounded comparison jobs, returns structured evidence blocks and exports readable tables. Use your existing agent's research tools and import the findings free, or explicitly enable a caller-funded Parallel adapter. No hosted service, wallet connection, subscription, or automatic payment is included in this alpha.

**Working product name; no PyPI release. Version 0.1.0, 26 September 2026.**

## Try the working example

Python 3.11 or later. Runtime uses only the standard library. Clone the public source repository and create an isolated environment:

```bash
git clone https://github.com/rfzj4ygm68-cyber/researchblocks.git
cd researchblocks
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
python examples/parent_workflow.py
```

The activation command above is for a POSIX shell. On Windows PowerShell, use `.venv\Scripts\Activate.ps1` instead.

The example submits an offline job, performs separate parent work and consumes the resulting block. It uses synthetic cells clearly marked `is_demo: true`. It demonstrates the workflow, not research accuracy, latency, paid demand or provider performance. No key or network is used.

Without installation, run from the source checkout:

```bash
PYTHONPATH=src python3 examples/parent_workflow.py
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

## Use evidence collected by your agent

`examples/observed-block.json` is a small real, manually checked public-pricing snapshot with its observation time and unresolved fields. It deliberately preserves different billing units: a research run and a search query are different products. The program validates and stores the supplied evidence; it did not perform that browsing itself.

```bash
researchblocks import examples/request.json examples/observed-block.json --idempotency-key observed-pricing-20260926
researchblocks result rb_REPLACE_WITH_RETURNED_JOB_ID
researchblocks export rb_REPLACE_WITH_RETURNED_JOB_ID
```

The last two commands require the actual returned job ID. JSON is emitted on stdout; export returns Markdown. The evidence date is preserved. When the freshness requirement expires, supported evidence becomes stale. Missing timestamps remain unknown rather than being replaced with today's date.

For a new job, provide up to three candidates, five criteria and ten distinct cited URLs. Each candidate supplies an explicit list of its official domains. Every requested candidate/criterion pair must have exactly one cell, including unanswered questions. See `schemas/` and `examples/`.

## Connect through MCP

Run `researchblocks mcp` as a local stdio process in your client. A conventional configuration fragment is:

```json
{
  "mcpServers": {
    "researchblocks": {
      "command": "researchblocks",
      "args": ["mcp"]
    }
  }
}
```

Use an absolute executable path if your host does not inherit the environment containing the installation. Configuration locations vary by client. This is a generic fragment, not a claim of a verified integration with every host.

Tools: `researchblocks_quote`, `researchblocks_submit`, `researchblocks_status`, `researchblocks_result`, `researchblocks_import`, `researchblocks_export`. Submission defaults to the offline demo. Write calls require an idempotency key: repeat the same key for retries, use a new key only for a genuinely new authorised job.

The adapter explicitly supports MCP 2025-11-25 and 2025-06-18. It has been exercised with our subprocess protocol harness. Real desktop/IDE host installations have not been verified. No claim of native 2026 stateless protocol support is made.

## Optional caller-funded research

`researchblocks quote examples/request.json` is local and free. The optional Parallel adapter submits one `core` run. Live execution requires both `PARALLEL_API_KEY` and explicit `RESEARCHBLOCKS_ALLOW_PAID=1` in the caller's private environment, then `--provider parallel` on submit. Do not put API keys in requests, source files or committed host configurations.

The current published estimate is $0.025/run, checked 26 September 2026. `max_cost_usd` is a local preflight comparison with that estimate; **it is not a provider-enforced spending cap**. This alpha cannot guarantee an external invoice amount. It reports actual billed cost as unavailable. Disable live execution if a hard cap is mandatory. Supplier terms and pricing apply to each caller's account.

No paid or live Parallel run was executed in release verification. Mocked tests check the documented transport contract, not provider availability or output quality. See `docs/provider-review.md`.

## What the validator does

- Enforces the complete comparison shape, bounded sizes, declared domains and source metadata.
- Requires evidence for a supported value and multiple sources for a conflict.
- Retains units, currency, billing basis, plan, version and region.
- Flags expired evidence; unknown source dates do not pass as fresh.
- Escapes evidence text in Markdown output and never executes cited URLs or embedded instructions.

A structurally valid source citation is **not proof that a claim is true**. The importer trusts the caller's evidence assertions. Parallel timestamps are provider assertions, and its non-null values remain unverified pending independent checks. Missing evidence is returned visibly.

## Durability and privacy

Jobs live in a private local SQLite file, defaulting to `~/.local/share/researchblocks/jobs.sqlite3`. Override with `--db` or `RESEARCHBLOCKS_DB`. This file can contain your research prompts and evidence. Protect and delete it under your own retention policy. No usage telemetry, shared evidence cache or remote analytics is included.

The paid adapter sends only the comparison request to Parallel over HTTPS. API keys stay in process memory/environment. It uses a fixed API origin, refuses redirects and does not automatically retry creation. An uncertain submission is retained as `submission_unknown` for account reconciliation; it is not silently charged again. Polling and result retrieval do not submit another task.

Malformed completed provider output is retained as `result_invalid`, with no usable evidence block. Repeating status or result calls does not fetch that rejected output again or submit another job; reconcile the existing provider run instead. Transient transport failures remain retryable. Concurrent polls cannot replace a completed or failed state with an older response.

This local process is single-owner software. It has no multi-user authentication, quotas, hosted payment settlement, customer isolation or public-service abuse controls. Do not expose it as a public HTTP service.

## Commercial direction

The free client is the adoption product. Future paid execution must add useful source processing and workflow management under suitable provider permissions, with actual measured delivery costs. The illustrative 0.25 USDC price is a planning hypothesis, not an active offer. `docs/launch-plan.md` records the next release and distribution work.

MIT-licensed project code. Upstream services and source content retain their own terms and rights.

## Installable agent skill

The repository includes the [ResearchBlocks Compare skill](skills/researchblocks-compare/) and its bundled local runtime. Use your compatible agent's skill installation mechanism to add the entire directory, preserving `SKILL.md`, `scripts/`, `references/` and the other bundled files. The skill can use the caller's existing research tools and import evidence locally, without a separate Python-package installation or provider account. It does not automatically install an MCP server or enable paid execution.
