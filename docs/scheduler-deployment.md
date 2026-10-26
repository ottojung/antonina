# Deploying Antonina scheduler policy

The scheduler implementation consists of executable helpers in scripts/ and
the matching policy skills in skills/. These are separate from the published
Antonina CLI package. A Git merge does not update the installed helpers.

Before installation, verify that the **CLI and the checked-out scheduler sources identify the same main commit**. The scheduler deployment script does not install the CLI. A Node/npm installation under another prefix can shadow the intended executable on `PATH`: inspect `command -v antonina` and `antonina --version`, compare with `"$HOME/.local/bin/antonina" --version`, and make the intended `~/.local/bin` executable take precedence. A successful `npm install` into one prefix does not repair another prefix automatically. Details: `docs/build-identity-and-rollback.md`.

Issue IDs are single opaque strings, even if they contain only digits. The scheduler accepts the full string returned by `board list`, `board show` or `board create` without identifying an old or new format. The title marker `#<ISSUE_ID>:` is a *title delimiter*, not an ID parser. `antonina-scheduler-snapshot` reports `live_issue_ids` as strings, not as numbers. Never use a word-only reference or infer ordering from an ID.

From a clean checkout of the desired main commit on each host:

    scripts/antonina-scheduler-deploy --install
    scripts/antonina-scheduler-deploy --check

The deploy helper atomically installs six active scripts into ~/.local/bin and
the two matching `SKILL.md` files and the orchestrator's `resources.md` companion into ~/.openclaw/skills, plus the restricted
OpenCode configuration into ~/.config/opencode/openclaw.json. It also installs and verifies the **same source-controlled S6 service entrypoint** wherever an `antonina-orchestrator` service already exists; no private service wrapper or host-specific alternate script is supported. The prompt template is identical everywhere. Neither the board nor the scheduler interprets host identity or placement rules. Execution context, including deployment preferences, may appear only as ordinary issue/comment text for agents to interpret. Temporary scheduler claims coordinate logical work across independent schedulers without including any machine identity. It restarts an existing
s6-supervised antonina-orchestrator using the want-up-preserving restart
helper; it does NOT create a second orchestrator service on hosts that have
none. To stage without restarting, set
ANTONINA_RESTART=never. ANTONINA_BIN_DIR and ANTONINA_SKILL_DIR may be
overridden for test or alternative installation roots.

A failed --check is evidence of deployment drift and must be addressed before
declaring the code live. Verify a fresh scheduler snapshot and the orchestrator
turn log on the active host after restart. Do not conflate a successful Git
merge, successful process exit, and successful project delivery.

The restricted config target may be overridden for isolated tests using ANTONINA_OPENCODE_CONFIG.
