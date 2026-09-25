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
        agent.idle_meta("aaaaaaaa", cwd, None),
        "do work",
        is_continue=False,
    )

    assert command is not None
    assert command[command.index("--dir") + 1] == cwd


def test_build_agent_command_rejects_malformed_persisted_cwd() -> None:
    """Reject malformed durable cwd values instead of normalizing them."""
    bad_cwds: tuple[object, ...] = ("", 0, False, None, [], "relative", "./relative", "../relative")
    for cwd in bad_cwds:
        meta = agent.idle_meta("aaaaaaaa", str(cwd), None)

        with pytest.raises(ValueError, match="managed-agent cwd is malformed"):
            agent.build_agent_command(meta, "do work", is_continue=False)


def test_runner_malformed_cwd_fails_before_spawn_and_aborts_cleanly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Abort a claimed runner before spawn when durable cwd is malformed."""
    aid = "aaaaaaaa"
    meta = agent.idle_meta(aid, "", None)
    meta["runner_reservation"] = {
        "state": "reserved",
        "gen": 1,
        "owner_pid": os.getpid(),
        "owner_start_ticks": agent.proc_start_ticks(os.getpid()),
        "reserved_at": 1.0,
        "mode": "new",
    }
    agent.write_meta(aid, meta)
    monkeypatch.setenv("ANTONINA_RUNNER_GEN", "1")
    monkeypatch.setattr(
        agent,
        "_runner_loop",
        lambda *_a, **_kw: pytest.fail("underlying runner started with malformed cwd"),
    )
    monkeypatch.setattr(agent, "send_signal_group", lambda _m, _sig: None)
    monkeypatch.setattr(agent, "wait_group_dead", lambda _m, _timeout: True)

    with pytest.raises(agent.MetadataError, match="missing, malformed, or unsupported"):
        agent.runner(aid, "new")
    assert agent.read_meta(aid) is None
