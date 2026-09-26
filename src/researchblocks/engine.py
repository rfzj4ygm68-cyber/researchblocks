"""Durable local jobs. This is not a multi-tenant hosted billing service."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from .models import validate_request, validate_block, refresh_block, render_markdown
from .providers import ParallelProvider, ProviderError, ProviderOutputError


class EngineError(ValueError):
    """Safe, deliberately non-sensitive error for CLI/MCP consumers."""


def utcnow():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False)


class Engine:
    def __init__(self, db_path=None, provider=None, allow_paid=None):
        self.db_path = str(db_path or os.environ.get("RESEARCHBLOCKS_DB") or
                           Path.home() / ".local" / "share" / "researchblocks" / "jobs.sqlite3")
        parent = Path(self.db_path).expanduser().absolute().parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db_path = str(Path(self.db_path).expanduser().absolute())
        # Private data file; no provider credential is ever stored here.
        if not Path(self.db_path).exists():
            try:
                fd = os.open(self.db_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
            except FileExistsError:
                pass
        self.provider = provider
        self.allow_paid = os.environ.get("RESEARCHBLOCKS_ALLOW_PAID") == "1" if allow_paid is None else allow_paid
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, digest TEXT NOT NULL,
                provider TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
                remote_id TEXT, block TEXT, error TEXT, created TEXT NOT NULL,
                updated TEXT NOT NULL, ready_at REAL)""")

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _parallel(self):
        return self.provider or ParallelProvider()

    @staticmethod
    def _provider_name(provider):
        if provider not in ("parallel", "demo"):
            raise EngineError("Provider must be parallel or demo.")

    def quote(self, request, provider="parallel"):
        request = validate_request(request)
        self._provider_name(provider)
        if provider == "demo":
            return {"provider": "demo", "estimated_cost_usd": "0", "actual_cost_usd": "0",
                    "is_demo": True, "cap_enforced": True, "paid_hosting_available": False}
        # Quote must not require a key or execute a network request.
        quote = self._parallel().quote(request)
        return {**quote, "provider": "parallel", "paid_hosting_available": False,
                "budget_is_local_preflight_only": True,
                "warning": "Published estimate, not a provider-enforced cap or confirmed invoice. BYOK only."}

    def _new(self, request, provider, idem, extra=None):
        if idem is None:
            idem = str(uuid.uuid4())
        if not isinstance(idem, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", idem):
            raise EngineError("Idempotency key must be 1–128 safe identifier characters.")
        digest = hashlib.sha256(canonical({"request": request, "provider": provider, "extra": extra}).encode()).hexdigest()
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM jobs WHERE idem=?", (idem,)).fetchone()
            if old:
                if old["digest"] != digest:
                    raise EngineError("Idempotency key already belongs to a different request.")
                return old["id"], False
            job_id = "rb_" + uuid.uuid4().hex
            stamp = utcnow()
            db.execute("INSERT INTO jobs(id,idem,digest,provider,request,status,created,updated) VALUES(?,?,?,?,?,?,?,?)",
                       (job_id, idem, digest, provider, canonical(request), "submitting", stamp, stamp))
            return job_id, True

    def _row(self, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r"rb_[a-f0-9]{32}", job_id):
            raise EngineError("Invalid job identifier.")
        with self._db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise EngineError("Job not found in this local store.")
        return row

    def _update(self, job_id, *, only_if=None, **fields):
        allowed = {"status", "remote_id", "block", "error", "ready_at"}
        only_if = {} if only_if is None else only_if
        if not set(fields) <= allowed or not set(only_if) <= allowed:
            raise RuntimeError("Invalid internal update")
        fields["updated"] = utcnow()
        # Compare and update in one statement: a delayed provider response must
        # not overwrite progress committed by another process using this store.
        predicate = "".join(" AND " + key + " IS ?" for key in only_if)
        with self._db() as db:
            db.execute("UPDATE jobs SET " + ",".join(key + "=?" for key in fields) + " WHERE id=?" + predicate,
                       (*fields.values(), job_id, *only_if.values()))

    def _summary(self, row):
        is_demo = row["provider"] == "demo" or (row["block"] is not None and json.loads(row["block"])["provenance"]["is_demo"])
        return {"job_id": row["id"], "status": row["status"], "provider": row["provider"],
                "provider_run_id": row["remote_id"], "created_at": row["created"],
                "updated_at": row["updated"], "is_demo": bool(is_demo),
                "error": row["error"], "actual_cost_usd": "0" if row["provider"] == "demo" else None,
                "local_processing_cost_usd": "0",
                "paid_hosting_available": False}

    def submit(self, request, provider="parallel", idempotency_key=None):
        request = validate_request(request)
        self._provider_name(provider)
        # Paid execution requires explicit configuration as well as a request budget.
        if provider == "parallel" and not idempotency_key:
            raise EngineError("Live submission requires an explicit idempotency key.")
        if provider == "parallel":
            if not self.allow_paid:
                raise EngineError("Paid provider calls disabled. Use demo/import, or explicitly enable BYOK execution.")
            quote = self.quote(request, provider)
            if Decimal(request["max_cost_usd"]) < Decimal(quote["estimated_cost_usd"]):
                raise EngineError("Budget is below the published provider estimate.")
            adapter = self._parallel()
        job_id, is_new = self._new(request, provider, idempotency_key)
        if not is_new:
            if provider == "demo" and self._row(job_id)["status"] in ("submitting", "submission_unknown"):
                self._update(job_id, status="running", ready_at=time.time() + 0.15, error=None)
            return self._summary(self._row(job_id))
        if provider == "demo":
            self._update(job_id, status="running", ready_at=time.time() + 0.15)
        else:
            try:
                run_id = adapter.submit(request)
                self._update(job_id, status="pending", remote_id=run_id)
            except ProviderError as exc:
                self._update(job_id, status="submission_unknown" if exc.ambiguous else "failed",
                             error="Submission outcome unknown; do not resubmit blindly." if exc.ambiguous else "Provider rejected submission.")
            except Exception:
                # If bytes might have left this process, no automatic second POST.
                self._update(job_id, status="submission_unknown", error="Submission outcome unknown; do not resubmit blindly.")
        return self._summary(self._row(job_id))

    def _demo_block(self, request, job_id):
        cells = []
        for candidate in request["candidates"]:
            for criterion in request["criteria"]:
                cells.append({"candidate": candidate["id"], "criterion": criterion["id"],
                              "value": "Synthetic example only", "unit": None, "currency": None,
                              "billing_basis": None, "scope": {"plan": None, "version": None, "region": None},
                              "evidence_status": "unverified", "sources": [],
                              "reason": "Offline fixture demonstrates delivery; this is not researched evidence."})
        return {"schema_version": "1.0", "request": request, "cells": cells,
                "provenance": {"provider": "demo", "run_id": job_id, "generated_at": utcnow(),
                               "is_demo": True, "actual_cost_usd": "0", "estimated_cost_usd": "0"}}

    def status(self, job_id):
        row = self._row(job_id)
        if row["status"] == "submitting" and (datetime.now(timezone.utc) - datetime.fromisoformat(row["created"].replace("Z", "+00:00"))).total_seconds() > 60:
            self._update(job_id, only_if={"status": "submitting"}, status="submission_unknown", error="Interrupted submission; reconcile the provider account before any new submission.")
        elif row["provider"] == "demo" and row["status"] == "running" and time.time() >= row["ready_at"]:
            block = validate_block(self._demo_block(json.loads(row["request"]), job_id))
            self._update(job_id, only_if={"status": "running"}, status="completed", block=canonical(block))
        elif row["provider"] == "parallel" and row["status"] in ("pending", "running"):
            try:
                state = self._parallel().status(row["remote_id"])
                if state not in ("pending", "running", "completed", "failed"):
                    raise ProviderError("Unknown provider state.", ambiguous=False)
                if row["status"] == "running" and state == "pending":
                    state = "running"
                self._update(job_id, only_if={"status": row["status"]}, status=state,
                             error="Provider reported a failed run." if state == "failed" else None)
            except ProviderError:
                # Transient poll failures do not destroy a recoverable remote job.
                self._update(job_id, only_if={"status": row["status"]},
                             error="Status temporarily unavailable; retry status, not submit.")
        return self._summary(self._row(job_id))

    def result(self, job_id):
        self.status(job_id)
        row = self._row(job_id)
        if row["status"] != "completed":
            return {**self._summary(row), "block": None}
        if row["block"] is None:
            request = json.loads(row["request"])
            try:
                block = self._parallel().result(row["remote_id"], request)
                block["provenance"] = {"provider": "parallel", "run_id": row["remote_id"],
                                       "generated_at": utcnow(), "is_demo": False,
                                       "actual_cost_usd": None,
                                       "estimated_cost_usd": self.quote(request)["estimated_cost_usd"]}
                block = validate_block(block, request=request)
            except (ProviderOutputError, ValueError, TypeError, KeyError) as exc:
                self._update(job_id, only_if={"status": "completed", "block": None}, status="result_invalid",
                             error="Provider output failed evidence validation; no verified result available.")
                raise EngineError("Provider output failed evidence validation; no verified result available.") from exc
            except ProviderError as exc:
                raise EngineError("Result temporarily unavailable; retrieve again without resubmitting.") from exc
            self._update(job_id, only_if={"status": "completed", "block": None}, block=canonical(block), error=None)
            row = self._row(job_id)
        if row["block"] is None:
            return {**self._summary(row), "block": None}
        return {**self._summary(row), "block": refresh_block(json.loads(row["block"])),
                "verification": "Structure and evidence metadata checked; factual support not independently certified."}

    def import_block(self, request, block, idempotency_key=None):
        request = validate_request(request)
        if not isinstance(block, dict):
            raise EngineError("Evidence block must be an object.")
        block = copy.deepcopy(block)
        # Bind the caller's existing evidence to this exact question before any
        # provenance replacement. Do not relabel a synthetic block as research.
        validated = validate_block(block, request=request)
        is_demo = validated["provenance"]["is_demo"]
        digest_block = {"schema_version": block.get("schema_version"), "cells": block.get("cells"), "is_demo": is_demo}
        block = validated
        block["provenance"] = {"provider": "import", "run_id": None, "generated_at": utcnow(),
                               "is_demo": is_demo, "actual_cost_usd": None, "estimated_cost_usd": "0"}
        # Ignore generated provenance/time for retry equivalence.
        job_id, is_new = self._new(request, "import", idempotency_key, extra=digest_block)
        if is_new or self._row(job_id)["status"] in ("submitting", "submission_unknown"):
            # Safe local recovery: there is no remote request or charge to repeat.
            self._update(job_id, status="completed", block=canonical(block), error=None)
        return self._summary(self._row(job_id))

    def export(self, job_id):
        result = self.result(job_id)
        if result["block"] is None:
            raise EngineError("Result is not ready for export.")
        return render_markdown(result["block"])
