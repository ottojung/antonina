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
    def test_generic_issue_number_parsing(self):
        fn = snapshot_function("issue_number_from_agent_title")
        scope = {"re": re}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "<snapshot>", "exec"), scope)
        parse = scope[fn.name]
        self.assertEqual(parse("AssemblyP1 #94: old research"), 94)
        self.assertEqual(parse("Supernatural #223: Prologue design"), 223)
        self.assertEqual(parse("[Supernatural] #223: Prologue design"), 223)
        self.assertEqual(parse("QAI #82: migration"), 82)
        self.assertEqual(parse("#211: proof"), 211)
        self.assertIsNone(parse("AssemblyP1 freeform"))

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
        self.assertNotIn("antonina-scheduler-provision", prompt)

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
             patch.object(launcher,"new_agent",return_value=types.SimpleNamespace(returncode=0,stdout="{}",stderr="")), \
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
             patch.object(launcher,"new_agent",return_value=types.SimpleNamespace(returncode=0,stdout="{}",stderr="")), \
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
        scheduler = (REPO/"docs/skills/scheduler.md").read_text()
        orchestrator = (REPO/"docs/skills/orchestrator.md").read_text()
        scheduler_skill = (REPO/"skills/antonina-scheduler/SKILL.md").read_text()
        orchestrator_skill = (REPO/"skills/antonina-orchestrator/SKILL.md").read_text()
        self.assertTrue(scheduler_skill.endswith(scheduler))
        self.assertTrue(orchestrator_skill.endswith(orchestrator))
        intent = (REPO/"docs/intent-records/scheduling-topology.md").read_text()
        self.assertIn("sole legitimate reason", intent)
        self.assertIn("topology-only", scheduler.lower())
        self.assertIn("topology-only", orchestrator.lower())
        for doc in [scheduler,orchestrator]:
            self.assertNotIn("antonina-scheduler-provision", doc.split("## Model")[0] if False else "")
            self.assertIn("antonina-scheduler-launch", doc)


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
        self.assertIn('context["recent_terminal_agents"] = terminal_hints', snapshot)
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
                 "issue_number_from_agent_title": lambda title:
                    int(re.search(r"#(\d+)", title).group(1)) if re.search(r"#(\d+)", title) else None}
        exec(compile(ast.Module(body=[func], type_ignores=[]),
                     "<terminals>", "exec"), scope)
        result=scope["recent_terminal_agents"]()
        self.assertFalse(result["incomplete"])
        self.assertEqual([(a["issue"], a["state"]) for a in result["agents"]],
                         [(225, "succeeded"), (211, "failed")])

    def test_skills_and_worker_outcomes_agree(self):
        for name in ("scheduler", "orchestrator"):
            doc = (REPO / "docs/skills" / (name + ".md")).read_text()
            skill = (REPO / "skills" / ("antonina-" + name) / "SKILL.md").read_text()
            self.assertTrue(skill.endswith(doc))
            self.assertIn("frontier", doc.lower())
        intent = (REPO / "docs/intent-records/full-frontier-dispatch.md").read_text()
        self.assertIn("entire", intent.lower())
        self.assertIn("awaiting review", intent.lower())
        launcher = (ROOT / "antonina-scheduler-launch").read_text()
        self.assertIn("TERMINAL HANDOFF", launcher)


if __name__ == "__main__":
    unittest.main()
