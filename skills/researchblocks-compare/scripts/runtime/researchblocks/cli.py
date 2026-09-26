"""Small CLI: no network by default, JSON on stdout."""
import argparse
import json
import sys
import sqlite3
from pathlib import Path

from .engine import Engine


def load(path):
    with open(path, "rb") as stream:
        raw = stream.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("Input file exceeds 1 MiB.")
    return json.loads(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="researchblocks")
    parser.add_argument("--db", help="Local private SQLite store")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("quote", "submit"):
        cmd = sub.add_parser(name)
        cmd.add_argument("request")
        cmd.add_argument("--provider", choices=["parallel", "demo"], default="demo" if name == "submit" else "parallel")
        if name == "submit":
            cmd.add_argument("--idempotency-key", required=True)
    for name in ("status", "result", "export"):
        sub.add_parser(name).add_argument("job_id")
    imp = sub.add_parser("import")
    imp.add_argument("request")
    imp.add_argument("block")
    imp.add_argument("--idempotency-key", required=True)
    sub.add_parser("mcp")
    args = parser.parse_args(argv)
    try:
        engine = Engine(args.db)
        if args.command == "mcp":
            from .mcp import serve
            serve(engine)
            return 0
        if args.command == "quote":
            result = engine.quote(load(args.request), args.provider)
        elif args.command == "submit":
            result = engine.submit(load(args.request), args.provider, args.idempotency_key)
        elif args.command == "import":
            result = engine.import_block(load(args.request), load(args.block), args.idempotency_key)
        else:
            result = getattr(engine, args.command)(args.job_id)
        print(result if isinstance(result, str) else json.dumps(result, indent=2, allow_nan=False))
        return 0
    except (ValueError, OSError, sqlite3.Error, RecursionError) as exc:
        # File/SQLite paths and provider bodies must not leak through MCP/CLI errors.
        message = str(exc) if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError) else "Unable to read input or local data store."
        print(json.dumps({"error": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
