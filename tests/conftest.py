import shutil
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _antonina_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Isolate every test from ambient Antonina state and OpenCode."""
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))

    real_which = shutil.which

    def isolated_which(cmd: str, *, mode: int = 1, path: str | None = None) -> str | None:
        if cmd == "opencode":
            return None
        return real_which(cmd, mode=mode, path=path)

    monkeypatch.setattr(shutil, "which", isolated_which)
