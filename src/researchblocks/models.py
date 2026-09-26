"""Bounded evidence contracts. Validation checks structure, never factual truth.

No URL is fetched by this module. Provider text and excerpts remain untrusted
data; neither a well-formed citation nor ``supported`` authenticates a claim.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import html
import ipaddress
import math
import re
from urllib.parse import quote, urlsplit, urlunsplit


_ID = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_MONEY = re.compile(r"^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,8})?$")
_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_CURRENCY = re.compile(r"^[A-Z]{3,10}$")
_STATES = {"supported", "conflicting", "not_found", "stale", "unverified"}
_PRIVATE_SUFFIXES = {"localhost", "local", "internal", "lan", "home", "test", "invalid", "onion"}
_UTC = timezone.utc


def _error(field: str, requirement: str) -> ValueError:
    # Include only fixed field names, never caller text, URLs, credentials or values.
    return ValueError(f"{field}: {requirement}")


def _object(value, fields: set[str], field: str) -> dict:
    if type(value) is not dict or set(value) != fields:
        raise _error(field, "must be an object with exactly the documented fields")
    return value


def _text(value, field: str, limit: int, *, empty: bool = False) -> str:
    if type(value) is not str or len(value) > limit or (not empty and not value.strip()):
        raise _error(field, f"must be a {'nonempty ' if not empty else ''}string of at most {limit} characters")
    if any(ord(c) < 32 and c not in "\n\t" for c in value) or "\x7f" in value:
        raise _error(field, "contains prohibited control characters")
    return value


def _nullable_text(value, field: str, limit: int) -> str | None:
    return None if value is None else _text(value, field, limit)


def _identifier(value, field: str) -> str:
    if type(value) is not str or not _ID.fullmatch(value):
        raise _error(field, "must be a lowercase identifier of 1 to 64 characters")
    return value


def _domain(value, field: str = "official_domains") -> str:
    if type(value) is not str or len(value) > 253:
        raise _error(field, "must contain plain public DNS hostnames")
    domain = value.lower()
    parts = domain.split(".")
    if len(parts) < 2 or any(not _LABEL.fullmatch(p) for p in parts):
        raise _error(field, "must contain plain public DNS hostnames")
    if parts[-1] in _PRIVATE_SUFFIXES or parts[-1].isdigit():
        raise _error(field, "local, reserved or IP hosts are not permitted")
    try:
        ipaddress.ip_address(domain)
    except ValueError:
        pass
    else:
        raise _error(field, "IP hosts are not permitted")
    return domain


def _money(value, field: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if type(value) is not str or not _MONEY.fullmatch(value):
        raise _error(field, "must be a nonnegative decimal string with at most 8 decimal places")
    try:
        amount = Decimal(value)
    except InvalidOperation:
        raise _error(field, "must be a nonnegative decimal string") from None
    if amount > Decimal("1000"):
        raise _error(field, "must not exceed 1000 USD")
    canonical = format(amount, "f")
    return canonical.rstrip("0").rstrip(".") if "." in canonical else canonical


def _date(value, field: str) -> datetime:
    value = _text(value, field, 40)
    # Reject naive dates, surprising ISO week/date formats and non-UTC offsets.
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value):
        raise _error(field, "must be an ISO8601 UTC timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise _error(field, "must be a valid ISO8601 UTC timestamp") from None


def _date_text(value: datetime) -> str:
    return value.astimezone(_UTC).isoformat().replace("+00:00", "Z")


def _clock(now) -> datetime:
    if now is None:
        return datetime.now(_UTC)
    if type(now) is str:
        return _date(now, "now")
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise _error("now", "must be a timezone-aware datetime or UTC timestamp")
    return now.astimezone(_UTC)


def validate_request(request: dict) -> dict:
    """Return a fresh normalized request, rejecting extra fields and unsafe hosts."""
    request = _object(request, {"candidates", "criteria", "max_age_hours", "max_cost_usd"}, "request")
    candidates = request["candidates"]
    criteria = request["criteria"]
    if type(candidates) is not list or not 1 <= len(candidates) <= 3:
        raise _error("candidates", "must contain 1 to 3 entries")
    if type(criteria) is not list or not 1 <= len(criteria) <= 5:
        raise _error("criteria", "must contain 1 to 5 entries")
    normalized_candidates = []
    seen = set()
    for candidate in candidates:
        candidate = _object(candidate, {"id", "label", "official_domains"}, "candidate")
        candidate_id = _identifier(candidate["id"], "candidate.id")
        if candidate_id in seen:
            raise _error("candidate.id", "must be unique")
        seen.add(candidate_id)
        domains = candidate["official_domains"]
        if type(domains) is not list or not 1 <= len(domains) <= 10:
            raise _error("official_domains", "must contain 1 to 10 hostnames")
        normalized_domains = [_domain(d) for d in domains]
        if len(set(normalized_domains)) != len(normalized_domains):
            raise _error("official_domains", "must be unique")
        normalized_candidates.append({"id": candidate_id, "label": _text(candidate["label"], "candidate.label", 120), "official_domains": normalized_domains})
    normalized_criteria = []
    seen.clear()
    for criterion in criteria:
        criterion = _object(criterion, {"id", "question"}, "criterion")
        criterion_id = _identifier(criterion["id"], "criterion.id")
        if criterion_id in seen:
            raise _error("criterion.id", "must be unique")
        seen.add(criterion_id)
        normalized_criteria.append({"id": criterion_id, "question": _text(criterion["question"], "criterion.question", 500)})
    hours = request["max_age_hours"]
    if type(hours) not in (int, float) or not 0 < hours <= 8760 or not math.isfinite(hours):
        raise _error("max_age_hours", "must be a finite number greater than 0 and at most 8760")
    return {"candidates": normalized_candidates, "criteria": normalized_criteria, "max_age_hours": hours,
            "max_cost_usd": _money(request["max_cost_usd"], "max_cost_usd")}


def _source(value, domains: list[str], now: datetime) -> dict:
    source = _object(value, {"url", "excerpt", "retrieved_at"}, "source")
    url = _text(source["url"], "source.url", 2048)
    if any(c.isspace() or c in "\\<>\"" for c in url):
        raise _error("source.url", "contains prohibited URL characters")
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        raise _error("source.url", "must be an HTTPS URL on an allowed official domain") from None
    if parsed.scheme != "https" or not host or parsed.username is not None or parsed.password is not None or port not in (None, 443):
        raise _error("source.url", "must be an HTTPS URL without credentials on port 443")
    host = _domain(host, "source.url")
    if not any(host == domain or host.endswith("." + domain) for domain in domains):
        raise _error("source.url", "must match this candidate's allowed official domains")
    retrieved = None if source["retrieved_at"] is None else _date(source["retrieved_at"], "source.retrieved_at")
    if retrieved is not None and retrieved > now + timedelta(minutes=5):
        raise _error("source.retrieved_at", "must not be more than 5 minutes in the future")
    return {"url": urlunsplit(("https", host, parsed.path or "/", parsed.query, parsed.fragment)),
            "excerpt": _text(source["excerpt"], "source.excerpt", 600), "retrieved_at": None if retrieved is None else _date_text(retrieved)}


def validate_block(block: dict, request: dict | None = None, now=None) -> dict:
    """Validate and copy a complete comparison matrix; downgrade aged evidence.

    ``supported`` is the submitter's evidence assertion, not independent verification.
    Optional ``request`` binds output to the submitted request exactly after normalization.
    """
    now = _clock(now)
    block = _object(block, {"schema_version", "request", "cells", "provenance"}, "block")
    if block["schema_version"] != "1.0":
        raise _error("schema_version", "must be 1.0")
    normalized_request = validate_request(block["request"])
    if request is not None and normalized_request != validate_request(request):
        raise _error("request", "does not match the submitted request")
    candidates = {candidate["id"]: candidate for candidate in normalized_request["candidates"]}
    pairs = {(candidate["id"], criterion["id"]) for candidate in normalized_request["candidates"] for criterion in normalized_request["criteria"]}
    if type(block["cells"]) is not list or len(block["cells"]) != len(pairs):
        raise _error("cells", "must contain exactly one cell for each candidate and criterion")
    fields = {"candidate", "criterion", "value", "unit", "currency", "billing_basis", "scope", "evidence_status", "sources", "reason"}
    cells = {}
    urls = set()
    for cell in block["cells"]:
        cell = _object(cell, fields, "cell")
        pair = (_identifier(cell["candidate"], "cell.candidate"), _identifier(cell["criterion"], "cell.criterion"))
        if pair not in pairs or pair in cells:
            raise _error("cells", "contains a duplicate or unexpected candidate and criterion")
        state = cell["evidence_status"]
        if type(state) is not str or state not in _STATES:
            raise _error("evidence_status", "must be a documented evidence state")
        value = cell["value"]
        if value is not None and type(value) not in (str, int, float, bool):
            raise _error("cell.value", "must be a JSON scalar or null")
        if type(value) is str:
            _text(value, "cell.value", 4000)
        if type(value) in (float, int) and (abs(value) > 1e15 or not math.isfinite(value)):
            raise _error("cell.value", "must be a finite number with magnitude at most 1e15")
        if type(cell["sources"]) is not list or len(cell["sources"]) > 10:
            raise _error("sources", "must be a list with at most 10 entries")
        sources = [_source(source, candidates[pair[0]]["official_domains"], now) for source in cell["sources"]]
        cell_urls = {source["url"] for source in sources}
        if len(cell_urls) != len(sources):
            raise _error("sources", "must not contain duplicate URLs in one cell")
        urls.update(cell_urls)
        if len(urls) > 10:
            raise _error("sources", "must cite at most 10 distinct URLs across the block")
        if state == "supported" and (value is None or not sources):
            raise _error("evidence_status", "supported requires a value and cited evidence")
        if state == "stale" and not sources:
            raise _error("evidence_status", "stale requires cited evidence")
        if state == "conflicting" and len(cell_urls) < 2:
            raise _error("evidence_status", "conflicting requires at least two distinct cited URLs")
        if state == "not_found" and value is not None:
            raise _error("evidence_status", "not_found requires a null value")
        reason = _text(cell["reason"], "cell.reason", 1000)
        unknown_freshness = any(source["retrieved_at"] is None for source in sources)
        stale = any(source["retrieved_at"] is not None and (now - _date(source["retrieved_at"], "source.retrieved_at")).total_seconds() > normalized_request["max_age_hours"] * 3600 for source in sources)
        if unknown_freshness and state in {"supported", "conflicting", "stale"}:
            previous_state = state
            state = "unverified"
            reason = ("Source retrieval time is unknown; freshness cannot be verified. " + ("Previously marked conflicting. " if previous_state == "conflicting" else "") + reason)[:1000]
        elif stale and state in {"supported", "conflicting"}:
            state = "stale"
            # Preserve conflict semantics even though the single status now reports freshness.
            note = "Evidence exceeds the requested freshness window."
            if cell["evidence_status"] == "conflicting":
                note += " Previously marked conflicting."
            reason = (note + " " + reason)[:1000]
        scope = _object(cell["scope"], {"plan", "version", "region"}, "scope")
        currency = _nullable_text(cell["currency"], "currency", 10)
        if currency is not None and not _CURRENCY.fullmatch(currency):
            raise _error("currency", "must be an uppercase 3 to 10 character currency code or null")
        cells[pair] = {"candidate": pair[0], "criterion": pair[1], "value": value,
                       "unit": _nullable_text(cell["unit"], "unit", 120), "currency": currency,
                       "billing_basis": _nullable_text(cell["billing_basis"], "billing_basis", 200),
                       "scope": {key: _nullable_text(scope[key], "scope." + key, 200) for key in ("plan", "version", "region")},
                       "evidence_status": state, "sources": sources, "reason": reason}
    provenance = _object(block["provenance"], {"provider", "run_id", "generated_at", "is_demo", "actual_cost_usd", "estimated_cost_usd"}, "provenance")
    if type(provenance["provider"]) is not str or provenance["provider"] not in {"import", "parallel", "openai", "demo"}:
        raise _error("provenance.provider", "must be import, parallel, openai or demo")
    if type(provenance["is_demo"]) is not bool or (provenance["provider"] == "demo" and not provenance["is_demo"]):
        raise _error("provenance.is_demo", "must be boolean and true for demo provenance")
    generated = _date(provenance["generated_at"], "provenance.generated_at")
    if generated > now + timedelta(minutes=5):
        raise _error("provenance.generated_at", "must not be more than 5 minutes in the future")
    normalized_provenance = {"provider": provenance["provider"], "run_id": _nullable_text(provenance["run_id"], "provenance.run_id", 200),
                             "generated_at": _date_text(generated), "is_demo": provenance["is_demo"],
                             "actual_cost_usd": _money(provenance["actual_cost_usd"], "actual_cost_usd", nullable=True),
                             "estimated_cost_usd": _money(provenance["estimated_cost_usd"], "estimated_cost_usd", nullable=True)}
    ordered = [cells[(candidate["id"], criterion["id"])] for candidate in normalized_request["candidates"] for criterion in normalized_request["criteria"]]
    return {"schema_version": "1.0", "request": normalized_request, "cells": ordered, "provenance": normalized_provenance}


def refresh_block(block: dict, now=None) -> dict:
    """Recheck freshness without network activity or mutation; never upgrade evidence."""
    return validate_block(block, now=now)


def _markdown(value) -> str:
    if value is None:
        return "—"
    value = html.escape(str(value), quote=True)
    # Escape source-controlled Markdown and prevent injected rows/headings or links.
    for character in "\\`*_{}[]()#+-.!|":
        value = value.replace(character, "\\" + character)
    return value.replace("\r", " ").replace("\n", " ").replace("\t", " ")


def _source_link(url: str) -> str:
    # Called only after candidate-domain/HTTPS validation. Percent-encode Markdown
    # delimiters while retaining URI separators and existing percent escapes.
    # Entity-escape '&' to preserve query strings through CommonMark decoding.
    destination = quote(url, safe=":/?&=#%+;,@!$~*.-_")
    destination = html.escape(destination, quote=False)
    return "[Source](<" + destination + ">)"


def render_markdown(block: dict) -> str:
    """Render inert evidence text and explicit validated HTTPS source links."""
    block = validate_block(block)
    provenance = block["provenance"]
    candidates = {candidate["id"]: candidate["label"] for candidate in block["request"]["candidates"]}
    criteria = {criterion["id"]: criterion["question"] for criterion in block["request"]["criteria"]}
    lines = ["# Research block", "", "Structure validated; claims and source authenticity are not independently verified.", ""]
    if provenance["is_demo"]:
        lines += ["**SYNTHETIC DEMO — not real research or paid activity.**", ""]
    lines += ["| Candidate | Criterion | Value | Unit | Currency | Billing basis | Scope | Evidence |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for cell in block["cells"]:
        scope = "; ".join(f"{key}: {value}" for key, value in cell["scope"].items() if value is not None) or None
        values = [candidates[cell["candidate"]], criteria[cell["criterion"]], cell["value"], cell["unit"], cell["currency"], cell["billing_basis"], scope, cell["evidence_status"]]
        lines.append("| " + " | ".join(_markdown(value) for value in values) + " |")
    lines += ["", "## Evidence", ""]
    for cell in block["cells"]:
        lines.append("### " + _markdown(candidates[cell["candidate"]]) + " / " + _markdown(criteria[cell["criterion"]]))
        lines.extend(["", _markdown(cell["reason"]), ""])
        if not cell["sources"]:
            lines.extend(["No cited evidence supplied.", ""])
        for source in cell["sources"]:
            lines.extend(["- " + _source_link(source["url"]), "- Retrieved: " + (_markdown(source["retrieved_at"]) if source["retrieved_at"] is not None else "unknown"), "- Excerpt (untrusted source text): " + _markdown(source["excerpt"]), ""])
    lines += ["## Provenance", "", "Provider: " + _markdown(provenance["provider"]), "", "Run ID: " + (_markdown(provenance["run_id"]) if provenance["run_id"] is not None else "unavailable"), "", "Generated: " + _markdown(provenance["generated_at"]), "",
              "Requested freshness (hours): " + _markdown(block["request"]["max_age_hours"]), "",
              "Requested budget (USD; not a supplier-enforced cap): " + _markdown(block["request"]["max_cost_usd"]), "",
              "Estimated supplier cost (USD): " + (_markdown(provenance["estimated_cost_usd"]) if provenance["estimated_cost_usd"] is not None else "unavailable"), "",
              "Actual billed cost (USD): " + (_markdown(provenance["actual_cost_usd"]) if provenance["actual_cost_usd"] is not None else "unavailable"), ""]
    return "\n".join(lines)
