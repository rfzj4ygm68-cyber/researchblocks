"""Offline regressions for polling races and invalid completed provider output."""
import concurrent.futures
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from researchblocks.engine import Engine, EngineError
from researchblocks.providers import ParallelProvider, ProviderError


REQUEST = {"candidates": [{"id": "alpha", "label": "Alpha", "official_domains": ["example.com"]}],
           "criteria": [{"id": "price", "question": "Published price?"}],
           "max_age_hours": 24, "max_cost_usd": "0.025"}
RUN_ID = "trun_offline_fixture"


def output(url="https://example.com/pricing"):
    return {"run": {"run_id": RUN_ID, "status": "completed"},
            "output": {"type": "json", "content": {"cells": [{
                "candidate": "alpha", "criterion": "price", "value": "10",
                "unit": "month", "currency": "USD", "billing_basis": "monthly",
                "scope": {"plan": "Basic", "version": None, "region": None},
                "evidence_status": "supported", "reason": "Supplied test fixture only.",
                "source_observations": [],
            }]}, "basis": [{"field": "cells.0", "citations": [{
                "url": url, "excerpts": ["Basic: USD 10 per month."]}]}]}}


class StubProvider:
    def quote(self, request):
        return {"estimated_cost_usd": "0.025"}

    def submit(self, request):
        return RUN_ID


class PollingAndResultRegressionTests(unittest.TestCase):
    def test_delayed_poll_cannot_overwrite_terminal_status_or_error(self):
        for terminal, delayed_error in (("completed", False), ("failed", False), ("completed", True)):
            with self.subTest(terminal=terminal, delayed_error=delayed_error), tempfile.TemporaryDirectory() as temp:
                started, release = threading.Event(), threading.Event()

                class RacingProvider(StubProvider):
                    calls = 0

                    def status(self, run_id):
                        self.calls += 1
                        if self.calls == 1:
                            started.set()
                            if not release.wait(5):
                                raise AssertionError("Test did not release the delayed poll")
                            if delayed_error:
                                raise ProviderError("Mock transport timeout")
                            return "running"
                        return terminal

                provider = RacingProvider()
                db = Path(temp) / "jobs.sqlite3"
                older, newer = Engine(db, provider, True), Engine(db, provider, True)
                job_id = older.submit(REQUEST, "parallel", "stable")["job_id"]
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    delayed = pool.submit(older.status, job_id)
                    try:
                        self.assertTrue(started.wait(5))
                        observed = newer.status(job_id)
                        self.assertEqual(observed["status"], terminal)
                    finally:
                        release.set()
                    final = delayed.result(timeout=5)
                self.assertEqual(final["status"], terminal)
                self.assertEqual(final["error"], "Provider reported a failed run." if terminal == "failed" else None)
                self.assertEqual(older._row(job_id)["status"], terminal)

    def test_running_status_does_not_regress_to_pending(self):
        class LaggingProvider(StubProvider):
            def __init__(self):
                self.states = iter(("running", "pending"))

            def status(self, run_id):
                return next(self.states)

        with tempfile.TemporaryDirectory() as temp:
            engine = Engine(Path(temp) / "jobs.sqlite3", LaggingProvider(), True)
            job_id = engine.submit(REQUEST, "parallel", "stable")["job_id"]
            self.assertEqual(engine.status(job_id)["status"], "running")
            self.assertEqual(engine.status(job_id)["status"], "running")

    def test_invalid_evidence_is_terminal_and_survives_reopen_without_more_calls(self):
        calls = []

        def transport(**kwargs):
            calls.append((kwargs["method"], kwargs["url"]))
            if kwargs["method"] == "POST":
                value = {"run_id": RUN_ID}
            elif kwargs["url"].endswith("/result?timeout=1"):
                value = output("https://offdomain.example/pricing")
            else:
                value = {"run_id": RUN_ID, "status": "completed"}
            return 200, json.dumps(value).encode()

        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "1"}):
            db = Path(temp) / "jobs.sqlite3"
            provider = ParallelProvider("mock-only", transport=transport)
            engine = Engine(db, provider, True)
            job_id = engine.submit(REQUEST, "parallel", "stable")["job_id"]
            with self.assertRaisesRegex(EngineError, "failed evidence validation"):
                engine.result(job_id)
            expected_calls = len(calls)
            reopened = Engine(db, provider, True)
            for _ in range(3):
                result = reopened.result(job_id)
                self.assertEqual(result["status"], "result_invalid")
                self.assertIsNone(result["block"])
                self.assertIn("failed evidence validation", result["error"])
            self.assertEqual(reopened.submit(REQUEST, "parallel", "stable")["job_id"], job_id)
            self.assertEqual(len(calls), expected_calls)
            self.assertEqual(sum(method == "POST" for method, _ in calls), 1)

    def test_transient_result_transport_failure_can_recover_without_resubmission(self):
        calls, result_attempts = [], []

        def transport(**kwargs):
            calls.append((kwargs["method"], kwargs["url"]))
            if kwargs["method"] == "POST":
                value = {"run_id": RUN_ID}
            elif kwargs["url"].endswith("/result?timeout=1"):
                result_attempts.append(True)
                if len(result_attempts) == 1:
                    raise TimeoutError("Mock only")
                value = output()
            else:
                value = {"run_id": RUN_ID, "status": "completed"}
            return 200, json.dumps(value).encode()

        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "1"}):
            engine = Engine(Path(temp) / "jobs.sqlite3", ParallelProvider("mock-only", transport=transport), True)
            job_id = engine.submit(REQUEST, "parallel", "stable")["job_id"]
            with self.assertRaisesRegex(EngineError, "temporarily unavailable"):
                engine.result(job_id)
            result = engine.result(job_id)
            self.assertEqual(result["status"], "completed")
            self.assertIsNotNone(result["block"])
            self.assertEqual(result["block"]["cells"][0]["evidence_status"], "unverified")
            self.assertEqual(len(result_attempts), 2)
            self.assertEqual(sum(method == "POST" for method, _ in calls), 1)


if __name__ == "__main__":
    unittest.main()
