"""Contract, evidence laundering and hostile-output regression tests."""

import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import unittest

from researchblocks.models import refresh_block, render_markdown, validate_block, validate_request


NOW = datetime(2026, 9, 26, 14, 0, tzinfo=timezone.utc)


def request():
    return {"candidates": [{"id": "alpha", "label": "Alpha", "official_domains": ["docs.example.com"]}],
            "criteria": [{"id": "price", "question": "Published price?"}], "max_age_hours": 24, "max_cost_usd": "0.025"}


def source(url="https://docs.example.com/pricing", retrieved_at="2026-09-26T13:00:00Z"):
    return {"url": url, "excerpt": "$2 per million input tokens on the Standard plan.", "retrieved_at": retrieved_at}


def block():
    return {"schema_version": "1.0", "request": request(), "cells": [{"candidate": "alpha", "criterion": "price", "value": 2,
             "unit": "million input tokens", "currency": "USD", "billing_basis": "usage", "scope": {"plan": "Standard", "version": None, "region": None},
             "evidence_status": "supported", "sources": [source()], "reason": "Price is stated in the supplied excerpt."}],
            "provenance": {"provider": "import", "run_id": None, "generated_at": "2026-09-26T14:00:00Z", "is_demo": False,
                           "actual_cost_usd": None, "estimated_cost_usd": "0"}}


class RequestTests(unittest.TestCase):
    def test_copy_canonicalization_and_no_secrets(self):
        value = request()
        value["candidates"][0]["official_domains"] = ["Docs.Example.Com"]
        value["max_cost_usd"] = "0.02500000"
        out = validate_request(value)
        self.assertEqual(out["max_cost_usd"], "0.025")
        out["candidates"][0]["official_domains"].append("example.org")
        self.assertEqual(value["candidates"][0]["official_domains"], ["Docs.Example.Com"])
        value["api_key"] = "SECRET_SENTINEL"
        with self.assertRaises(ValueError) as caught:
            validate_request(value)
        self.assertNotIn("SECRET_SENTINEL", str(caught.exception))

    def test_limits_boolean_and_nonfinite_numbers(self):
        for number in (True, False, 0, -1, float("nan"), float("inf"), 8761, 10**10000):
            with self.subTest(number_type=type(number).__name__):
                value = request()
                value["max_age_hours"] = number
                with self.assertRaises(ValueError):
                    validate_request(value)
        for price in (True, 0.025, "NaN", "1e-3", "-1", "1000.00000001", "0.123456789", " 1", "01"):
            value = request()
            value["max_cost_usd"] = price
            with self.assertRaises(ValueError):
                validate_request(value)

    def test_duplicate_identifiers_and_bounded_matrix(self):
        value = request()
        value["candidates"].append(copy.deepcopy(value["candidates"][0]))
        with self.assertRaises(ValueError):
            validate_request(value)
        value = request()
        value["criteria"] = [{"id": f"q{i}", "question": "Question"} for i in range(6)]
        with self.assertRaises(ValueError):
            validate_request(value)

    def test_reject_nonpublic_domains_and_malformed_hosts(self):
        bad = ["localhost", "127.0.0.1", "0x7f.0.0.1", "169.254.169.254", "192.168.0.1", "[::1]", "example.local", "service.internal",
               "https://example.com", "example.com:443", "example.com/path", "*.example.com", "example.com.", "-bad.example.com", "example..com", "foo.invalid"]
        for host in bad:
            with self.subTest(host=host):
                value = request()
                value["candidates"][0]["official_domains"] = [host]
                with self.assertRaises(ValueError):
                    validate_request(value)

    def test_duplicate_domains_casefolded(self):
        value = request()
        value["candidates"][0]["official_domains"] = ["docs.example.com", "DOCS.EXAMPLE.COM"]
        with self.assertRaises(ValueError):
            validate_request(value)


class EvidenceTests(unittest.TestCase):
    def test_valid_block_complete_copy(self):
        value = block()
        before = copy.deepcopy(value)
        normalized = validate_block(value, request(), now=NOW)
        self.assertEqual(normalized, value)
        normalized["cells"][0]["sources"][0]["excerpt"] = "changed"
        normalized["request"]["criteria"][0]["question"] = "changed"
        self.assertEqual(value, before)

    def test_exact_request_binding(self):
        other = request()
        other["max_cost_usd"] = "0.05"
        with self.assertRaises(ValueError):
            validate_block(block(), other, now=NOW)

    def test_missing_extra_duplicate_cells(self):
        for transform in (lambda cells: [], lambda cells: cells + copy.deepcopy(cells), lambda cells: [{**cells[0], "criterion": "missing"}]):
            value = block()
            value["cells"] = transform(value["cells"])
            with self.assertRaises(ValueError):
                validate_block(value, now=NOW)

    def test_complete_matrix_canonical_order(self):
        value = block()
        value["request"]["candidates"].append({"id": "beta", "label": "Beta", "official_domains": ["docs.example.com"]})
        value["cells"].append({**copy.deepcopy(value["cells"][0]), "candidate": "beta"})
        value["cells"].reverse()
        out = validate_block(value, now=NOW)
        self.assertEqual([cell["candidate"] for cell in out["cells"]], ["alpha", "beta"])

    def test_citation_cannot_escape_candidate_allowlist(self):
        bad = ["http://docs.example.com", "https://docs.example.com.evil.org", "https://evildocs.example.com", "https://evil.org/?next=docs.example.com",
               "https://user:SECRET@docs.example.com", "https://docs.example.com:8443/x", "https://127.0.0.1/x", "https://[::1]/x", "https://docs.example.com\\@evil.org/x",
               "https://docs.example.com/\npath", "https://docs.example.com/%0a"]
        # Percent-encoded path bytes are ordinary citation data; they are never fetched.
        for url in bad[:-1]:
            with self.subTest(url=url):
                value = block()
                value["cells"][0]["sources"][0]["url"] = url
                with self.assertRaises(ValueError) as caught:
                    validate_block(value, now=NOW)
                self.assertNotIn("SECRET", str(caught.exception))
        value = block()
        value["cells"][0]["sources"][0]["url"] = "https://api.docs.example.com/path"
        self.assertEqual(validate_block(value, now=NOW)["cells"][0]["evidence_status"], "supported")

    def test_supported_needs_evidence_and_value(self):
        for key, replacement in (("sources", []), ("value", None)):
            value = block()
            value["cells"][0][key] = replacement
            with self.assertRaises(ValueError):
                validate_block(value, now=NOW)

    def test_conflicting_requires_two_distinct_citations(self):
        value = block()
        value["cells"][0]["evidence_status"] = "conflicting"
        with self.assertRaises(ValueError):
            validate_block(value, now=NOW)
        value["cells"][0]["sources"].append(copy.deepcopy(value["cells"][0]["sources"][0]))
        with self.assertRaises(ValueError):
            validate_block(value, now=NOW)
        value["cells"][0]["sources"][1]["url"] = "https://docs.example.com/other-price"
        value["cells"][0]["value"] = None
        self.assertEqual(validate_block(value, now=NOW)["cells"][0]["evidence_status"], "conflicting")

    def test_not_found_means_no_claim(self):
        value = block()
        value["cells"][0]["evidence_status"] = "not_found"
        with self.assertRaises(ValueError):
            validate_block(value, now=NOW)
        value["cells"][0]["value"] = None
        value["cells"][0]["sources"] = []
        self.assertEqual(validate_block(value, now=NOW)["cells"][0]["evidence_status"], "not_found")

    def test_unknown_source_time_downgrade_is_stable(self):
        value = block()
        value["cells"][0]["sources"][0]["retrieved_at"] = None
        out = validate_block(value, now=NOW)
        self.assertEqual(out["cells"][0]["evidence_status"], "unverified")
        self.assertIn("unknown", out["cells"][0]["reason"])
        self.assertEqual(out, refresh_block(out, now=NOW))
        self.assertIsNone(value["cells"][0]["sources"][0]["retrieved_at"])

    def test_stale_downgrade_and_no_upgrade(self):
        value = block()
        out = refresh_block(value, now=NOW + timedelta(days=2))
        self.assertEqual(out["cells"][0]["evidence_status"], "stale")
        self.assertEqual(value["cells"][0]["evidence_status"], "supported")
        self.assertEqual(refresh_block(out, now=NOW)["cells"][0]["evidence_status"], "stale")

    def test_stale_conflict_preserves_uncertainty(self):
        value = block()
        cell = value["cells"][0]
        cell["evidence_status"] = "conflicting"
        cell["value"] = None
        cell["sources"].append(source("https://docs.example.com/old-price"))
        out = refresh_block(value, now=NOW + timedelta(days=2))
        self.assertEqual(out["cells"][0]["evidence_status"], "stale")
        self.assertIn("conflicting", out["cells"][0]["reason"])
        self.assertEqual(out, refresh_block(out, now=NOW + timedelta(days=2)))

    def test_future_timestamp_rejected_with_clock_skew(self):
        value = block()
        value["cells"][0]["sources"][0]["retrieved_at"] = "2026-09-26T14:05:00Z"
        validate_block(value, now=NOW)
        value["cells"][0]["sources"][0]["retrieved_at"] = "2026-09-26T14:05:01Z"
        with self.assertRaises(ValueError):
            validate_block(value, now=NOW)

    def test_naive_dates_and_non_utc_offsets_rejected(self):
        for date in ("2026-09-26", "2026-09-26T14:00:00", "2026-09-26T21:00:00+07:00", "2026-02-30T00:00:00Z"):
            value = block()
            value["cells"][0]["sources"][0]["retrieved_at"] = date
            with self.assertRaises(ValueError):
                validate_block(value, now=NOW)

    def test_global_ten_distinct_url_limit(self):
        value = block()
        value["request"]["criteria"].append({"id": "limits", "question": "Limits?"})
        value["cells"][0]["sources"] = [source(f"https://docs.example.com/{i}") for i in range(10)]
        value["cells"].append({**copy.deepcopy(value["cells"][0]), "criterion": "limits", "sources": [source("https://docs.example.com/10")]})
        with self.assertRaises(ValueError):
            validate_block(value, now=NOW)
        value["cells"][1]["sources"] = [source("https://docs.example.com/0")]
        validate_block(value, now=NOW)

    def test_excerpts_and_nonfinite_values_bounded(self):
        for field, bad in (("value", float("nan")), ("value", 10**10000), ("value", {}), ("reason", "x" * 1001)):
            value = block()
            value["cells"][0][field] = bad
            with self.assertRaises(ValueError):
                validate_block(value, now=NOW)
        value = block()
        value["cells"][0]["sources"][0]["excerpt"] = "x" * 601
        with self.assertRaises(ValueError):
            validate_block(value, now=NOW)

    def test_demo_cannot_silently_lose_label(self):
        value = block()
        value["provenance"]["provider"] = "demo"
        with self.assertRaises(ValueError):
            validate_block(value, now=NOW)
        value["provenance"]["is_demo"] = True
        self.assertTrue(validate_block(value, now=NOW)["provenance"]["is_demo"])

    def test_unexpected_verification_or_payment_fields_rejected(self):
        for field in ("verified", "paid", "actual_revenue", "instructions"):
            value = block()
            value["provenance"][field] = True
            with self.assertRaises(ValueError):
                validate_block(value, now=NOW)


class MarkdownAndSchemaTests(unittest.TestCase):
    def test_hostile_text_is_inert_and_demo_label_present(self):
        value = block()
        value["provenance"]["provider"] = "demo"
        value["provenance"]["is_demo"] = True
        value["cells"][0]["value"] = '<script>alert(1)</script> | [click](javascript:evil)\n# forged'
        text = render_markdown(value)
        self.assertIn("SYNTHETIC DEMO", text)
        self.assertIn("not independently verified", text)
        self.assertNotIn("<script>", text)
        self.assertNotIn("[click](javascript:evil)", text)
        self.assertNotIn("\n# forged", text)
        self.assertIn("Actual billed cost (USD): unavailable", text)
        self.assertIn("\\|", text)

    def test_unknown_retrieval_time_is_not_rendered_as_job_time(self):
        value = block()
        value["cells"][0]["sources"][0]["retrieved_at"] = None
        self.assertIn("Retrieved: unknown", render_markdown(value))

    def test_source_links_remain_clickable_without_delimiter_injection(self):
        value = block()
        value["cells"][0]["sources"][0]["url"] = "https://docs.example.com/a)[evil](javascript:alert(1))?x=1&copy;=2#part"
        text = render_markdown(value)
        expected = "[Source](<https://docs.example.com/a%29%5Bevil%5D%28javascript:alert%281%29%29?x=1&amp;copy;=2#part>)"
        self.assertIn(expected, text)
        self.assertEqual(text.count("[Source](<"), 1)
        self.assertNotIn(")[evil](", text)
        value["cells"][0]["sources"][0]["url"] = "https://docs.example.com/pricing?plan=pro&region=us"
        self.assertIn("[Source](<https://docs.example.com/pricing?plan=pro&amp;region=us>)", render_markdown(value))

    def test_schema_files_are_valid_json_and_have_strict_objects(self):
        directory = Path(__file__).resolve().parents[1] / "schemas"
        for path in directory.glob("*.json"):
            schema = json.loads(path.read_text())
            self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
            self.assertFalse(schema["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
