# Antonina

Antonina is the standalone optional agent runtime. It manages long-running local agent sessions behind the `antonina` command, with durable metadata, logs, process-group lifecycle control, and model backend integration.

## Independence

The runtime uses only the Python standard library and does not depend on the Lubko Python package. Antonina can be installed and operated independently of the Lubko connector and execution transport.

## Getting started

```sh
python -m pip install .
antonina new --id a13f09c2 --cwd /workspace/project
antonina prompt --id a13f09c2 'Investigate the issue and implement the fix.'
antonina status --id a13f09c2
```

State is stored under `$XDG_STATE_HOME/antonina` by default. The `docs/skills/` tree contains the operational guidance extracted from Lubko and adapted for Antonina ownership.

## Development

```sh
uv run pytest
```

The runtime targets Python 3.12 or later and has no runtime dependencies.
