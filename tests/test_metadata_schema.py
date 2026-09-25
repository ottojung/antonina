"""Current-version Antonina metadata schema enforcement."""

from __future__ import annotations

import json
import os

import pytest

from antonina import agent


def _persist(aid: str, meta: object) -> None:
    directory = agent.agent_dir(aid)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def _canonical(aid: str = "ab") -> agent.Meta:
    return agent.idle_meta(aid, os.getcwd(), None)


def test_idle_metadata_round_trips_as_the_current_schema() -> None:
    """The writer's current idle document is accepted by the read boundary."""
    meta = _canonical()
    _persist("ab", meta)

    assert agent.read_meta("ab") == meta


@pytest.mark.parametrize(
    "version",
    [None, agent.AGENT_META_VERSION - 1, agent.AGENT_META_VERSION + 1, "3", 3.0, True],
)
def test_missing_old_unknown_or_malformed_version_fails_closed(version: object) -> None:
    """Only the exact current integer schema version is authoritative."""
    meta = _canonical()
    if version is None:
        del meta["agent_version"]
    else:
        meta["agent_version"] = version
    _persist("ab", meta)

    assert agent.read_meta("ab") is None


@pytest.mark.parametrize("field", sorted(agent.REQUIRED_AGENT_META_FIELDS))
def test_every_required_schema_field_is_required(field: str) -> None:
    """No current-schema field may be supplied through a missing-field default."""
    meta = _canonical()
    del meta[field]
    _persist("ab", meta)

    assert agent.read_meta("ab") is None


def test_unknown_top_level_field_fails_closed() -> None:
    """A document from an unknown schema shape is not partially interpreted."""
    meta = _canonical()
    meta["unknown_future_field"] = "value"
    _persist("ab", meta)

    assert agent.read_meta("ab") is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("invocation_id", "invalid"),
        ("pgid", True),
        ("prompt_count", False),
        ("active_runner", "false"),
        ("delete_pending", 0),
        ("state", "paused"),
        ("runner_reservation", {"state": "reserved"}),
        ("unresolved_invocation", {"pid": 1}),
        ("steer_queue", "not-a-list"),
    ],
)
def test_malformed_current_schema_field_fails_closed(field: str, value: object) -> None:
    """Malformed values never reach downstream compatibility interpretation."""
    meta = _canonical()
    meta[field] = value
    _persist("ab", meta)

    assert agent.read_meta("ab") is None


def test_malformed_json_fails_closed() -> None:
    """Malformed JSON cannot be partially interpreted as current schema."""
    directory = agent.agent_dir("ab")
    directory.mkdir(parents=True)
    (directory / "meta.json").write_text("[", encoding="utf-8")

    assert agent.read_meta("ab") is None


def test_non_object_metadata_fails_closed() -> None:
    """The current metadata root must be one JSON object."""
    _persist("ab", [])

    assert agent.read_meta("ab") is None


def test_optional_known_fields_remain_valid() -> None:
    """Optional fields in the current schema retain their canonical meanings."""
    meta = _canonical()
    meta.update({"pending_prompt": "accepted", "last_prompt": "accepted", "error": "failed"})
    _persist("ab", meta)

    assert agent.read_meta("ab") == meta


def test_targeted_missing_field_helpers_fail_closed() -> None:
    """Legacy missing-field defaults are removed beneath the read boundary too."""
    assert agent._next_prompt_count({}) is None
    assert agent._active_runner_flag({}) is None
    assert agent._delete_pending_flag({}) is None
    assert agent._persisted_lifecycle_state({}) is None
    assert agent.derive_state({"id": "ab"}) == "unknown"


def test_proc_cpu_seconds_rejects_none_compatibility() -> None:
    """CPU inspection accepts process IDs only, not missing-ID compatibility."""
    with pytest.raises(TypeError, match="pid must be an integer"):
        agent.proc_cpu_seconds(None)  # type: ignore[arg-type]
