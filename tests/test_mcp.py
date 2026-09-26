"""In-memory MCP wire tests; these do not claim validation in external hosts."""

import io
import json
import unittest

from researchblocks.mcp import MAX_MESSAGE_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION, TOOLS, serve


def rpc(method, params=None, request_id=1):
    value = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        value["params"] = params
    return value


def initialize(version=PROTOCOL_VERSION):
    return rpc("initialize", {"protocolVersion": version, "capabilities": {},
                              "clientInfo": {"name": "test-harness", "version": "1"}})


READY = {"jsonrpc": "2.0", "method": "notifications/initialized"}
REQUEST = {"candidates": [{"id": "alpha", "label": "Alpha", "official_domains": ["example.com"]}],
           "criteria": [{"id": "price", "question": "Published price?"}],
           "max_age_hours": 24, "max_cost_usd": "0.025"}


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.failure = None
        self.value = {"job_id": "job-1", "status": "completed"}

    def _record(self, method, *args, **kwargs):
        self.calls.append((method, args, kwargs))
        if self.failure:
            raise self.failure
        return self.value

    def quote(self, *args, **kwargs):
        return self._record("quote", *args, **kwargs)

    def submit(self, *args, **kwargs):
        return self._record("submit", *args, **kwargs)

    def status(self, *args, **kwargs):
        return self._record("status", *args, **kwargs)

    def result(self, *args, **kwargs):
        return self._record("result", *args, **kwargs)

    def import_block(self, *args, **kwargs):
        return self._record("import_block", *args, **kwargs)

    def export(self, *args, **kwargs):
        self._record("export", *args, **kwargs)
        return "# Evidence\n\nDemo only.\n"


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()

    def exchange(self, messages=None, raw=None, binary=False):
        if raw is None:
            raw = "".join(json.dumps(item) + "\n" for item in messages)
        if binary:
            source = io.BytesIO(raw if isinstance(raw, bytes) else raw.encode())
            destination = io.BytesIO()
        else:
            source, destination = io.StringIO(raw), io.StringIO()
        serve(self.engine, source, destination)
        output = destination.getvalue()
        if isinstance(output, bytes):
            output = output.decode("utf-8")
        return [json.loads(line) for line in output.splitlines()]

    def call(self, suffix, arguments):
        return self.exchange([initialize(), READY, rpc("tools/call", {
            "name": "researchblocks_" + suffix, "arguments": arguments}, 2)])[-1]

    def test_handshake_list_and_ping_are_json_only(self):
        output = self.exchange([initialize(), READY, rpc("tools/list", {}, 2), rpc("ping", {}, "alive")])
        self.assertEqual(len(output), 3)
        self.assertEqual(output[0]["result"]["protocolVersion"], PROTOCOL_VERSION)
        self.assertEqual(output[0]["result"]["capabilities"], {"tools": {"listChanged": False}})
        self.assertEqual(len(output[1]["result"]["tools"]), 6)
        self.assertEqual(output[2], {"jsonrpc": "2.0", "id": "alive", "result": {}})
        self.assertEqual(self.engine.calls, [])

    def test_version_negotiation_does_not_claim_modern_support(self):
        for requested, expected in (("2025-06-18", "2025-06-18"), ("2026-07-28", PROTOCOL_VERSION)):
            with self.subTest(requested=requested):
                output = self.exchange([initialize(requested)])
                self.assertEqual(output[0]["result"]["protocolVersion"], expected)

    def test_modern_discovery_fails_without_executing_tools(self):
        output = self.exchange([rpc("server/discover", {}, 1), rpc("tools/call", {
            "name": "researchblocks_submit", "arguments": {"request": REQUEST, "idempotency_key": "first"}}, 2)])
        self.assertEqual(output[0]["error"]["code"], -32601)
        self.assertEqual(output[1]["error"]["code"], -32002)
        self.assertEqual(self.engine.calls, [])

    def test_requires_initialized_notification(self):
        output = self.exchange([initialize(), rpc("tools/list", {}, 2), READY, rpc("tools/list", {}, 3)])
        self.assertEqual(output[1]["error"]["code"], -32002)
        self.assertIn("tools", output[2]["result"])

    def test_notification_cannot_submit_paid_job(self):
        output = self.exchange([initialize(), READY, {"jsonrpc": "2.0", "method": "tools/call", "params": {
            "name": "researchblocks_submit", "arguments": {"request": REQUEST, "provider": "parallel", "idempotency_key": "first"}}}])
        self.assertEqual(len(output), 1)
        self.assertEqual(self.engine.calls, [])

    def test_submit_default_is_demo_and_preserves_key(self):
        output = self.call("submit", {"request": REQUEST, "idempotency_key": "stable-123"})
        self.assertFalse(output["result"]["isError"])
        method, args, kwargs = self.engine.calls[0]
        self.assertEqual(method, "submit")
        self.assertEqual(args, (REQUEST,))
        self.assertEqual(kwargs, {"provider": "demo", "idempotency_key": "stable-123"})

    def test_quote_default_does_not_submit(self):
        self.call("quote", {"request": REQUEST})
        self.assertEqual(self.engine.calls, [("quote", (REQUEST,), {"provider": "parallel"})])

    def test_missing_idempotency_or_unknown_provider_does_not_call_engine(self):
        for arguments in ({"request": REQUEST}, {"request": REQUEST, "idempotency_key": "stable", "provider": "other"}):
            with self.subTest(arguments=arguments):
                output = self.call("submit", arguments)
                self.assertTrue(output["result"]["isError"])
        self.assertEqual(self.engine.calls, [])

    def test_paths_and_unadvertised_arguments_are_rejected(self):
        for suffix, arguments in (("result", {"job_id": "../../private"}),
                                  ("export", {"job_id": "job-1", "path": "/tmp/out"}),
                                  ("quote", {"request": "/tmp/request.json"})):
            with self.subTest(suffix=suffix):
                output = self.call(suffix, arguments)
                self.assertTrue(output["result"]["isError"])
        self.assertEqual(self.engine.calls, [])

    def test_import_routes_objects_and_key(self):
        block = {"cells": []}
        output = self.call("import", {"request": REQUEST, "block": block, "idempotency_key": "import-1"})
        self.assertFalse(output["result"]["isError"])
        self.assertEqual(self.engine.calls, [("import_block", (REQUEST, block), {"idempotency_key": "import-1"})])

    def test_result_has_equivalent_structured_and_text_content(self):
        output = self.call("result", {"job_id": "job-1"})["result"]
        self.assertEqual(json.loads(output["content"][0]["text"]), output["structuredContent"])

    def test_export_preserves_embedded_newlines_inside_one_frame(self):
        output = self.call("export", {"job_id": "job-1"})["result"]
        self.assertEqual(output["content"][0]["text"], "# Evidence\n\nDemo only.\n")
        self.assertNotIn("structuredContent", output)

    def test_provider_errors_do_not_leak_secrets(self):
        self.engine.failure = RuntimeError("Authorization: Bearer sk-live-secret /private/config")
        output = self.call("submit", {"request": REQUEST, "provider": "parallel", "idempotency_key": "retry-key"})
        self.assertTrue(output["result"]["isError"])
        self.assertNotIn("sk-live-secret", json.dumps(output))
        self.assertNotIn("/private/config", json.dumps(output))
        self.assertIn("idempotency_key", output["result"]["content"][0]["text"])

    def test_unknown_tool_is_protocol_error(self):
        output = self.call("not-a-tool", {})
        self.assertEqual(output["error"]["code"], -32602)

    def test_malformed_frames_recover(self):
        raw = "{bad}\n[]\n" + json.dumps(initialize()) + "\n"
        output = self.exchange(raw=raw)
        self.assertEqual([item.get("error", {}).get("code") for item in output], [-32700, -32600, None])

    def test_rejects_nonstandard_constants_and_duplicate_keys(self):
        raw = '{"jsonrpc":"2.0","id":NaN,"method":"ping"}\n' \
              '{"jsonrpc":"2.0","id":1,"method":"ping","method":"initialize"}\n'
        output = self.exchange(raw=raw)
        self.assertEqual([item["error"]["code"] for item in output], [-32700, -32700])

    def test_bool_and_null_request_ids_are_invalid(self):
        output = self.exchange([rpc("ping", request_id=True), rpc("ping", request_id=None)])
        self.assertEqual([item["error"]["code"] for item in output], [-32600, -32600])

    def test_oversize_frame_drained_before_next_frame(self):
        raw = "x" * (MAX_MESSAGE_BYTES * 2 + 15) + "\n" + json.dumps(rpc("ping", request_id=9)) + "\n"
        output = self.exchange(raw=raw, binary=True)
        self.assertEqual(len(output), 2)
        self.assertEqual(output[0]["error"]["code"], -32700)
        self.assertEqual(output[1]["id"], 9)

    def test_invalid_utf8_recovers(self):
        output = self.exchange(raw=b"\xff\n" + json.dumps(rpc("ping", request_id=9)).encode() + b"\n", binary=True)
        self.assertEqual(output[0]["error"]["code"], -32700)
        self.assertEqual(output[1]["result"], {})

    def test_oversize_output_is_replaced_with_safe_error(self):
        self.engine.value = {"body": "x" * MAX_RESPONSE_BYTES}
        output = self.call("result", {"job_id": "job-1"})
        self.assertEqual(output["error"]["code"], -32603)

    def test_tool_annotations_disclose_writes_and_external_calls(self):
        definitions = {item["name"]: item for item in TOOLS}
        quote = definitions["researchblocks_quote"]
        submit = definitions["researchblocks_submit"]
        self.assertTrue(quote["annotations"]["readOnlyHint"])
        self.assertFalse(quote["annotations"]["openWorldHint"])
        self.assertFalse(submit["annotations"]["readOnlyHint"])
        self.assertTrue(submit["annotations"]["openWorldHint"])
        self.assertIn("idempotency_key", submit["inputSchema"]["required"])
        self.assertIn("RESEARCHBLOCKS_ALLOW_PAID", submit["description"])


if __name__ == "__main__":
    unittest.main()
