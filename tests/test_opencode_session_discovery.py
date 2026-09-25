"""Supported OpenCode session discovery boundary regressions."""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

import pytest

from antonina import agent


def _run_result(payload: object, *, returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        ["opencode", "session", "list"],
        returncode,
        stdout=json.dumps(payload),
    )


def test_session_discovery_matches_exact_title_and_newest_created(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    aid = "abc123"
    calls: list[tuple[list[str], dict[str, object]]] = []
    executable = "/stub/opencode"
    sessions = [
        {
            "id": "old",
            "title": agent.OPENCODE_TITLE_PREFIX + aid,
            "created": 10,
            "updated": 100,
        },
        {
            "id": "new",
            "title": agent.OPENCODE_TITLE_PREFIX + aid,
            "created": 20,
            "updated": 1,
        },
        {
            "id": "wrong",
            "title": agent.OPENCODE_TITLE_PREFIX + aid + "-other",
            "created": 30,
            "updated": 30,
        },
    ]

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((args, kwargs))
        return _run_result(sessions)

    monkeypatch.setattr(shutil, "which", lambda _name: executable)
    monkeypatch.setattr(subprocess, "run", run)

    assert agent.discover_session_id(aid) == "new"
    assert calls[0][0] == [
        executable,
        "session",
        "list",
        "--format",
        "json",
        "--max-count",
        str(agent.SESSION_DISCOVER_MAX_COUNT),
    ]
    assert calls[0][1]["timeout"] == agent.SESSION_DISCOVER_COMMAND_TIMEOUT_SECONDS


def test_session_discovery_uses_deterministic_tie_breaking(monkeypatch: pytest.MonkeyPatch) -> None:
    aid = "abc123"
    sessions = [
        {"id": "session-a", "title": agent.OPENCODE_TITLE_PREFIX + aid, "created": 4, "updated": 1},
        {"id": "session-z", "title": agent.OPENCODE_TITLE_PREFIX + aid, "created": 4, "updated": 1},
    ]
    monkeypatch.setattr(shutil, "which", lambda _name: "/stub/opencode")
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: _run_result(sessions))

    assert agent.discover_session_id(aid) == "session-z"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        [[]],
        [{"id": "session", "title": "antonina-abc123"}],
        [{"id": "", "title": "antonina-abc123", "created": 1}],
        [{"id": "session", "title": 1, "created": 1}],
        [{"id": "session", "title": "antonina-abc123", "created": "1"}],
        [{"id": "session", "title": "antonina-abc123", "created": 1.5}],
        [{"id": "session", "title": "antonina-abc123", "created": 1}],
    ],
)
def test_session_discovery_rejects_malformed_output_schema(
    monkeypatch: pytest.MonkeyPatch, payload: object
) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: "/stub/opencode")
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: _run_result(payload))

    assert agent.discover_session_id("abc123") is None


def test_session_discovery_rejects_malformed_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: "/stub/opencode")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, stdout="{"),
    )

    assert agent.discover_session_id("abc123") is None


def test_session_discovery_returns_none_without_executable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("command ran without executable"),
    )

    assert agent.discover_session_id("abc123") is None


@pytest.mark.parametrize(
    "failure",
    [
        OSError("opencode failed"),
        subprocess.TimeoutExpired(["opencode"], 1),
    ],
)
def test_session_discovery_returns_none_on_command_failure(
    monkeypatch: pytest.MonkeyPatch, failure: BaseException
) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: "/stub/opencode")

    def run(*_args: object, **_kwargs: object) -> Any:
        raise failure

    monkeypatch.setattr(subprocess, "run", run)

    assert agent.discover_session_id("abc123") is None


def test_session_discovery_returns_none_on_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: "/stub/opencode")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1, stdout="[]"),
    )

    assert agent.discover_session_id("abc123") is None


def test_session_discovery_returns_none_without_exact_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: "/stub/opencode")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: _run_result([
            {"id": "session", "title": "other", "created": 1, "updated": 1}
        ]),
    )

    assert agent.discover_session_id("abc123") is None
