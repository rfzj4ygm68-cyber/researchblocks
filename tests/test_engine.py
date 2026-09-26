import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from researchblocks.engine import Engine, EngineError
from researchblocks.providers import ProviderError


REQUEST = {"candidates": [{"id": "alpha", "label": "Alpha", "official_domains": ["example.com"]}],
           "criteria": [{"id": "price", "question": "Published price?"}],
           "max_age_hours": 24, "max_cost_usd": "0.025"}


class FakeProvider:
    def __init__(self, fail=None):
        self.submits = 0
        self.fail = fail
        self.polls = 0

    def quote(self, request):
        return {"estimated_cost_usd": "0.025", "cap_enforced": False}

    def submit(self, request):
        self.submits += 1
        if self.fail:
            raise ProviderError("DO_NOT_LOG_SECRET", ambiguous=self.fail == "unknown")
        return "run_mock_1"

    def status(self, run_id):
        self.polls += 1
        return "running"


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "jobs.sqlite3"

    def tearDown(self):
        self.temp.cleanup()

    def test_demo_survives_process_reopen(self):
        first = Engine(self.db).submit(REQUEST, "demo", "same")
        time.sleep(0.16)
        reopened = Engine(self.db)
        result = reopened.result(first["job_id"])
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["block"]["provenance"]["is_demo"])
        self.assertEqual(result["actual_cost_usd"], "0")
        self.assertEqual(reopened.submit(REQUEST, "demo", "same")["job_id"], first["job_id"])

    def test_idempotency_mismatch(self):
        engine = Engine(self.db)
        engine.submit(REQUEST, "demo", "same")
        altered = copy.deepcopy(REQUEST)
        altered["criteria"][0]["question"] = "Different task?"
        with self.assertRaisesRegex(EngineError, "different request"):
            engine.submit(altered, "demo", "same")

    def test_paid_disabled_before_any_post(self):
        provider = FakeProvider()
        with self.assertRaisesRegex(EngineError, "disabled"):
            Engine(self.db, provider, allow_paid=False).submit(REQUEST, "parallel", "one")
        self.assertEqual(provider.submits, 0)

    def test_budget_rejected_before_any_post(self):
        provider = FakeProvider()
        request = copy.deepcopy(REQUEST)
        request["max_cost_usd"] = "0.001"
        with self.assertRaisesRegex(EngineError, "Budget"):
            Engine(self.db, provider, allow_paid=True).submit(request, "parallel", "one")
        self.assertEqual(provider.submits, 0)

    def test_unknown_submission_never_reposts_and_redacts(self):
        provider = FakeProvider("unknown")
        engine = Engine(self.db, provider, allow_paid=True)
        first = engine.submit(REQUEST, "parallel", "stable")
        second = Engine(self.db, provider, allow_paid=True).submit(REQUEST, "parallel", "stable")
        self.assertEqual(first["job_id"], second["job_id"])
        self.assertEqual(second["status"], "submission_unknown")
        self.assertEqual(provider.submits, 1)
        self.assertNotIn("DO_NOT_LOG_SECRET", json.dumps(second))

    def test_status_never_creates_another_run(self):
        provider = FakeProvider()
        engine = Engine(self.db, provider, allow_paid=True)
        job = engine.submit(REQUEST, "parallel", "stable")
        engine.status(job["job_id"])
        engine.result(job["job_id"])
        self.assertEqual(provider.submits, 1)
        self.assertEqual(provider.polls, 2)

    def test_unknown_job_and_invalid_id(self):
        engine = Engine(self.db)
        for key in ("../../etc/passwd", "rb_" + "0" * 32):
            with self.assertRaises(EngineError):
                engine.status(key)

    def test_import_keeps_demo_label_and_rejects_rebinding(self):
        engine = Engine(self.db)
        block = engine._demo_block(REQUEST, "demo_fixture")
        imported = engine.import_block(REQUEST, block, "import-demo")
        self.assertTrue(imported["is_demo"])
        self.assertTrue(engine.result(imported["job_id"])["block"]["provenance"]["is_demo"])
        changed = copy.deepcopy(REQUEST)
        changed["criteria"][0]["question"] = "Another question?"
        with self.assertRaisesRegex(ValueError, "does not match"):
            engine.import_block(changed, block, "mismatch")

    def test_interrupted_import_retries_same_job_safely(self):
        engine = Engine(self.db)
        block = engine._demo_block(REQUEST, "demo_fixture")
        original = engine._update
        def interruption(*args, **kwargs):
            raise RuntimeError("simulated interruption")
        engine._update = interruption
        with self.assertRaises(RuntimeError):
            engine.import_block(REQUEST, block, "interrupted")
        engine._update = original
        recovered = engine.import_block(REQUEST, block, "interrupted")
        self.assertEqual(recovered["status"], "completed")
        self.assertTrue(recovered["is_demo"])


if __name__ == "__main__":
    unittest.main()
