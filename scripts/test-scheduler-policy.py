#!/usr/bin/env python3
"""Regression tests for the deployed Antonina scheduler control-plane helpers."""
import ast
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import re
import unittest
from unittest.mock import patch
import types

ROOT = Path(__file__).resolve().parent
def load_helper(name):
    path = ROOT / name
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module

class SchedulerPolicyTests(unittest.TestCase):
    def test_hash_prefixed_agent_ids_are_recognized(self):
        source = ast.parse((ROOT / "antonina-scheduler-snapshot").read_text())
        f = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                 and node.name == "issue_number_from_agent_title")
        namespace = {"re": re}
        exec(compile(ast.Module(body=[f], type_ignores=[]), "<snapshot>", "exec"), namespace)
        parse = namespace[f.name]
        self.assertEqual(parse("AssemblyP1 #94: old research"), 94)
        self.assertEqual(parse("AssemblyP1 #208: new source census"), 208)
        self.assertEqual(parse("QAI #82: migration"), 82)
        self.assertIsNone(parse("AssemblyP1 freeform"))

    def test_unrecognized_project_gets_an_empty_agent_owned_workspace(self):
        p = load_helper("antonina-scheduler-provision")
        self.assertFalse(hasattr(p, "ROOTS"))
        with tempfile.TemporaryDirectory() as td, \
             patch.object(p, "ROOT", Path(td) / "workspace"), \
             patch.dict("os.environ", {"XDG_STATE_HOME": str(Path(td) / "state")}), \
             patch.object(p, "issue_record", return_value={"number": 223, "state": "open"}):
            p.ROOT.mkdir()
            registered = [False]
            def fake_cli(*args):
                if args[:3] == ("board", "resource", "add"):
                    registered[0] = True
                return {}
            with patch.object(p, "cli", side_effect=fake_cli), \
                 patch.object(p, "resource_registered", side_effect=lambda *_: registered[0]):
                self.assertEqual(p.provision(223, dry_run=True)["action"], "would_reserve")
                result = p.provision(223)
                self.assertTrue(result["registered"])
                self.assertTrue(result["clone_by_agent"])
                self.assertEqual(list(Path(result["cwd"]).iterdir()), [])
                self.assertEqual(p.provision(223)["action"], "reused")

    def test_bootstrap_prompt_instructs_agent_to_clone_unknown_repository(self):
        launch = load_helper("antonina-scheduler-launch")
        issue = {"number": 223, "title": "[Supernatural] Prologue", 
                 "body": "Repo: ottojung/vau.place"}
        with patch.object(launch, "is_git_checkout", return_value=False):
            prompt = launch.agent_prompt(issue, "/workspace/antonina-issue-223", "Edit prologue")
        self.assertIn("git clone URL .", prompt)
        self.assertIn("ottojung/vau.place", prompt)
        self.assertIn("Edit prologue", prompt)
        with patch.object(launch, "is_git_checkout", return_value=True):
            self.assertEqual(launch.agent_prompt(issue, "/workspace/old-worktree", "Edit prologue"), "Edit prologue")

    def test_closed_issue_is_a_hard_launch_error(self):
        p = load_helper("antonina-scheduler-launch")
        with patch.object(p, "run", return_value=types.SimpleNamespace(stdout=json.dumps({"state": "closed"}))):
            with self.assertRaises(SystemExit):
                p.require_open_issue(94)

    def test_racing_closure_stops_new_worker(self):
        p = load_helper("antonina-scheduler-launch")
        calls = []
        seen = [0]
        def open_then_close(issue):
            seen[0] += 1
            if seen[0] == 3:
                raise SystemExit("closed after start")
            return {"number": issue, "state": "open", "body": "Repo: ottojung/assemblyp1"}
        def mock_run(args, check=True):
            calls.append(args)
            return types.SimpleNamespace(returncode=0, stdout='{}', stderr='')
        with patch.object(p, "require_open_issue", side_effect=open_then_close), \
             patch.object(p, "chosen_cwd_is_available", return_value=True), \
             patch.object(p, "new_agent", return_value=types.SimpleNamespace(returncode=0, stdout='{}', stderr='')), \
             patch.object(p, "run", side_effect=mock_run), \
             patch("sys.argv", ["launcher","--issue","208","--cwd","/workspace/assemblyp1-finite-208",
                                "--title","t","--summary","s","--prompt","p"]):
            with self.assertRaises(SystemExit):
                p.main()
        self.assertTrue(any(a[1:3] == ["agent","stop"] for a in calls))
        self.assertFalse(any(a[1:3] == ["board","comment"] for a in calls))


    def test_live_inventory_is_reconciled_by_antonina_not_process_titles(self):
        for helper in ("antonina-scheduler-snapshot", "antonina-scheduler-worktrees"):
            source = (ROOT / helper).read_text()
            self.assertNotIn("pgrep", source)
            self.assertNotIn("live_ids(", source)
            tree = ast.parse(source)
            function = next(node for node in tree.body
                            if isinstance(node, ast.FunctionDef) and node.name == "running_agents")
            calls = []
            def fake_cli(*args):
                calls.append(args)
                return {"agents": [{"id": "continued", "state": "running",
                                    "title": "AssemblyP1 #214: continued session", "cwd": "/tmp"}],
                        "unreadable": []}
            scope = {"cli_json": fake_cli}
            exec(compile(ast.Module(body=[function], type_ignores=[]), "<running_agents>", "exec"), scope)
            self.assertEqual(scope["running_agents"]()[0]["id"], "continued")
            self.assertEqual(calls, [("agent", "list", "--page", 1, "--limit", 500, "--running", "--json")])
            scope["cli_json"] = lambda *args: {"agents": [], "unreadable": [{"id": "damaged"}]}
            with self.assertRaisesRegex(RuntimeError, "incomplete ownership data"):
                scope["running_agents"]()

    def test_running_inventory_traverses_second_page(self):
        source = ast.parse((ROOT / "antonina-scheduler-snapshot").read_text())
        function = next(node for node in source.body
                        if isinstance(node, ast.FunctionDef) and node.name == "running_agents")
        pages = []
        def fake_cli(*args):
            pages.append(args[3])
            return {"agents": [{"id": str(i)} for i in range(500)] if args[3] == 1
                    else [{"id": "continued"}], "unreadable": []}
        scope = {"cli_json": fake_cli}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "<running_agents>", "exec"), scope)
        self.assertEqual(len(scope["running_agents"]()), 501)
        self.assertEqual(pages, [1, 2])

    def test_release_retains_priority_first_and_provisioning(self):
        script = (ROOT / "antonina-orchestrator-turn").read_text()
        self.assertIn("PRIORITY-FIRST DISPATCH", script)
        self.assertIn("antonina-scheduler-provision", script)
        self.assertIn("No trusted repository-root allowlist", script)
        self.assertIn("live-agent snapshot failed", script)
        self.assertNotIn("FIRST ACTION: breadth", script)
        snapshot = (ROOT / "antonina-scheduler-snapshot").read_text()
        self.assertIn('#?(\\d+)', snapshot)
        self.assertIn('context["open_issues"] = issue_headers', snapshot)
        self.assertIn('"orphan_agents"', snapshot)

if __name__ == "__main__":
    unittest.main()
