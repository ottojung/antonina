# Deploying Antonina scheduler policy

The scheduler implementation consists of executable helpers in scripts/ and
the matching policy skills in skills/. These are separate from the published
Antonina CLI package. A Git merge does not update the installed helpers.

From a clean checkout of the desired main commit on each host:

    scripts/antonina-scheduler-deploy --install
    scripts/antonina-scheduler-deploy --check

The deploy helper atomically installs six active scripts into ~/.local/bin and
the two matching skill files into ~/.openclaw/skills, plus the restricted
OpenCode configuration into ~/.config/opencode/openclaw.json. It also installs and verifies the **same source-controlled S6 service entrypoint** wherever an `antonina-orchestrator` service already exists; no private service wrapper or host-specific alternate script is supported. The prompt template is identical everywhere. The local hostname and any explicit `Execution host: HOSTNAME` description restriction determine which issues can actually be dispatched. This is ordinary issue text, not a label or new field. It restarts an existing
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
