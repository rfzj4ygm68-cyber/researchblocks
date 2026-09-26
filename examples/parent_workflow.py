"""Run from an installed package. Fixture only; no internet, key, or charge."""
import json
import tempfile
import time
from pathlib import Path
from researchblocks.engine import Engine


def run():
    request = json.loads(Path(__file__).with_name("request.json").read_text())
    with tempfile.TemporaryDirectory() as directory:
        engine = Engine(Path(directory) / "jobs.sqlite3")
        job = engine.submit(request, provider="demo", idempotency_key="parent-demo-1")
        print(json.dumps({"event": "research_started", **job}))
        # Actual separate parent work; no claim this models an LLM's latency or cost.
        routes = [{"path": route, "method": "GET"} for route in ("/health", "/status", "/results")]
        print(json.dumps({"event": "parent_continued", "built_routes": routes}))
        deadline = time.monotonic() + 5
        while engine.status(job["job_id"])["status"] != "completed":
            if time.monotonic() > deadline:
                raise RuntimeError("Demo did not complete")
            time.sleep(0.05)
        block = engine.result(job["job_id"])["block"]
        assert block["provenance"]["is_demo"] is True
        print(json.dumps({"event": "research_consumed", "cells": len(block["cells"]),
                          "is_demo": True, "cost_usd": "0", "supported_facts": 0}))


if __name__ == "__main__":
    run()
