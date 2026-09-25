"""Fail-closed durable metadata mutation regressions."""

from __future__ import annotations

import argparse
import fcntl
import os
import subprocess
from pathlib import Path

import pytest

from antonina import agent, durable


def _seed(aid: str) -> agent.Meta:
    meta = agent.idle_meta(aid, os.getcwd(), None)
    agent.write_meta(aid, meta)
    return meta


def test_absent_agent_directory_is_the_only_update_noop() -> None:
    """An already-deleted directory is the sole intentional update no-op."""
    called = False

    def mutate(_meta: agent.Meta) -> None:
        nonlocal called
        called = True

    assert agent.update_meta("ab", mutate) is False
    assert called is False


def test_broken_directory_symlink_is_not_treated_as_deleted(
    tmp_path: Path,
) -> None:
    """A present but unusable agent path never receives the deletion no-op."""
    agent.agents_dir().mkdir(parents=True)
    agent.agent_dir("ab").symlink_to(tmp_path / "missing", target_is_directory=True)

    with pytest.raises(agent.MetadataUpdateError, match="not a directory"):
        agent.update_meta("ab", lambda _meta: None)


def test_lock_open_failure_is_not_suppressed() -> None:
    """A metadata lock that cannot be opened aborts the mutation."""
    aid = "ab"
    _seed(aid)
    (agent.agent_dir(aid) / ".lock").mkdir()
    called = False

    def mutate(_meta: agent.Meta) -> None:
        nonlocal called
        called = True

    with pytest.raises(agent.MetadataUpdateError, match="cannot open agent metadata lock"):
        agent.update_meta(aid, mutate)
    assert called is False


def test_flock_failure_is_not_suppressed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Failure to acquire the metadata lock aborts the mutation."""
    aid = "ab"
    original = _seed(aid)
    called = False

    def fail_flock(_fd: int, _operation: int) -> None:
        raise OSError("injected flock failure")

    def mutate(_meta: agent.Meta) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(fcntl, "flock", fail_flock)
    with pytest.raises(agent.MetadataUpdateError, match="cannot lock agent metadata"):
        agent.update_meta(aid, mutate)
    assert called is False
    assert agent.read_meta(aid) == original


def test_metadata_read_failure_is_not_suppressed() -> None:
    """An unreadable metadata file aborts rather than looking like a no-op."""
    aid = "ab"
    directory = agent.agent_dir(aid)
    (directory / "meta.json").mkdir(parents=True)
    called = False

    def mutate(_meta: agent.Meta) -> None:
        nonlocal called
        called = True

    with pytest.raises(agent.MetadataUpdateError, match="unavailable or malformed"):
        agent.update_meta(aid, mutate)
    assert called is False


def test_malformed_mutation_result_is_not_written() -> None:
    """An update callback cannot commit a document outside the current schema."""
    aid = "ab"
    original = _seed(aid)

    with pytest.raises(agent.MetadataUpdateError, match="produced malformed schema"):
        agent.update_meta(aid, lambda meta: meta.update({"state": "paused"}))

    assert agent.read_meta(aid) == original


def test_durable_write_failure_is_not_suppressed() -> None:
    """A failed metadata durability confirmation restores and re-raises."""
    aid = "ab"
    original = _seed(aid)
    durable.set_one_shot_fsync_failure_injector(
        stage=durable.FSYNC_STAGE_DIR,
        path=agent.agent_dir(aid),
    )
    try:
        with pytest.raises(durable.DurabilityError):
            agent.update_meta(aid, lambda meta: meta.update({"title": "changed"}))
    finally:
        durable.clear_fsync_failure_injector()

    assert agent.read_meta(aid) == original


def test_unlock_failure_is_not_suppressed(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unlock failure remains visible after a committed metadata replace."""
    aid = "ab"
    _seed(aid)
    original_flock = fcntl.flock

    def fail_unlock(fd: int, operation: int) -> None:
        if operation == fcntl.LOCK_UN:
            raise OSError("injected unlock failure")
        original_flock(fd, operation)

    monkeypatch.setattr(fcntl, "flock", fail_unlock)
    with pytest.raises(agent.MetadataUpdateError, match="cannot unlock agent metadata"):
        agent.update_meta(aid, lambda meta: meta.update({"title": "changed"}))
    final = agent.read_meta(aid)
    assert final is not None
    assert final["title"] == "changed"


def test_runner_spawn_fallback_stops_when_metadata_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The no-generation spawn path never launches without durable reservation authority."""
    monkeypatch.setattr(agent, "read_meta", lambda _aid: None)
    monkeypatch.setattr(
        subprocess,
        "Popen",
        lambda *_a, **_k: pytest.fail("runner launched without readable durable authority"),
    )

    with pytest.raises(agent.MetadataUpdateError, match="unavailable or malformed"):
        agent.spawn_runner("ab", "new")


def test_prompt_launch_stops_when_reservation_update_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed durable prompt decision never launches a runner."""
    aid = "ab"
    _seed(aid)

    def fail_update(_aid: str, _mutate: object) -> bool:
        raise agent.MetadataUpdateError("injected update failure")

    monkeypatch.setattr(agent, "update_meta", fail_update)
    monkeypatch.setattr(
        agent,
        "spawn_runner",
        lambda *_a, **_k: pytest.fail("runner launched without durable authority"),
    )
    args = argparse.Namespace(
        id=aid,
        prompt_text="work",
        prompt=None,
        steer=False,
        detach=True,
        json=False,
    )

    with pytest.raises(agent.MetadataUpdateError, match="injected update failure"):
        agent._dispatch_invocation(args, "work")


def test_stop_signal_stops_when_intent_update_fails() -> None:
    """A failed durable stop intent never authorizes process signalling."""
    aid = "ab"
    meta = _seed(aid)
    meta.update({
        "state": "running",
        "pid": 4242,
        "pgid": 4242,
        "start_time": 1234,
        "invocation_id": "0123456789abcdef0123456789abcdef",
    })
    agent.write_meta(aid, meta)
    (agent.agent_dir(aid) / ".lock").mkdir()

    with pytest.raises(agent.MetadataUpdateError, match="cannot open agent metadata lock"):
        agent._signal_live_invocation(aid, meta, "stop")


def test_failed_finalize_prerequisite_never_claims_success() -> None:
    """A terminal-state write failure never reports a completed stop."""
    aid = "ab"
    meta = _seed(aid)
    meta["state"] = "running"
    agent.write_meta(aid, meta)
    (agent.agent_dir(aid) / ".lock").mkdir()
    identity = agent._invocation_identity(meta)

    with pytest.raises(agent.MetadataUpdateError, match="cannot open agent metadata lock"):
        agent._finish_stop_like(
            aid,
            identity,
            (0, 2, "stopped", "stop"),
            "stopped agent",
        )

    final = agent.read_meta(aid)
    assert final is not None
    assert final["state"] == "running"


def test_delete_prerequisite_failure_never_removes_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed durable tombstone never proceeds to deletion."""
    aid = "ab"
    _seed(aid)
    (agent.agent_dir(aid) / ".lock").mkdir()
    monkeypatch.setattr(
        agent,
        "_remove_deleted_state",
        lambda _aid: pytest.fail("state removed without durable deletion authority"),
    )
    args = argparse.Namespace(id=aid, force=False)

    with pytest.raises(agent.MetadataUpdateError, match="cannot open agent metadata lock"):
        agent.cmd_delete(args)
    assert (agent.agent_dir(aid) / "meta.json").is_file()
