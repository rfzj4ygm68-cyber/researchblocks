"""Real subprocess CLI and stdio MCP tests. No paid or remote providers."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "jobs.sqlite3")
        self.env = {**os.environ, "PYTHONPATH": str(ROOT / "src"), "RESEARCHBLOCKS_ALLOW_PAID": "0"}
        self.env.pop("PARALLEL_API_KEY", None)

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args):
        result = subprocess.run([sys.executable, "-m", "researchblocks", "--db", self.db, *args],
                                env=self.env, cwd=ROOT, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_native_evidence_import_cli_and_export(self):
        created = json.loads(self.cli("import", "examples/request.json", "examples/observed-block.json", "--idempotency-key", "observed"))
        result = json.loads(self.cli("result", created["job_id"]))
        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["block"]["provenance"]["is_demo"])
        self.assertIsNone(result["actual_cost_usd"])
        self.assertEqual(result["local_processing_cost_usd"], "0")
        self.assertEqual(len(result["block"]["cells"]), 4)
        self.assertEqual(result["block"]["cells"][0]["billing_basis"], "25 USD per 1000 successful core Task Runs")
        self.assertIn("https://docs.parallel.ai/getting-started/pricing", self.cli("export", created["job_id"]))
        self.assertEqual(json.loads(self.cli("import", "examples/request.json", "examples/observed-block.json", "--idempotency-key", "observed"))["job_id"], created["job_id"])

    def test_mcp_real_process_drives_real_engine(self):
        request = json.loads((ROOT / "examples/request.json").read_text())
        proc = subprocess.Popen([sys.executable, "-m", "researchblocks", "--db", self.db, "mcp"],
                                env=self.env, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        def send(method, params, identifier=None):
            message = {"jsonrpc": "2.0", "method": method, "params": params}
            if identifier is not None:
                message["id"] = identifier
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            return json.loads(proc.stdout.readline()) if identifier is not None else None
        try:
            self.assertEqual(send("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "release-harness", "version": "1"}}, 1)["result"]["protocolVersion"], "2025-11-25")
            send("notifications/initialized", {})
            listed = send("tools/list", {}, 2)
            self.assertEqual(len(listed["result"]["tools"]), 6)
            submitted = send("tools/call", {"name": "researchblocks_submit", "arguments": {"request": request, "provider": "demo", "idempotency_key": "mcp-demo"}}, 3)
            created = submitted["result"]["structuredContent"]
            job_id = created["job_id"]
            time.sleep(0.16)
            result = send("tools/call", {"name": "researchblocks_result", "arguments": {"job_id": job_id}}, 4)
            block = result["result"]["structuredContent"]["block"]
            self.assertTrue(block["provenance"]["is_demo"])
            self.assertEqual(len(block["cells"]), 4)
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)
            self.assertEqual(proc.stderr.read(), "")
            proc.stdout.close()
            proc.stderr.close()


if __name__ == "__main__":
    unittest.main()
