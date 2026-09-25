"""Current metadata schema boundary regressions."""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest

from antonina import agent


def _write_raw(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_idle_meta_contains_the_complete_current_schema(tmp_path: Path) -> None:
    meta = agent.idle_meta("abc123", str(tmp_path), None)

    assert set(meta) == set(agent.CANONICAL_META_FIELDS)
    assert meta["agent_version"] == agent.AGENT_META_VERSION
    assert meta["state"] == "idle"
    assert meta["pending_prompt"] is None
    assert meta["active_runner"] is False
    assert meta["delete_pending"] is False


@pytest.mark.parametrize("version", [None, 2, 4, 3.0, True, "3"])
def test_read_meta_rejects_unknown_or_old_schema_versions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, version: object
) -> None:
    aid = "abc123"
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    meta = agent.idle_meta(aid, str(tmp_path), None)
    meta["agent_version"] = version
    _write_raw(tmp_path / aid / "meta.json", meta)

    assert agent.read_meta(aid) is None


@pytest.mark.parametrize("field", sorted(agent.CANONICAL_META_FIELDS))
def test_read_meta_rejects_each_missing_required_field(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, field: str
) -> None:
    aid = "abc123"
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    meta = agent.idle_meta(aid, str(tmp_path), None)
    del meta[field]
    _write_raw(tmp_path / aid / "meta.json", meta)

    assert agent.read_meta(aid) is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("invocation_id", 123),
        ("prompt_count", "0"),
        ("active_runner", "false"),
        ("delete_pending", 0),
        ("state", "paused"),
    ],
)
def test_read_meta_rejects_malformed_authority_fields(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, field: str, value: object
) -> None:
    aid = "abc123"
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    meta = agent.idle_meta(aid, str(tmp_path), None)
    meta[field] = value
    _write_raw(tmp_path / aid / "meta.json", meta)

    assert agent.read_meta(aid) is None


def test_read_meta_rejects_old_shape_without_dual_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    _write_raw(tmp_path / aid / "meta.json", {"id": aid, "state": "idle"})

    assert agent.read_meta(aid) is None


def test_runner_rejects_invalid_existing_schema(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    _write_raw(tmp_path / aid / "meta.json", {"id": aid, "agent_version": 2})

    with pytest.raises(agent.MetadataError, match="missing, malformed, or unsupported"):
        agent.runner(aid, "new")


def test_update_meta_rejects_invalid_existing_schema(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    aid = "abc123"
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    _write_raw(tmp_path / aid / "meta.json", {"id": aid, "state": "idle"})

    with pytest.raises(agent.MetadataError, match="missing, malformed, or unsupported"):
        agent.update_meta(aid, lambda _meta: pytest.fail("invalid metadata was mutated"))


def test_invalid_schema_command_reports_metadata_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    aid = "abc123"
    monkeypatch.setattr(agent, "agent_dir", lambda value: tmp_path / value)
    _write_raw(tmp_path / aid / "meta.json", {"id": aid, "agent_version": 2})

    assert agent.main(["status", "--id", aid]) == agent.EXIT_ERROR
    assert "missing, malformed, or unsupported metadata" in capsys.readouterr().err


def test_proc_cpu_seconds_rejects_missing_input() -> None:
    with pytest.raises(ValueError, match="positive integer"):
        agent.proc_cpu_seconds(cast("int", None))
