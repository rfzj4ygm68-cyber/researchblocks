#!/usr/bin/env python3
"""Run the self-contained ResearchBlocks CLI shipped with this skill."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent / "runtime"))
from researchblocks.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
