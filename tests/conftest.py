import os

import pytest


@pytest.fixture(autouse=True)
def _antonina_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_STATE_HOME", os.environ.get("XDG_STATE_HOME", "/tmp/antonina-test-state"))
