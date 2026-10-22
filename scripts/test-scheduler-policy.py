#!/usr/bin/env python3
"""Topology-only scheduler regressions; no ambient Antonina state or Git I/O."""
import ast
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch
import types

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

def load_helper(name):
    path = ROOT / name
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def snapshot_function(name):
    source = ast.parse((ROOT / "antonina-scheduler-snapshot").read_text())
    return next(x for x in source.body if isinstance(x, ast.FunctionDef) and x.name == name)


class SchedulerPolicyTests(unittest.TestCase):
    def test_antonina_policy_is_host_neutral_and_without_labels(self):
        launcher = (ROOT / "antonina-scheduler-launch").read_text()
        snapshot = (ROOT / "antonina-scheduler-snapshot").read_text()
        turn = (ROOT / "antonina-orchestrator-turn").read_text()
        for script in (launcher, snapshot, turn):
            for forbidden in ("marceline-dev", "phoebe-dev", "Viche", "Kawun",
                              "Kavun", "HOST OWNERSHIP OVERRIDE",
                              "phoebe_owned_issue"):
                self.assertNotIn(forbidden, script)
        self.assertNotIn("project_hint", snapshot)
        self.assertNotIn("represented_projects", snapshot)
        self.assertNotIn("unrepresented_projects", snapshot)
        self.assertNotIn('"labels"', snapshot)

    def test_failed_turns_back_off_without_serializing_workers(self):
        import os
        import subprocess
        import tempfile
        import time
        import shutil
        with tempfile.TemporaryDirectory() as home:
            base = Path(home)
            bin_dir = base / ".local" / "bin"
            fake_bin = base / "bin"
            bin_dir.mkdir(parents=True)
            fake_bin.mkdir()
            turn = bin_dir / "antonina-orchestrator-turn"
            turn.write_text("#!/bin/sh\nexit 1\n")
            turn.chmod(0o755)
            sleep = fake_bin / "sleep"
            sleep.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$1" >> "$HOME/sleeps"\n'
                f'{shutil.which("sleep")} 0.03\n'
            )
            sleep.chmod(0o755)
            env = dict(os.environ)
            env.update({
                "HOME": home,
                "XDG_STATE_HOME": home,
                "PATH": str(fake_bin) + ":" + env.get("PATH", ""),
                "ANTONINA_SCHEDULER_INTERVAL_SECONDS": "0.1",
                "ANTONINA_SCHEDULER_FAILURE_RETRY_SECONDS": "1",
                "ANTONINA_SCHEDULER_MAX_FAILURE_RETRY_SECONDS": "4",
            })
            loop = ROOT / "antonina-orchestrator-loop"
            proc = subprocess.Popen([str(loop)], env=env)
            try:
                calls = []
                for _ in range(70):
                    if (base / "sleeps").exists():
                        calls = (base / "sleeps").read_text().splitlines()
                    if "4" in calls:
                        break
                    time.sleep(0.03)
                self.assertIn("4", calls, calls)
            finally:
                proc.terminate()
                proc.wait(timeout=4)
            backoffs = [call for call in calls if call != "0.1"]
            self.assertEqual(backoffs[:3], ["1", "2", "4"])
            log = (base / "antonina" / "orchestrator-turn.log").read_text()
            self.assertIn("next attempt in 4s", log)

    def test_plain_text_host_instruction_is_host_aware_but_not_a_label(self):
        launcher = load_helper("antonina-scheduler-launch")
        examples = (
            ("Execution host: node-a", "node-a"),
            ("**Execution host: node-a (EXCLUSIVE).**\\nDetails", "node-a"),
            ("No host specified; this can run anywhere", None),
        )
        for body, expected in examples:
            self.assertEqual(launcher.declared_execution_host(body), expected)
        with self.assertRaisesRegex(SystemExit, "malformed"):
            launcher.declared_execution_host("Execution host: ")
        for host in ("node-a", "node-b"):
            with patch.object(launcher.socket, "gethostname", return_value=host):
                launcher.ensure_local_execution_host(
                    {"number": 42, "title": "Any project", "body": "No restriction"}
                )
                record = {"number": 42, "body": "**Execution host: node-a (EXCLUSIVE).**"}
                if host == "node-a":
                    launcher.ensure_local_execution_host(record)
                else:
                    with self.assertRaisesRegex(SystemExit, "requires execution on node-a"):
                        launcher.ensure_local_execution_host(record)

    def test_dispatch_reads_issue_host_without_project_or_issue_blocklists(self):
        launcher = load_helper("antonina-scheduler-launch")
        for number, title, body, hostname, accepted in (
            (297, "Viche Town Hall", "**Execution host: node-a (EXCLUSIVE).**",
             "node-a", True),
            (297, "Viche Town Hall", "**Execution host: node-a (EXCLUSIVE).**",
             "node-b", False),
            (181, "npm run check never runs vitest", "Execution host: node-b",
             "node-a", False),
            (181, "npm run check never runs vitest", "Execution host: node-b",
             "node-b", True),
            (223, "Kawun: work", "", "node-a", True),
            (223, "Kawun: work", "", "node-b", True),
        ):
            record = {"number": number, "title": title, "body": body, "state": "open"}
            with patch.object(launcher, "run", return_value=types.SimpleNamespace(
                    stdout=json.dumps(record))), \
                    patch.object(launcher.socket, "gethostname", return_value=hostname):
                if accepted:
                    self.assertEqual(launcher.require_open_issue(number), record)
                else:
                    with self.assertRaisesRegex(SystemExit, "requires execution on"):
                        launcher.require_open_issue(number)

    def test_identical_prompt_uses_runtime_hostname(self):
        turn = (ROOT / "antonina-orchestrator-turn").read_text()
        self.assertIn('current_host="$(hostname)"', turn)
        self.assertIn("HOST-AWARE ISSUE INTAKE:", turn)
        self.assertIn("antonina-scheduler-issue --issue ISSUE", turn)
        self.assertNotIn("marceline-dev", turn)
        self.assertNotIn("phoebe-dev", turn)

    def test_opaque_issue_id_parsing_from_agent_titles(self):
        fn = snapshot_function("issue_id_from_agent_title")
        scope = {"re": re}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "<snapshot>", "exec"), scope)
        parse = scope[fn.name]
        self.assertEqual(parse("AssemblyP1 #94: old research"), "94")
        self.assertEqual(parse("Supernatural #223: Prologue design"), "223")
        self.assertEqual(parse("[Supernatural] #223: Prologue design"), "223")
        self.assertEqual(parse("QAI #82: migration"), "82")
        self.assertEqual(parse("#211: proof"), "211")
        self.assertEqual(parse("AssemblyP1 #7Ka9mQ2xP4vT8nB3cR5dH1-otter: work"), "7Ka9mQ2xP4vT8nB3cR5dH1-otter")
        self.assertEqual(parse("AssemblyP1 #arbitrary-ID_7: work"), "arbitrary-ID_7")
        self.assertEqual(parse("AssemblyP1 #A/B: work"), "A/B")
        self.assertIsNone(parse("AssemblyP1 freeform"))

    def test_helpers_never_inspect_issue_id_shapes(self):
        import io
        from contextlib import redirect_stdout

        issue_reader = load_helper("antonina-scheduler-issue")
        worktrees = load_helper("antonina-scheduler-worktrees")
        ids = ("320", "7Ka9mQ2xP4vT8nB3cR5dH1-otter", "arbitrary_ID.v2")
        for issue_id in ids:
            with self.subTest(issue_id=issue_id):
                out = io.StringIO()
                with patch.object(issue_reader, "read_issue", return_value={"number": issue_id}) as read, \
                     patch("sys.argv", ["issue-reader", "--issue", issue_id]), \
                     redirect_stdout(out):
                    issue_reader.main()
                read.assert_called_once_with(issue_id)
                self.assertEqual(json.loads(out.getvalue())["number"], issue_id)

                out = io.StringIO()
                with patch.object(worktrees, "running_agents", return_value=[]), \
                     patch.object(worktrees, "resources", return_value=[]) as read, \
                     patch("sys.argv", ["worktrees", "--issue", issue_id]), \
                     redirect_stdout(out):
                    worktrees.main()
                read.assert_called_once_with(issue_id)
                self.assertEqual(json.loads(out.getvalue()), [])

        for invalid_id in ("", " ", " 320 "):
            with self.subTest(invalid_id=invalid_id):
                for helper in (issue_reader, worktrees):
                    with patch("sys.argv", ["helper", "--issue", invalid_id]):
                        with self.assertRaises(SystemExit):
                            helper.main()

    def test_scheduler_deployer_checks_orchestrator_resource_companion(self):
        deploy = (ROOT / "antonina-scheduler-deploy").read_text()
        self.assertIn('skills/antonina-orchestrator/resources.md', deploy)
        self.assertIn('verify_file "$resource_source" "$resource_target"', deploy)

    def test_scheduler_does_not_discover_filesystem_state(self):
        turn = (ROOT / "antonina-orchestrator-turn").read_text()
        launcher = (ROOT / "antonina-scheduler-launch").read_text()
        snapshot = (ROOT / "antonina-scheduler-snapshot").read_text()
        self.assertIn("PRIORITY-FIRST DISPATCH", turn)
        self.assertIn("antonina-scheduler-launch", turn)
        self.assertNotIn("antonina-scheduler-provision", turn)
        self.assertNotIn("antonina-scheduler-worktrees", turn)
        self.assertNotIn("--cwd CWD", turn)
        for forbidden in ("antonina-scheduler-worktrees", "antonina-scheduler-provision",
                          "os.path.realpath", "git\", \"-C"):
            self.assertNotIn(forbidden, launcher)
        self.assertIn('START_DIR = "/workspace"', launcher)
        self.assertNotIn("project_hint_from_cwd", snapshot)
        self.assertNotIn('"cwd": a.get("cwd")', snapshot)

    def test_agent_bootstrap_is_agent_owned(self):
        launcher = load_helper("antonina-scheduler-launch")
        record = {"number": 223, "title": "Supernatural #223", "body": "Repo: ottojung/vau.place"}
        prompt = launcher.agent_prompt(record, "Write design", "123abc")
        self.assertIn("choose an isolated", prompt)
        self.assertIn("clone when needed", prompt)
        self.assertIn("ottojung/vau.place", prompt)
        self.assertIn("Write design", prompt)
        self.assertIn("[terminal-handoff]\nstate: <", prompt)
        self.assertIn("\nartifact: <", prompt)
        self.assertIn("\nvalidation: <", prompt)
        self.assertNotIn("antonina-scheduler-provision", prompt)

    def test_worker_packets_are_concrete_and_resume_checkpoints(self):
        launcher = load_helper("antonina-scheduler-launch")
        issue = {"number": 33, "title": "Theorem", "body": "Prove result",
                 "messages": [
                     {"body": "[terminal-handoff]\\nartifact: old", "createdAt": "2026-10-14T09:00:00Z"},
                     {"body": "[progress-checkpoint]\\nartifact: newer", "createdAt": "2026-10-14T11:00:00Z"}]}
        prompt = launcher.agent_prompt(issue, "Prove lemma and replay Lean", "abc123")
        self.assertIn("artifact: newer", prompt)
        self.assertNotIn("artifact: old", prompt)
        for term in ("REPOSITORY IDENTITY", "CONSTRUCTIVE CONTINUATION",
                     "DURABLE CONTINUITY", "attempts: <", "branch: <",
                     "Prove lemma and replay Lean"):
            self.assertIn(term, prompt)

    def test_live_owner_check_by_issue_not_paths(self):
        launcher = load_helper("antonina-scheduler-launch")
        records = [
            {"id":"first", "title":"Supernatural #223: Prologue"},
            {"id":"other", "title":"Supernatural #224: implementation"},
            {"id":"third", "title":"AssemblyP1 #223: duplicate logical issue"},
        ]
        seen = []
        def fake_run(args, check=True):
            seen.append(args)
            return types.SimpleNamespace(stdout=json.dumps({"agents":records,"unreadable":[]}))
        with patch.object(launcher, "run", side_effect=fake_run):
            self.assertEqual(launcher.running_owners(223), ["first","third"])
        self.assertFalse(any("cwd" in " ".join(call) for call in seen))

    def test_unreadable_inventory_is_not_silent_duplicate(self):
        launcher = load_helper("antonina-scheduler-launch")
        with patch.object(launcher,"run", return_value=types.SimpleNamespace(
            stdout=json.dumps({"agents":[],"unreadable":[{"id":"broken"}]}))):
            with self.assertRaisesRegex(SystemExit, "inventory incomplete"):
                launcher.running_owners(223)

    def test_closed_issue_cannot_be_launched(self):
        launcher = load_helper("antonina-scheduler-launch")
        with patch.object(launcher, "run", return_value=types.SimpleNamespace(
                stdout=json.dumps({"state":"closed"}))):
            with self.assertRaises(SystemExit):
                launcher.require_open_issue(223)

    def test_launcher_uses_generic_runtime_context_and_no_cwd_arg(self):
        launcher = load_helper("antonina-scheduler-launch")
        calls = []
        record = {"number":223,"state":"open","title":"Supernatural #223","body":"Repo: ottojung/vau.place"}
        def fake_run(args, check=True):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout="{}", stderr="")
        with patch.object(launcher,"require_open_issue",return_value=record), \
             patch.object(launcher,"running_owners",return_value=[]), \
             patch.object(launcher,"new_agent",return_value=types.SimpleNamespace(returncode=0,stdout='{"id":"7Ka9mQ2xP4vT8nB3cR5dH1-otter"}',stderr="")), \
             patch.object(launcher,"run",side_effect=fake_run), \
             patch("sys.argv",["launcher","--issue","223","--title","Supernatural #223",
                               "--summary","design","--prompt","Write design","--json"]):
            launcher.main()
        runs = [cmd for cmd in calls if cmd[1:3] == ["agent","run"]]
        self.assertEqual(len(runs),1)
        self.assertEqual(runs[0][runs[0].index("--cwd")+1],"/workspace")
        self.assertIn("clone when needed", runs[0][runs[0].index("--prompt")+1])
        self.assertTrue(any(x[1:3] == ["board","comment"] for x in calls))

    def test_racing_closure_stops_new_worker(self):
        launcher = load_helper("antonina-scheduler-launch")
        calls=[]
        seen=[0]
        def open_then_close(issue):
            seen[0]+=1
            if seen[0] == 3:
                raise SystemExit("closed after starting")
            return {"number":issue,"state":"open","title":"Supernatural #223","body":"Repo: ottojung/vau.place"}
        def fake_run(args, check=True):
            calls.append(args)
            return types.SimpleNamespace(returncode=0,stdout="{}",stderr="")
        with patch.object(launcher,"require_open_issue",side_effect=open_then_close), \
             patch.object(launcher,"running_owners",return_value=[]), \
             patch.object(launcher,"new_agent",return_value=types.SimpleNamespace(returncode=0,stdout='{"id":"7Ka9mQ2xP4vT8nB3cR5dH1-otter"}',stderr="")), \
             patch.object(launcher,"run",side_effect=fake_run), \
             patch("sys.argv",["launcher","--issue","223","--title","Supernatural #223",
                               "--summary","design","--prompt","Write design"]):
            with self.assertRaises(SystemExit):
                launcher.main()
        self.assertTrue(any(x[1:3] == ["agent","stop"] for x in calls))
        self.assertFalse(any(x[1:3] == ["board","comment"] for x in calls))

    def test_running_inventory_reconciles_and_paginates(self):
        fn = snapshot_function("running_agents")
        pages=[]
        def fake_cli(*args):
            pages.append(args[3])
            agents = [{"id":str(i),"state":"running"} for i in range(500)] if args[3]==1 else [{"id":"last"}]
            return {"agents":agents,"unreadable":[]}
        scope={"cli_json":fake_cli}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),"<snapshot>", "exec"),scope)
        self.assertEqual(len(scope["running_agents"]()),501)
        self.assertEqual(pages,[1,2])
        scope["cli_json"]=lambda *args:{"agents":[],"unreadable":[{"id":"broken"}]}
        with self.assertRaisesRegex(RuntimeError,"incomplete ownership data"):
            scope["running_agents"]()

    def test_canonical_and_installed_skills_agree(self):
        self.assertFalse((REPO / "docs/skills/scheduler.md").exists())
        scheduler = (REPO / "skills/antonina-scheduler/SKILL.md").read_text()
        orchestrator = (REPO / "docs/skills/orchestrator.md").read_text()
        orchestrator_skill = (REPO / "skills/antonina-orchestrator/SKILL.md").read_text()
        self.assertTrue(scheduler.startswith("---\nname: antonina-scheduler\n"))
        self.assertTrue(orchestrator_skill.endswith(orchestrator))
        intent = (REPO / "docs/intent-records/scheduling-topology.md").read_text()
        self.assertIn("sole legitimate reason", intent)
        for doc in [scheduler, orchestrator]:
            self.assertIn("topology-only", doc.lower())
            self.assertIn("antonina-scheduler-launch", doc)
            self.assertNotIn("docs/skills/scheduler.md", doc)


class FullFrontierTests(unittest.TestCase):
    def test_single_launch_exit_instruction_is_absent(self):
        script = (ROOT / "antonina-orchestrator-turn").read_text()
        self.assertIn("FULL-FRONTIER DISPATCH", script)
        self.assertIn("delegate every topologically ready independent front", script)
        self.assertNotIn("RETURN IMMEDIATELY", script)
        self.assertNotIn("after one successful launch or a precise blocker", script)
        self.assertIn("completed design or implementation", script)

    def test_terminal_hints_are_bounded_and_issue_keyed(self):
        snapshot = (ROOT / "antonina-scheduler-snapshot").read_text()
        self.assertIn('context["recent_terminal_agents"] = compact_terminal_hints(terminal_hints, open_ids)', snapshot)
        func = next(x for x in ast.parse(snapshot).body
                    if isinstance(x, ast.FunctionDef) and x.name == "recent_terminal_agents")
        def fake_cli(*args):
            self.assertEqual(args[:3], ("agent", "list", "--finished"))
            return {"agents": [
                {"id": "done", "state": "succeeded",
                 "title": "Supernatural #225: Schaerbeek design", "finished_at": 100},
                {"id": "other", "state": "failed",
                 "title": "AssemblyP1 #211: proof", "finished_at": 90},
            ], "unreadable": []}
        scope = {"cli_json": fake_cli, "subprocess": __import__("subprocess"),
                 "issue_id_from_agent_title": lambda title:
                    re.search(r"#(\d+)", title).group(1) if re.search(r"#(\d+)", title) else None}
        exec(compile(ast.Module(body=[func], type_ignores=[]),
                     "<terminals>", "exec"), scope)
        result=scope["recent_terminal_agents"]()
        self.assertFalse(result["incomplete"])
        self.assertEqual([(a["issue"], a["process_state"], a["delivery_state"])
                          for a in result["agents"]],
                         [("225", "succeeded", "unverified"),
                          ("211", "failed", "unverified")])

    def test_terminal_success_does_not_certify_delivery(self):
        snapshot = (ROOT / "antonina-scheduler-snapshot").read_text()
        turn = (ROOT / "antonina-orchestrator-turn").read_text()
        self.assertIn('"delivery_state": "unverified"', snapshot)
        self.assertIn('context["unverified_terminal_issues"]', snapshot)
        self.assertIn("process_state, not task completion", turn)
        self.assertIn("Never declare all issues covered", turn)
        launcher = (ROOT / "antonina-scheduler-launch").read_text()
        for field in ("[terminal-handoff]", "artifact:", "validation:", "next:"):
            self.assertIn(field, launcher)

    def test_terminal_snapshot_only_contains_open_issue_latest(self):
        source = ast.parse((ROOT / "antonina-scheduler-snapshot").read_text())
        f = next(x for x in source.body if isinstance(x, ast.FunctionDef)
                 and x.name == "compact_terminal_hints")
        ns = {}
        exec(compile(ast.Module(body=[f], type_ignores=[]), "<compact>", "exec"), ns)
        hints = {"agents": [
            {"issue": "225", "state": "succeeded", "id": "latest"},
            {"issue": "900", "state": "succeeded", "id": "closed"},
            {"issue": "225", "state": "failed", "id": "older"},
            {"issue": "229", "state": "succeeded", "id": "maxwell"},
        ], "incomplete": False}
        result = ns["compact_terminal_hints"](hints, {"225", "229"})
        self.assertEqual([a["id"] for a in result["agents"]],
                         ["latest", "maxwell"])
        self.assertFalse(result["incomplete"])

    def test_skills_and_worker_outcomes_agree(self):
        scheduler = (REPO / "skills/antonina-scheduler/SKILL.md").read_text()
        orchestrator = (REPO / "docs/skills/orchestrator.md").read_text()
        orchestrator_skill = (REPO / "skills/antonina-orchestrator/SKILL.md").read_text()
        self.assertFalse((REPO / "docs/skills/scheduler.md").exists())
        self.assertTrue(orchestrator_skill.endswith(orchestrator))
        for doc in (scheduler, orchestrator):
            self.assertIn("frontier", doc.lower())
        intent = (REPO / "docs/intent-records/full-frontier-dispatch.md").read_text()
        self.assertIn("entire", intent.lower())
        self.assertIn("awaiting review", intent.lower())
        launcher = (ROOT / "antonina-scheduler-launch").read_text()
        self.assertIn("TERMINAL HANDOFF", launcher)


class SubstantiveIssueTests(unittest.TestCase):
    def test_scheduler_chatter_does_not_hide_handoffs(self):
        helper = load_helper("antonina-scheduler-issue")
        routine = {"author": "openclaw@marceline-dev",
                   "createdAt": "2026-10-13T10:00:00Z",
                   "body": "[scheduler-turn]\nstate: working\nsummary: repeated launch"}
        handoff = {"author": "agent-abc", "createdAt": "2026-10-12T11:00:00Z",
                   "body": "[terminal-handoff]\nstate: partial\nartifact: branch abc\nnext: finish tests"}
        human = {"author": "human", "createdAt": "2026-10-12T12:00:00Z",
                 "body": "Do not merge until CI passes"}
        orchestrator = {"author": "openclaw@marceline-dev",
                        "body": "[orchestrator]\nstate: working\nsummary: repeated turn"}
        page1 = {"number": 19, "state": "open", "title": "Kawun #19",
                 "body": "full description", "messages": [routine] * 49 + [orchestrator]}
        page2 = {"number": 19, "state": "open", "title": "Kawun #19",
                 "body": "full description", "messages": [handoff, human]}
        calls = []
        def fake_check_output(args, text=True):
            calls.append(int(args[args.index("--page") + 1]))
            return json.dumps(page1 if calls[-1] == 1 else page2)
        with patch.object(helper.subprocess, "check_output", side_effect=fake_check_output):
            result = helper.read_issue("19")
        self.assertEqual(calls, [1, 2])
        self.assertEqual([m["author"] for m in result["newest_messages"]],
                         ["human", "agent-abc"])
        self.assertEqual(len(result["latest_routine_launches"]), 2)
        self.assertEqual(result["latest_handoff_claim"]["claimed_state"], "partial")
        self.assertFalse(result["latest_handoff_claim"]["verified"])
        self.assertEqual(result["latest_handoff_claim"]["artifact_claim"], "branch abc")
        self.assertIsNone(result["latest_handoff_claim"]["validation_claim"])
        self.assertFalse(result["handoff_is_verified"])

    def test_preserves_long_issue_body_and_comment(self):
        helper = load_helper("antonina-scheduler-issue")
        page = {"number": 10, "state": "open", "title": "Issue",
                "body": "b" * 9000,
                "messages": [{"author": "human", "body": "c" * 5500}]}
        with patch.object(helper.subprocess, "check_output", return_value=json.dumps(page)):
            result = helper.read_issue("10")
        self.assertEqual(len(result["body"]), 9000)
        self.assertEqual(len(result["newest_messages"][0]["body"]), 5500)
        self.assertEqual(result["pages_read"], 1)


class SchedulerDeploymentTests(unittest.TestCase):
    def test_atomic_install_and_detects_deployment_drift(self):
        import os
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ)
            env["ANTONINA_BIN_DIR"] = temp + "/bin"
            env["ANTONINA_SKILL_DIR"] = temp + "/skills"
            env["ANTONINA_OPENCODE_CONFIG"] = temp + "/config/openclaw.json"
            env["ANTONINA_RESTART"] = "never"
            deploy = str(ROOT / "antonina-scheduler-deploy")
            subprocess.run([deploy, "--install"], env=env, check=True,
                           capture_output=True, text=True)
            subprocess.run([deploy, "--check"], env=env, check=True,
                           capture_output=True, text=True)
            installed = Path(temp) / "bin" / "antonina-scheduler-issue"
            self.assertEqual(installed.read_bytes(),
                             (ROOT / "antonina-scheduler-issue").read_bytes())
            config = Path(temp) / "config" / "openclaw.json"
            self.assertEqual(config.read_bytes(),
                             (ROOT.parent / "config/opencode-openclaw.json").read_bytes())
            installed.write_text("stale")
            result = subprocess.run([deploy, "--check"], env=env,
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("out of sync", result.stderr)


class OrchestratorModelRecoveryTests(unittest.TestCase):
    def test_real_oauth_quota_and_structured_rate_throttle(self):
        helper = load_helper("antonina-orchestrator-model")
        self.assertEqual(helper.classify(1, b"Error: The usage limit has been reached"), "quota_exhausted")
        self.assertEqual(helper.classify(1, b'{"type":"error","error":{"name":"APIError","data":{"message":"The usage limit has been reached","statusCode":429}}}'), "quota_exhausted")
        self.assertEqual(helper.classify(1, b'{"type":"error","error":{"name":"APIError","data":{"message":"Throttled","statusCode": 429}}}'), "rate_limited")
        self.assertEqual(helper.classify(1, b"Error: invalid_api_key; The usage limit has been reached"), None)
        self.assertEqual(helper.classify(1, b"Error: Failed to compile user project"), None)
        self.assertEqual(helper.classify(1, b"Error: Endpoint is unavailable"), "transient_backend")

    def test_quota_switches_persistently_and_recovers_after_six_hours(self):
        import os
        import tempfile
        helper = load_helper("antonina-orchestrator-model")
        with tempfile.TemporaryDirectory() as root, \
                patch.dict(os.environ, {"XDG_STATE_HOME": root}), \
                patch.object(helper, "configured_models", return_value=["test/luna", "test/beam"]), \
                patch.object(helper.time, "time", return_value=1000):
            self.assertEqual(helper.choose(), "test/luna")
            self.assertEqual(helper.record_result("test/luna", 1, b"Error: insufficient_quota"), 75)
            saved = json.loads(helper.state_path().read_text())
            self.assertEqual(saved["cooldowns"][0]["reason"], "quota_exhausted")
            self.assertEqual(saved["cooldowns"][0]["until"], 1000 + 21600)
            self.assertEqual(helper.choose(), "test/beam")
            self.assertEqual(helper.record_result("test/beam", 0, b"worked"), 0)
            with patch.object(helper.time, "time", return_value=1000 + 21601):
                self.assertEqual(helper.choose(), "test/luna")
            self.assertEqual(helper.read_state()["selected_model"], "test/luna")

    def test_transient_retries_twice_then_switches(self):
        import os
        import tempfile
        helper = load_helper("antonina-orchestrator-model")
        with tempfile.TemporaryDirectory() as root, \
                patch.dict(os.environ, {"XDG_STATE_HOME": root}), \
                patch.object(helper, "configured_models", return_value=["test/luna", "test/beam"]), \
                patch.object(helper.time, "time", return_value=2000):
            self.assertEqual(helper.choose(), "test/luna")
            for count in (1, 2):
                self.assertEqual(helper.record_result("test/luna", 1, b"Endpoint is unavailable"), 75)
                self.assertEqual(helper.read_state()["transient"], {"model": "test/luna", "count": count})
                self.assertEqual(helper.choose(), "test/luna")
            self.assertEqual(helper.record_result("test/luna", 1, b"Endpoint is unavailable"), 75)
            self.assertEqual(helper.choose(), "test/beam")
            self.assertEqual(helper.read_state()["cooldowns"][0]["reason"], "transient_backend")

    def test_auth_unknown_and_tool_failures_do_not_switch(self):
        import os
        import tempfile
        helper = load_helper("antonina-orchestrator-model")
        with tempfile.TemporaryDirectory() as root, \
                patch.dict(os.environ, {"XDG_STATE_HOME": root}), \
                patch.object(helper, "configured_models", return_value=["test/luna", "test/beam"]):
            helper.choose()
            for line in (b"invalid_api_key", b"Payment Required",
                         b"Error: failed to compile user project"):
                self.assertEqual(helper.record_result("test/luna", 1, line), 1)
                self.assertEqual(helper.choose(), "test/luna")
                self.assertFalse(helper.read_state()["cooldowns"])

    def test_real_child_output_is_forwarded_and_status_tracked(self):
        import subprocess
        import os
        import sys
        import tempfile
        helper = load_helper("antonina-orchestrator-model")
        with tempfile.TemporaryDirectory() as root, \
                patch.dict(os.environ, {"XDG_STATE_HOME": root}), \
                patch.object(helper, "configured_models", return_value=["test/luna", "test/beam"]):
            self.assertEqual(helper.choose(), "test/luna")
            result = subprocess.run(
                [sys.executable, str(ROOT / "antonina-orchestrator-model"),
                 "run", "test/luna", "--", "/bin/sh", "-c",
                 "printf 'Endpoint is unavailable\\n'; exit 1"],
                env={**os.environ, "XDG_STATE_HOME": root}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 75, result.stderr)
            self.assertIn("Endpoint is unavailable", result.stdout)
            self.assertEqual(helper.read_state()["transient"]["count"], 1)

    def test_real_orchestrator_turn_advances_to_configured_fallback(self):
        import os
        import subprocess
        import shutil
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            bin_dir = base / ".local" / "bin"
            bin_dir.mkdir(parents=True)
            helper = bin_dir / "antonina-orchestrator-model"
            shutil.copy2(ROOT / "antonina-orchestrator-model", helper)
            helper.chmod(0o755)
            fake_cli = bin_dir / "antonina"
            fake_cli.write_text(
                '#!/bin/sh\n'
                'if [ "$1" = "agent" ] && [ "$2" = "model" ] && [ "$3" = "list" ]; then\n'
                '  printf \'{"models":[{"model":"example/luna","comment":"tested"},{"model":"example/beam","comment":"tested"}]}\n\'\n'
                '  exit 0\n'
                'fi\n'
                'exit 2\n'
            )
            fake_cli.chmod(0o755)
            snapshot = bin_dir / "antonina-scheduler-snapshot"
            snapshot.write_text('#!/bin/sh\necho \'{"open_issues":[],"live_agents":[]}\'\n')
            snapshot.chmod(0o755)
            fake_backend = bin_dir / "opencode-openclaw"
            fake_backend.write_text(
                '#!/bin/sh\n'
                'previous=""\n'
                'for arg in "$@"; do\n'
                '  if [ "$previous" = "--model" ]; then\n'
                '    if [ "$arg" = "example/luna" ]; then echo "Error: The usage limit has been reached" >&2; exit 1; fi\n'
                '    if [ "$arg" = "example/beam" ]; then echo "ORCHESTRATOR_RECOVERED"; exit 0; fi\n'
                '  fi\n'
                '  previous="$arg"\n'
                'done\n'
                'exit 3\n'
            )
            fake_backend.chmod(0o755)
            env = dict(os.environ)
            env.update({"HOME": root, "XDG_STATE_HOME": str(base / "state")})
            turn = str(ROOT / "antonina-orchestrator-turn")
            first = subprocess.run([turn], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(first.returncode, 75, first.stderr)
            self.assertIn("The usage limit has been reached", first.stdout)
            second = subprocess.run([turn], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn("ORCHESTRATOR_RECOVERED", second.stdout)
            self.assertEqual(json.loads((base / "state/antonina/orchestrator-model.json").read_text())["selected_model"],
                             "example/beam")

    def test_recovery_exit_does_not_trigger_generic_failure_backoff(self):
        loop = (ROOT / "antonina-orchestrator-loop").read_text()
        self.assertIn('if [ "$turn_status" -eq 75 ]; then', loop)
        self.assertIn('failure_backoff=0', loop)
        self.assertIn('antonina-orchestrator-model', (ROOT / "antonina-orchestrator-turn").read_text())
        self.assertIn('antonina-orchestrator-model', (ROOT / "antonina-scheduler-deploy").read_text())


if __name__ == "__main__":
    unittest.main()
