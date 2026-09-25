"""Metadata persistence failures must never authorize lifecycle progress."""

from __future__ import annotations

import errno
import fcntl
import shutil
from pathlib import Path
from typing import Any

import pytest

from antonina import agent
from antonina.durable import (
    FSYNC_STAGE_DIR,
    DurabilityError,
    clear_fsync_failure_injector,
    set_one_shot_fsync_failure_injector,
)


def _seed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, aid: str = "abc123") -> agent.Meta:
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    meta = agent.idle_meta(aid, str(tmp_path), None)
    agent.write_meta(aid, meta)
    return meta


def test_lock_open_failure_is_not_suppressed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    _seed(monkeypatch, tmp_path, aid)
    lock_path = tmp_path / aid / ".lock"
    real_open = Path.open

    def fail_lock_open(path: Path, *args: Any, **kwargs: Any) -> Any:
        if path == lock_path:
            raise OSError(errno.EACCES, "lock denied")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", fail_lock_open)
    called = False

    def mutate(_meta: agent.Meta) -> None:
        nonlocal called
        called = True

    with pytest.raises(agent.MetadataError, match="open metadata lock"):
        agent.update_meta(aid, mutate)
    assert called is False


def test_flock_failure_is_not_suppressed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    aid = "abc123"
    _seed(monkeypatch, tmp_path, aid)
    real_flock = fcntl.flock
    failed = False

    def fail_acquire(fd: int, operation: int) -> None:
        nonlocal failed
        if operation == fcntl.LOCK_EX and not failed:
            failed = True
            raise OSError(errno.EIO, "flock failed")
        real_flock(fd, operation)

    monkeypatch.setattr(fcntl, "flock", fail_acquire)
    called = False

    def mutate(_meta: agent.Meta) -> None:
        nonlocal called
        called = True

    with pytest.raises(agent.MetadataError, match="acquire metadata lock"):
        agent.update_meta(aid, mutate)
    assert called is False


def test_write_failure_is_not_suppressed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    aid = "abc123"
    original = _seed(monkeypatch, tmp_path, aid)

    def fail_write(_path: Path, _text: str, **_kwargs: Any) -> None:
        raise OSError(errno.ENOSPC, "metadata write failed")

    monkeypatch.setattr(agent, "write_text_durable", fail_write)
    with pytest.raises(agent.MetadataError, match="persist metadata"):
        agent.update_meta(aid, lambda meta: meta.update({"title": "changed"}))
    assert agent.read_meta(aid) == original


def test_directory_setup_failure_is_not_suppressed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    _seed(monkeypatch, tmp_path, aid)
    directory = tmp_path / aid
    real_mkdir = Path.mkdir

    def fail_directory(path: Path, *args: Any, **kwargs: Any) -> None:
        if path == directory:
            raise OSError(errno.EACCES, "directory unavailable")
        real_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", fail_directory)
    with pytest.raises(OSError, match="directory unavailable"):
        agent.write_meta(aid, agent.read_meta(aid) or agent.idle_meta(aid, str(tmp_path), None))


def test_directory_fsync_failure_propagates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    _seed(monkeypatch, tmp_path, aid)
    set_one_shot_fsync_failure_injector(stage=FSYNC_STAGE_DIR)
    try:
        with pytest.raises(DurabilityError):
            agent.update_meta(aid, lambda meta: meta.update({"title": "changed"}))
    finally:
        clear_fsync_failure_injector()


def test_late_update_does_not_recreate_deleted_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    _seed(monkeypatch, tmp_path, aid)
    directory = tmp_path / aid

    def delete_during_mutation(_meta: agent.Meta) -> None:
        shutil.rmtree(directory)

    with pytest.raises(agent.MetadataError, match="disappeared before persistence"):
        agent.update_meta(aid, delete_during_mutation)
    assert not directory.exists()


def test_missing_directory_is_the_only_update_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(agent, "agent_dir", lambda value: Path("/definitely/missing/agent"))
    called = False

    def mutate(_meta: agent.Meta) -> None:
        nonlocal called
        called = True

    agent.update_meta("abc123", mutate)
    assert called is False


def test_prompt_does_not_spawn_after_metadata_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    _seed(monkeypatch, tmp_path, aid)
    monkeypatch.setattr(agent, "_configured_model_available", lambda _env: None)

    def fail_update(_aid: str, _mutate: object) -> None:
        raise agent.MetadataError("injected metadata failure")

    monkeypatch.setattr(agent, "update_meta", fail_update)
    monkeypatch.setattr(
        agent,
        "spawn_runner",
        lambda *_args, **_kwargs: pytest.fail("runner launched after metadata failure"),
    )

    assert agent.main(["prompt", "--id", aid, "--detach", "work"]) == agent.EXIT_ERROR


@pytest.mark.parametrize("command", ["stop", "delete"])
def test_control_does_not_signal_or_delete_after_metadata_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, command: str
) -> None:
    aid = "abc123"
    meta = _seed(monkeypatch, tmp_path, aid)
    if command == "stop":
        meta["state"] = "running"
        agent.write_meta(aid, meta)
        monkeypatch.setattr(agent, "is_alive", lambda _meta: True)
    monkeypatch.setattr(agent, "group_alive", lambda _meta: False)
    monkeypatch.setattr(agent, "runner_alive", lambda _meta: False)
    monkeypatch.setattr(agent, "reservation_in_flight", lambda _meta: False)

    def fail_update(_aid: str, _mutate: object) -> None:
        raise agent.MetadataError("injected metadata failure")

    monkeypatch.setattr(agent, "update_meta", fail_update)
    monkeypatch.setattr(
        agent,
        "send_signal_group",
        lambda *_args: pytest.fail("signal sent after metadata failure"),
    )
    monkeypatch.setattr(
        agent,
        "_converge_for_delete",
        lambda *_args, **_kwargs: pytest.fail("delete continued after metadata failure"),
    )

    assert agent.main([command, "--id", aid]) == agent.EXIT_ERROR
