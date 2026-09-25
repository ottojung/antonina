"""Top-level Antonina command-line dispatcher."""

from __future__ import annotations

import argparse
import sys
from typing import TYPE_CHECKING

from . import agent, board

if TYPE_CHECKING:
    from collections.abc import Sequence


def build_parser() -> argparse.ArgumentParser:
    """Build the root namespace-only command-line parser."""
    parser = argparse.ArgumentParser(
        prog="antonina",
        description="Manage Antonina agents and the Antonina-owned Borys board.",
    )
    commands = parser.add_subparsers(dest="namespace", metavar="NAMESPACE")
    commands.add_parser("agent", help="manage long-running agent sessions")
    commands.add_parser("board", help="manage the Antonina Borys board")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Dispatch one public Antonina namespace."""
    arguments = list(argv) if argv is not None else sys.argv[1:]
    parser = build_parser()
    if not arguments or arguments[0] in {"-h", "--help"}:
        parser.print_help()
        return 0
    namespace = arguments[0]
    rest = arguments[1:]
    if namespace == "agent":
        return int(agent.main(rest))
    if namespace == "board":
        return int(board.main(rest))
    parser.error(f"unknown namespace: {namespace}")


if __name__ == "__main__":
    raise SystemExit(main())
