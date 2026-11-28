"""Independent original-module comparison for the prospective observer change."""

import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
WORKTREE = ROOT / "parallel-memory-acquisition"
DIRECTORY = WORKTREE / "dev/perf/import-memory-20261125-a7f7"
SOURCE = DIRECTORY / "chromium_memory.py"
BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
RELATIVE = str(SOURCE.relative_to(WORKTREE))
old = subprocess.check_output(["git", "show", f"{BASE}:{RELATIVE}"], cwd=WORKTREE)
new = SOURCE.read_bytes()
assert hashlib.sha256(old).hexdigest() == "8044bf3f4c48a868c7e076dc5f1bef9c2663f6323fe4a4fba5c121161cada4c7"

original_ast = ast.parse(old)
candidate_ast = ast.parse(new)
original_sample = next(node for node in original_ast.body if isinstance(node, ast.FunctionDef) and node.name == "sample_memory")
candidate_sample = next(node for node in candidate_ast.body if isinstance(node, ast.FunctionDef) and node.name == "sample_memory")
assert isinstance(original_sample.body[5], ast.For)
assert isinstance(candidate_sample.body[5], ast.If)
assert ast.unparse(original_sample.body[5].iter) == "before['processes']"
assert ast.unparse(candidate_sample.body[5].test) == "before['processes']"
candidate_sample.body[5] = copy.deepcopy(original_sample.body[5])
imports = [node for node in candidate_ast.body if isinstance(node, ast.ImportFrom) and node.module == "concurrent.futures"]
assert len(imports) == 1 and ast.unparse(imports[0]) == "from concurrent.futures import ThreadPoolExecutor"
candidate_ast.body.remove(imports[0])
assert ast.dump(original_ast, include_attributes=False) == ast.dump(candidate_ast, include_attributes=False)

sys.path.insert(0, str(DIRECTORY))
import chromium_memory as candidate
import test_parallel_acquisition as witnesses

baseline = types.ModuleType("frozen_serial_chromium_memory")
exec(compile(old, f"{BASE}:{RELATIVE}", "exec"), baseline.__dict__)


def evaluate(module, before, after, errors):
    def read(pid, _proc):
        if pid in errors:
            kind, args = errors[pid]
            raise kind(*args)
        return witnesses.metrics(pid)

    with patch.object(module, "process_inventory", side_effect=[copy.deepcopy(before), copy.deepcopy(after)]), \
            patch.object(module, "read_smaps", side_effect=read):
        return witnesses.normalized(module.sample_memory(10))


cases = []
for name, before, after, errors in witnesses.snapshot_cases():
    serial = evaluate(baseline, before, after, errors)
    parallel = evaluate(candidate, before, after, errors)
    assert parallel == serial, name
    cases.append({"case": name, "identical": True,
                  "qualified": parallel["qualifiedForWholeTreePss"],
                  "failures": parallel["qualificationFailures"],
                  "normalizedSha256": hashlib.sha256(json.dumps(parallel, sort_keys=True).encode()).hexdigest()})

unchanged = {}
for name in ("audit_memory.py", "protocol.py", "qualification_receipts.py", "test_chromium_memory.py", "test_import_window.py", "test_protocol.py", "test_qualification_receipts.py"):
    relative = str((DIRECTORY / name).relative_to(WORKTREE))
    original = subprocess.check_output(["git", "show", f"{BASE}:{relative}"], cwd=WORKTREE)
    assert original == (DIRECTORY / name).read_bytes(), name
    unchanged[name] = hashlib.sha256(original).hexdigest()

receipt = {"baselineCommit": BASE, "baselineSamplerSha256": hashlib.sha256(old).hexdigest(),
           "candidateSamplerSha256": hashlib.sha256(new).hexdigest(),
           "testSha256": hashlib.sha256((DIRECTORY / "test_parallel_acquisition.py").read_bytes()).hexdigest(),
           "wholeModuleAstIdenticalOutsideImportAndAcquisitionBlock": True,
           "unchangedFiles": unchanged,
           "comparison": "Actual frozen serial baseline module versus actual concurrent candidate module, with identical before/after snapshots and per-PID reader outcomes. Only four scan timestamps excluded.",
           "cases": cases,
           "performanceClaim": None,
           "limitations": ["Static outcomes cannot prove equal live memory values from non-atomic reads.",
                           "No claim that parallel acquisition will meet the unchanged 250 ms coverage requirement on a particular host.",
                           "Observer concurrency changes acquisition overhead; use prospectively and identically for both arms of a separate memory cohort."]}
target = ROOT / "results/parallel-memory-acquisition-source-proof.json"
target.write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
