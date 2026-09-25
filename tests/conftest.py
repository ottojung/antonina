from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _antonina_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for directory in (
        tmp_path / "state",
        tmp_path / "data",
        tmp_path / "config",
        tmp_path / "cache",
        tmp_path / "home",
    ):
        directory.mkdir()
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    for name in (
        "ANTONINA_AGENT_ID",
        "ANTONINA_INVOCATION_ID",
        "ANTONINA_PROMPT",
        "ANTONINA_RUNNER_GEN",
        "ANTONINA_TEST_SYNC",
        "ANTONINA_AGENT_RETENTION_DAYS",
    ):
        monkeypatch.delenv(name, raising=False)
