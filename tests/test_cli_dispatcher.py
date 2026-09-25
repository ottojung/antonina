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
    assert "invalid choice: 'status'" in capsys.readouterr().err


def test_rejects_hidden_runner(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        cli.main(["_runner", "payload", "metadata", "extra"])

    assert raised.value.code == 2
    assert "invalid choice: '_runner'" in capsys.readouterr().err
