"""Strict durable working-directory authority for managed agents."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

from antonina import agent

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture(autouse=True)
def state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate managed-agent durable state.

    Returns:
        The isolated state directory.
    """
    state = tmp_path / "state"
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    return state


def test_build_agent_command_preserves_valid_persisted_cwd() -> None:
    """Pass the exact durable working directory to opencode."""
    cwd = "/workspace/exact-agent-tree"
    command = agent.build_agent_command(
        {"id": "aaaaaaaa", "cwd": cwd},
        "do work",
        is_continue=False,
    )

    assert command is not None
    assert command[command.index("--dir") + 1] == cwd


def test_build_agent_command_rejects_malformed_persisted_cwd() -> None:
    """Reject malformed durable cwd values instead of normalizing them."""
    bad_cwds: tuple[object, ...] = ("", 0, False, None, [], "relative", "./relative", "../relative")
    for cwd in bad_cwds:
        meta: agent.Meta = {"id": "aaaaaaaa", "cwd": cwd}

        with pytest.raises(ValueError, match="managed-agent cwd is malformed"):
            agent.build_agent_command(meta, "do work", is_continue=False)


def test_runner_malformed_schema_fails_before_spawn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Malformed current-schema metadata never reaches runner execution."""
    aid = "aaaaaaaa"
    meta = agent.idle_meta(aid, os.getcwd(), None)
    meta["cwd"] = ""
    agent.write_meta(aid, meta)
    monkeypatch.setenv("ANTONINA_RUNNER_GEN", "1")
    monkeypatch.setattr(
        agent,
        "_runner_loop",
        lambda *_a, **_kw: pytest.fail("underlying runner started with malformed cwd"),
    )

    agent.runner(aid, "new")

    assert agent.read_meta(aid) is None
