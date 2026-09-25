"""Fail-closed regressions for invocation identity authority."""

import pytest

from antonina import agent

INVOCATION_ID = "0123456789abcdef0123456789abcdef"


def _running_meta(**overrides: object) -> agent.Meta:
    meta = agent.idle_meta("ab12", "/tmp/ab12", None)
    meta.update({
        "state": "running",
        "pid": 4242,
        "pgid": 4242,
        "start_time": 1234,
        "invocation_id": INVOCATION_ID,
    })
    meta.update(overrides)
    return meta


def test_group_alive_rejects_missing_invocation_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    """A running group without its exact invocation identity stays ambiguous."""
    meta = _running_meta(invocation_id=None)
    monkeypatch.setattr(
        agent,
        "_proven_invocation_members",
        lambda *_args: pytest.fail("missing invocation identity reached member scan"),
    )

    assert agent.group_alive(meta) is True


def test_group_alive_rejects_malformed_invocation_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Malformed invocation identity never falls back to a numeric group probe."""
    meta = _running_meta(invocation_id="not-an-invocation")
    monkeypatch.setattr(
        agent,
        "_proven_invocation_members",
        lambda *_args: pytest.fail("malformed invocation identity reached member scan"),
    )

    assert agent.group_alive(meta) is True


def test_group_alive_uses_exact_identity_for_current_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Canonical invocation identity still reaches the pinned member scan."""
    calls: list[tuple[int, str, str]] = []

    def members(pgid: int, aid: str, iid: str) -> tuple[list[tuple[int, int]], bool]:
        calls.append((pgid, aid, iid))
        return [], True

    meta = _running_meta()
    monkeypatch.setattr(agent, "is_alive", lambda _meta: False)
    monkeypatch.setattr(agent, "_recorded_leader_state", lambda _meta: "gone")
    monkeypatch.setattr(agent, "_proven_invocation_members", members)

    assert agent.group_alive(meta) is False
    assert calls == [(4242, "ab12", INVOCATION_ID)]
