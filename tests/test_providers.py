"""Mocked contract/security tests. These never perform live provider requests."""
import copy
import json
import os
import unittest
from unittest.mock import patch

from researchblocks.providers import ParallelProvider, ProviderError, MAX_BYTES, _NoRedirect


RID = "trun_test123"
REQ = {"candidates": [{"id": "alpha", "label": "Alpha", "official_domains": ["docs.example.com"]}],
       "criteria": [{"id": "price", "question": "Published price?"}],
       "max_age_hours": 24, "max_cost_usd": "0.025"}


class FakeTransport:
    def __init__(self, response=None, code=200, error=None):
        self.calls, self.response, self.code, self.error = [], response, code, error

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.code, json.dumps(self.response).encode()


def payload():
    return {"run": {"run_id": RID, "status": "completed"}, "output": {"type": "json", "content": {"cells": [{
        "candidate": "alpha", "criterion": "price", "value": "10", "unit": "month", "currency": "USD",
        "billing_basis": "monthly", "scope": {"plan": "Basic", "version": None, "region": None},
        "evidence_status": "supported", "reason": "Published monthly price.", "source_observations": [],
    }]}, "basis": [{"field": "cells.0", "citations": [{"url": "https://docs.example.com/pricing", "excerpts": ["Basic costs USD 10 per month."]}]}]}}


class ProviderTests(unittest.TestCase):
    def provider(self, response=None, code=200, error=None):
        t = FakeTransport(response, code, error)
        return ParallelProvider(api_key="mock-secret-key", transport=t), t

    def test_quote_has_no_network_or_key_requirement(self):
        p, t = self.provider()
        self.assertEqual(p.quote(REQ)["estimated_cost_usd"], "0.025")
        self.assertFalse(p.quote(REQ)["cap_enforced"])
        self.assertEqual(t.calls, [])

    def test_submit_requires_explicit_paid_opt_in(self):
        p, t = self.provider({"run_id": RID}, 202)
        with patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "0"}):
            with self.assertRaises(ProviderError):
                p.submit(REQ)
        self.assertEqual(t.calls, [])

    @patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "1"})
    def test_submit_exact_endpoint_schema_and_cost(self):
        p, t = self.provider({"run_id": RID}, 202)
        self.assertEqual(p.submit(REQ), RID)
        call = t.calls[0]
        body = json.loads(call["body"])
        self.assertEqual(call["url"], "https://api.parallel.ai/v1/tasks/runs")
        self.assertEqual(body["processor"], "core")
        self.assertEqual(body["source_policy"]["include_domains"], ["docs.example.com"])
        self.assertEqual(body["task_spec"]["output_schema"]["type"], "json")
        self.assertNotIn("mock-secret-key", call["body"].decode())
        self.assertNotIn("parallel-beta", call["headers"])

    @patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "1"})
    def test_underbudget_prevents_network(self):
        p, t = self.provider()
        request = copy.deepcopy(REQ)
        request["max_cost_usd"] = "0.01"
        with self.assertRaises(ProviderError):
            p.submit(request)
        self.assertEqual(t.calls, [])

    @patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "1"})
    def test_timed_out_post_is_ambiguous_redacted_and_never_retried(self):
        p, t = self.provider(error=TimeoutError("mock-secret-key and private prompt"))
        with self.assertRaises(ProviderError) as caught:
            p.submit(REQ)
        self.assertTrue(caught.exception.ambiguous)
        self.assertNotIn("mock-secret-key", str(caught.exception))
        self.assertEqual(len(t.calls), 1)

    @patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "1"})
    def test_invalid_acknowledgement_is_ambiguous(self):
        p, t = self.provider({"run_id": "https://evil.example/path"}, 202)
        with self.assertRaises(ProviderError) as caught:
            p.submit(REQ)
        self.assertTrue(caught.exception.ambiguous)
        self.assertEqual(len(t.calls), 1)

    @patch.dict(os.environ, {"RESEARCHBLOCKS_ALLOW_PAID": "1"})
    def test_http_errors_do_not_leak_body(self):
        for code, ambiguous in [(401, False), (402, False), (429, False), (500, True), (307, True)]:
            with self.subTest(code=code):
                p, t = self.provider({"error": "mock-secret-key"}, code)
                with self.assertRaises(ProviderError) as caught:
                    p.submit(REQ)
                self.assertEqual(caught.exception.ambiguous, ambiguous)
                self.assertNotIn("mock-secret-key", str(caught.exception))
                self.assertEqual(len(t.calls), 1)

    def test_invalid_run_id_never_reaches_transport(self):
        p, t = self.provider()
        for rid in ["../other", "trun_a?secret=x", "https://evil.example", "trun_a\n"]:
            with self.assertRaises(ProviderError):
                p.status(rid)
        self.assertEqual(t.calls, [])

    def test_redirect_handler_refuses_all_redirects(self):
        self.assertIsNone(_NoRedirect().redirect_request(None, None, 307, "", {}, "https://evil.example"))

    def test_status_and_action_required(self):
        for remote, local in [("queued", "pending"), ("running", "running"), ("completed", "completed"), ("failed", "failed"), ("cancelled", "failed")]:
            p, _ = self.provider({"run_id": RID, "status": remote})
            self.assertEqual(p.status(RID), local)
        p, _ = self.provider({"run_id": RID, "status": "action_required"})
        with self.assertRaisesRegex(ProviderError, "requires action"):
            p.status(RID)

    def test_result_maps_per_cell_basis_without_fabricated_dates(self):
        p, t = self.provider(payload())
        result = p.result(RID, REQ)
        source = result["cells"][0]["sources"][0]
        self.assertIsNone(source["retrieved_at"])
        self.assertEqual(result["cells"][0]["evidence_status"], "unverified")
        self.assertIn("unavailable", result["cells"][0]["reason"])
        self.assertIsNone(result["provenance"]["actual_cost_usd"])
        self.assertTrue(t.calls[0]["url"].endswith("/result?timeout=1"))

    def test_parent_basis_is_not_attached_to_unrelated_cells(self):
        data = payload()
        data["output"]["basis"][0]["field"] = "cells"
        p, _ = self.provider(data)
        self.assertEqual(p.result(RID, REQ)["cells"][0]["sources"], [])

    def test_provider_timestamp_is_identified_as_assertion(self):
        from datetime import datetime, timezone
        data = payload()
        data["output"]["content"]["cells"][0]["source_observations"] = [{"url": "https://docs.example.com/pricing", "retrieved_at": datetime.now(timezone.utc).isoformat()}]
        p, _ = self.provider(data)
        result = p.result(RID, REQ)
        self.assertEqual(result["cells"][0]["evidence_status"], "unverified")
        self.assertIn("provider-supplied", result["cells"][0]["reason"])

    def test_off_domain_evidence_is_rejected(self):
        data = payload()
        data["output"]["basis"][0]["citations"][0]["url"] = "https://evil.example/pricing"
        p, _ = self.provider(data)
        with self.assertRaisesRegex(ProviderError, "evidence-block"):
            p.result(RID, REQ)

    def test_mismatched_result_id_rejected(self):
        data = payload()
        data["run"]["run_id"] = "trun_other"
        p, _ = self.provider(data)
        with self.assertRaises(ProviderError):
            p.result(RID, REQ)

    def test_oversize_and_invalid_json_redacted(self):
        for raw in [b"x" * (MAX_BYTES + 1), b"mock-secret-key not-json"]:
            p = ParallelProvider("mock-key", transport=lambda **kw: (200, raw))
            with self.assertRaises(ProviderError) as caught:
                p.status(RID)
            self.assertNotIn("mock-secret-key", str(caught.exception))

    def test_header_injection_never_reaches_transport(self):
        t = FakeTransport()
        p = ParallelProvider("key\nInjected: yes", transport=t)
        with self.assertRaises(ProviderError):
            p.status(RID)
        self.assertEqual(t.calls, [])

    def test_nested_json_and_invalid_state_are_safe_errors(self):
        raw = b'{"nested":' + b'[' * 2000 + b'0' + b']' * 2000 + b'}'
        p = ParallelProvider("mock-key", transport=lambda **kw: (200, raw))
        with self.assertRaises(ProviderError):
            p.status(RID)
        p, _ = self.provider({"run_id": RID, "status": {"bad": "state"}})
        with self.assertRaisesRegex(ProviderError, "Unknown provider state"):
            p.status(RID)


if __name__ == "__main__":
    unittest.main()
