"""Supported OpenCode CLI session-discovery boundary regressions."""

from __future__ import annotations

import json
import os
import signal
import subprocess
from typing import Any, override

import pytest

from antonina import agent


class _CompletedProcess:
    def __init__(self, result: subprocess.CompletedProcess[bytes]) -> None:
        self.pid = 4242
        self.returncode: int | None = result.returncode
        self.result_returncode = result.returncode
        self.stdout = result.stdout

    def communicate(self, timeout: float | None = None) -> tuple[bytes, None]:
        return self.stdout, None


class _TimedOutProcess(_CompletedProcess):
    def __init__(self, result: subprocess.CompletedProcess[bytes]) -> None:
        super().__init__(result)
        self.returncode = None
        self.raised = False
        self.waited = False

    @override
    def communicate(self, timeout: float | None = None) -> tuple[bytes, None]:
        if not self.raised:
            self.raised = True
            raise subprocess.TimeoutExpired(["opencode"], timeout or 0.0)
        return self.stdout, None

    def poll(self) -> None:
        return None

    def wait(self, timeout: float | None = None) -> int:
        self.waited = True
        self.returncode = self.result_returncode
        return self.result_returncode

    def kill(self) -> None:
        return None


def _completed(payload: object, *, returncode: int = 0) -> subprocess.CompletedProcess[bytes]:
    return subprocess.CompletedProcess(
        args=["opencode"],
        returncode=returncode,
        stdout=json.dumps(payload).encode(),
        stderr=b"",
    )


def _session(session_id: str, title: str, created: int = 1) -> dict[str, object]:
    return {
        "id": session_id,
        "title": title,
        "time": {"created": created, "updated": created},
    }


def test_discovery_uses_supported_bounded_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    """Session discovery uses the public JSON command with count and time bounds."""
    calls: list[tuple[list[str], dict[str, object]]] = []
    completed = _CompletedProcess(_completed([_session("ses_match", "antonina-ab")]))

    def popen(argv: list[str], **kwargs: object) -> _CompletedProcess:
        calls.append((argv, kwargs))
        return completed

    monkeypatch.setattr(subprocess, "Popen", popen)

    assert agent.discover_session_id("ab") == "ses_match"
    argv, kwargs = calls[0]
    assert argv == [
        "opencode",
        "session",
        "list",
        "--format",
        "json",
        "--max-count",
        str(agent.SESSION_LIST_MAX_COUNT),
    ]
    assert kwargs["stdin"] == subprocess.DEVNULL
    assert kwargs["stdout"] == subprocess.PIPE
    assert kwargs["stderr"] == subprocess.DEVNULL
    assert kwargs["close_fds"] is True
    assert kwargs["start_new_session"] is True


def test_discovery_communicate_is_time_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """The subprocess response wait uses the explicit discovery timeout."""
    completed = _CompletedProcess(_completed([_session("ses_match", "antonina-ab")]))
    timeouts: list[float | None] = []

    def communicate(timeout: float | None = None) -> tuple[bytes, None]:
        timeouts.append(timeout)
        return completed.stdout, None

    completed.communicate = communicate  # type: ignore[method-assign]
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") == "ses_match"
    assert timeouts == [agent.SESSION_LIST_TIMEOUT_SECONDS]


def test_discovery_exactly_matches_title_and_selects_newest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only the exact Antonina title participates in deterministic selection."""
    payload = [
        _session("ses_near", "antonina-ab-extra", 100),
        _session("ses_old", "antonina-ab", 10),
        _session("ses_new", "antonina-ab", 20),
        _session("ses_other", "other", 1000),
    ]
    completed = _CompletedProcess(_completed(payload))
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") == "ses_new"


def test_discovery_breaks_equal_time_ties_by_session_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Equal creation times still select one stable session identity."""
    payload = [
        _session("ses_b", "antonina-ab", 10),
        _session("ses_a", "antonina-ab", 10),
    ]
    completed = _CompletedProcess(_completed(payload))
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") == "ses_b"


@pytest.mark.parametrize(
    "failure",
    [FileNotFoundError("missing opencode"), PermissionError("not executable")],
)
def test_discovery_executable_failure_yields_no_session(
    monkeypatch: pytest.MonkeyPatch,
    failure: OSError,
) -> None:
    """Executable discovery failures never become session authority."""

    def fail(*_args: object, **_kwargs: object) -> _CompletedProcess:
        raise failure

    monkeypatch.setattr(subprocess, "Popen", fail)
    assert agent.discover_session_id("ab") is None


def test_discovery_timeout_kills_and_reaps_owned_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A timed-out command is converged and reaped before yielding no session."""
    process = _TimedOutProcess(_completed([_session("ses_match", "antonina-ab")]))
    signals: list[tuple[int, int]] = []
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: process)
    monkeypatch.setattr(os, "killpg", lambda pid, sig: signals.append((pid, sig)))

    assert agent.discover_session_id("ab") is None
    assert signals == [(process.pid, signal.SIGKILL)]
    assert process.waited is True


def test_discovery_nonzero_exit_yields_no_session(monkeypatch: pytest.MonkeyPatch) -> None:
    """A nonzero supported-command result is inconclusive and yields no session."""
    completed = _CompletedProcess(_completed([_session("ses_match", "antonina-ab")], returncode=1))
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") is None


@pytest.mark.parametrize("stdout", [b"", b"not-json", b"null", b"{}", b"[[]]"])
def test_discovery_malformed_json_or_root_yields_no_session(
    monkeypatch: pytest.MonkeyPatch,
    stdout: bytes,
) -> None:
    """Malformed JSON and a non-list root fail closed at the CLI boundary."""
    result: subprocess.CompletedProcess[bytes] = subprocess.CompletedProcess(
        args=["opencode"],
        returncode=0,
        stdout=stdout,
        stderr=b"",
    )
    completed = _CompletedProcess(result)
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") is None


@pytest.mark.parametrize(
    "payload",
    [
        [None],
        [{"title": "antonina-ab"}],
        [{"id": "ses_match", "title": "antonina-ab"}],
        [{"id": "", "title": "antonina-ab", "time": {"created": 1}}],
        [{"id": "ses_match", "title": 1, "time": {"created": 1}}],
        [{"id": "ses_match", "title": "antonina-ab", "time": {"created": True}}],
        [
            _session("ses_valid", "other"),
            {"id": "ses_bad", "title": "other", "time": {}},
        ],
    ],
)
def test_discovery_malformed_item_schema_yields_no_session(
    monkeypatch: pytest.MonkeyPatch,
    payload: object,
) -> None:
    """One malformed session row invalidates the discovery result."""
    completed = _CompletedProcess(_completed(payload))
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") is None


def test_discovery_oversized_output_yields_no_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A response beyond the explicit byte bound is never parsed."""
    result: subprocess.CompletedProcess[bytes] = subprocess.CompletedProcess(
        args=["opencode"],
        returncode=0,
        stdout=b"x" * (agent.SESSION_LIST_MAX_OUTPUT_BYTES + 1),
        stderr=b"",
    )
    completed = _CompletedProcess(result)
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") is None


def test_discovery_no_exact_match_yields_no_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Near-match and unrelated titles never become Antonina authority."""
    payload: list[dict[str, Any]] = [
        _session("ses_near", "prefix-antonina-ab"),
        _session("ses_other", "other"),
    ]
    completed = _CompletedProcess(_completed(payload))
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: completed)

    assert agent.discover_session_id("ab") is None
