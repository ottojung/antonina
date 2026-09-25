from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _antonina_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Isolate every test from ambient Antonina state."""
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
