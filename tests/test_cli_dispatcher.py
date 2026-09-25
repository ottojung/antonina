"""Top-level Antonina CLI dispatcher tests."""

from __future__ import annotations

import pytest

from antonina import agent, board, cli


def test_dispatches_agent_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []

    def fake_agent_main(argv: list[str]) -> int:
        seen.append(argv)
        return 23

    monkeypatch.setattr(agent, "main", fake_agent_main)

    assert cli.main(["agent", "status", "--id", "a13f09c2"]) == 23

    assert seen == [["status", "--id", "a13f09c2"]]


def test_dispatches_board_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []

    def fake_board_main(argv: list[str]) -> int:
        seen.append(argv)
        return 29

    monkeypatch.setattr(board, "main", fake_board_main)

    assert cli.main(["board", "list", "--state", "open"]) == 29
    assert seen == [["list", "--state", "open"]]


def test_rejects_direct_agent_command(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        cli.main(["status", "--id", "a13f09c2"])

    assert raised.value.code == 2
    assert "unknown namespace: status" in capsys.readouterr().err


def test_public_agent_rejects_hidden_runner(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        cli.main(["agent", "_runner", "payload", "metadata"])

    assert raised.value.code == 2
    assert "invalid choice: '_runner'" in capsys.readouterr().err


def test_internal_entry_still_runs_background_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, str]] = []

    def fake_runner(aid: str, mode: str) -> None:
        seen.append((aid, mode))

    monkeypatch.setattr(agent, "runner", fake_runner)

    assert agent.internal_main(["_runner", "a13f09c2", "new"]) == 0
    assert seen == [("a13f09c2", "new")]
