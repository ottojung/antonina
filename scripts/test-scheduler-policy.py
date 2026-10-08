#!/usr/bin/env python3
"""Regression tests for the deployed Antonina scheduler control-plane helpers."""
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

    def test_provisioner_only_uses_trusted_roots(self):
        p = load_helper("antonina-scheduler-provision")
        self.assertEqual(p.project_of_title("[AssemblyP1 finite] audit"), "AssemblyP1")
        self.assertEqual(p.project_of_title("Antonina: restart"), "Antonina")
        self.assertIsNone(p.project_of_title("Unknown repository: request"))

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

if __name__ == "__main__":
    unittest.main()
