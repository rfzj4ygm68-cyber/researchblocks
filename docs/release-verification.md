# Alpha release verification

26 September 2026, Asia/Bangkok. Python 3.12.14 was the exercised interpreter; declared minimum is Python 3.11, which was not separately exercised.

**76 automated checks passed.** Suite: 9 engine, 2 subprocess integration, 21 MCP protocol, 26 schema/Markdown and 18 mocked provider checks. Run `PYTHONPATH=src python3 -m unittest discover -s tests -v` from the package directory.

The subprocess checks invoke real local CLI and MCP processes against SQLite, import supplied evidence, preserve billing units, export sources, and complete the explicitly synthetic asynchronous demonstration. Provider checks use mock transport only. These are software checks, not customer sales, live research outcomes or provider benchmarks.

A wheel was built, installed without network access into an isolated virtual environment, and used to execute the parent-workflow example with PYTHONPATH removed. Every packaged runtime module was byte-compared with the release source. Runtime has no third-party dependencies.

The observed example contains four cells: two public pricing observations and two unresolved guarantee questions. Facts were manually read from official pages at 2026-09-26T14:08:21Z (21:08:21 Bangkok). The code imported and formatted that evidence; it did not independently retrieve or verify it. The supplier service units differ and must not be compared as equivalent jobs. Freshness is reevaluated when read.

Independent review found and repaired: synthetic labels lost during import; mismatched embedded request binding; unhandled corrupt-store CLI errors; and interrupted local-import recovery. A separate check improved safe clickable source links without interpreting source-controlled Markdown.

Remaining verification limits:

- No authenticated/live provider request, charge, measured provider latency, invoice reconciliation or quality advantage established.
- No real desktop/IDE MCP host installation certified; only the protocol harness and CLI were exercised.
- No hosted HTTP service, customer authentication, multi-user isolation, payment collection or revenue exists in this build.
- Public source repository: https://github.com/rfzj4ygm68-cyber/researchblocks. No package registry publication or promotional post created.
- `max_cost_usd` checks a dated estimate; it is not a remote-provider hard cap.
- Local import is free; upstream research cost is unknown. Unknown amounts remain null.

Review and configuration are still needed before exposing any component as a hosted paid service. The current ready-to-use surface is the local package and its supplied-evidence workflow.
