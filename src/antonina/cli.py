"""Top-level Antonina command-line dispatcher."""

from __future__ import annotations

import argparse
from typing import TYPE_CHECKING

from . import agent, board

if TYPE_CHECKING:
    from collections.abc import Sequence

EXIT_USAGE = 2


def build_parser() -> argparse.ArgumentParser:
    """Build the public Antonina command-line parser."""
    parser = argparse.ArgumentParser(
        prog="antonina",
        description="Manage Antonina agents and the Antonina-owned Borys board.",
    )
    commands = parser.add_subparsers(dest="namespace", metavar="NAMESPACE")
    commands.required = True
    agent_command = commands.add_parser("agent", help="manage long-running agent sessions")
    agent_subcommands = agent_command.add_subparsers(dest="agent_command", metavar="COMMAND")
    for spec in agent.SUBCOMMANDS:
        agent_subcommands.add_parser(spec.name, help=spec.help)
    agent_command.set_defaults(namespace_func=agent.main)
    board_command = commands.add_parser("board", help="manage the Antonina Borys board")
    board_subcommands = board_command.add_subparsers(dest="board_command", metavar="COMMAND")
    for name, help_text in (
        ("list", "list Borys issues"),
        ("show", "show one Borys issue"),
        ("create", "create a Borys issue"),
        ("edit", "edit an open Borys issue"),
        ("comment", "comment on a Borys issue"),
        ("close", "close a Borys issue"),
        ("reopen", "reopen a Borys issue"),
        ("resource", "manage durable resources"),
    ):
        board_subcommands.add_parser(name, help=help_text)
    board_command.set_defaults(namespace_func=board.main)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Dispatch one public Antonina command."""
    parser = build_parser()
    args, namespace_args = parser.parse_known_args(argv)
    command = getattr(args, "agent_command", None) or getattr(args, "board_command", None)
    if command is not None:
        namespace_args = [command, *namespace_args]
    return int(args.namespace_func(namespace_args))


if __name__ == "__main__":
    raise SystemExit(main())
