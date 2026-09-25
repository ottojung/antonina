"""Supported OpenCode session-discovery boundary."""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

import pytest

from antonina import agent


def _result(*, stdout: str, returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["opencode"], returncode=returncode, stdout=stdout, stderr=""
    )


def test_discovery_uses_supported_json_cli_and_selects_newest_exact_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Discovery uses the supported CLI and orders exact-title matches by creation time."""
    calls: list[tuple[list[str], dict[str, Any]]] = []
    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/opencode")

    rows = [
        {"id": "other", "title": "antonina-bbbbbbbb", "created": 999, "updated": 999},
        {"id": "older", "title": "antonina-aaaaaaaa", "created": 10, "updated": 1000},
        {"id": "newer", "title": "antonina-aaaaaaaa", "created": 20, "updated": 20},
    ]

    def run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append((argv, kwargs))
        return _result(stdout=json.dumps(rows))

    monkeypatch.setattr(subprocess, "run", run)

    assert agent.discover_session_id("aaaaaaaa") == "newer"
    assert calls == [
        (
            [
                "/usr/bin/opencode",
                "session",
                "list",
                "--format",
                "json",
                "--max-count",
                str(agent.SESSION_LIST_MAX_COUNT),
            ],
            {
                "check": False,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.DEVNULL,
                "text": True,
                "timeout": agent.SESSION_LIST_TIMEOUT_SECONDS,
            },
        )
    ]


def test_discovery_returns_none_when_opencode_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing OpenCode executable is an inconclusive discovery result."""
    monkeypatch.setattr(shutil, "which", lambda _name: None)

    def unexpected(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("subprocess.run must not be called")

    monkeypatch.setattr(subprocess, "run", unexpected)
    assert agent.discover_session_id("aaaaaaaa") is None


@pytest.mark.parametrize(
    ("stdout", "returncode"),
    [
        ("not json", 0),
        (json.dumps({"id": "wrong-container"}), 0),
        (json.dumps([{"id": "broken"}]), 0),
        (json.dumps([{"id": "x", "title": "antonina-aaaaaaaa", "created": True}]), 0),
        ("[]", 1),
    ],
)
def test_discovery_fails_closed_on_command_or_schema_errors(
    monkeypatch: pytest.MonkeyPatch,
    stdout: str,
    returncode: int,
) -> None:
    """Malformed or failed supported-boundary output never authorizes continuation."""
    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/opencode")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: _result(stdout=stdout, returncode=returncode),
    )

    assert agent.discover_session_id("aaaaaaaa") is None


def test_discovery_returns_none_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """A timed-out session listing is inconclusive and does not crash Antonina."""
    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/opencode")

    def timeout(*_args: object, **_kwargs: object) -> None:
        raise subprocess.TimeoutExpired(
            cmd=["opencode"], timeout=agent.SESSION_LIST_TIMEOUT_SECONDS
        )

    monkeypatch.setattr(subprocess, "run", timeout)
    assert agent.discover_session_id("aaaaaaaa") is None


def test_discovery_returns_none_when_no_exact_title_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Similar titles never become continuation authority."""
    monkeypatch.setattr(shutil, "which", lambda _name: "/usr/bin/opencode")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: _result(
            stdout=json.dumps([
                {"id": "prefix", "title": "antonina-aaaaaaaa-extra", "created": 2},
                {"id": "other", "title": "antonina-bbbbbbbb", "created": 3},
            ])
        ),
    )

    assert agent.discover_session_id("aaaaaaaa") is None
