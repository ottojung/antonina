# Deploying Antonina scheduler policy

The scheduler implementation consists of executable helpers in scripts/ and
the matching policy skills in skills/. These are separate from the published
Antonina CLI package. A Git merge does not update the installed helpers.

From a clean checkout of the desired main commit on each host:

    scripts/antonina-scheduler-deploy --install
    scripts/antonina-scheduler-deploy --check

The deploy helper atomically installs six active scripts into ~/.local/bin and
the two matching skill files into ~/.openclaw/skills. It restarts an existing
s6-supervised antonina-orchestrator using the want-up-preserving restart
helper; it does NOT create a second orchestrator service on hosts that have
none (for example, phoebe-dev). To stage without restarting, set
ANTONINA_RESTART=never. ANTONINA_BIN_DIR and ANTONINA_SKILL_DIR may be
overridden for test or alternative installation roots.

A failed --check is evidence of deployment drift and must be addressed before
declaring the code live. Verify a fresh scheduler snapshot and the orchestrator
turn log on the active host after restart. Do not conflate a successful Git
merge, successful process exit, and successful project delivery.
