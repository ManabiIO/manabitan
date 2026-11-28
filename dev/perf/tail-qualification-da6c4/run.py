#!/usr/bin/env python3
"""Source-bound staged qualification for the frozen owned-tail product.

The copied common runner owns every browser observation and the unchanged
semantic, media, and memory protocol. This wrapper adds source binding,
repository gates, prospective per-host timing gates, and staged prerequisites.
It never changes runtime settings or removes observations.
"""

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback

from tail_stats import analyze, schedule


BASELINE = {
    "commit": "f28c2801fcfd9416f220b46b9cbafeee901c1cb2",
    "tree": "b428d0c9fa18e4956f3e2b182cae934de78e8f63",
}
CANDIDATE = {
    "commit": "cb77c4727d0bfd5175aa3684395a66e9887bfe64",
    "tree": "c89d9747a4e1836913e98497d7c3613d0f115eee",
}
CONTROL = "dev/perf/tail-qualification-da6c4"
WORKFLOW = ".github/workflows/tail-qualification-da6c4.yml"
EVIDENCE_PREFIX = "builds/perf/tail-qualification-20261128-da6c4/"
ORIGINAL_COMPARISON_KEYS = (
    "count", "ratios", "medianPairedChangePercent", "equalWorkChangePercent",
    "worstPairChangePercent", "descriptiveBootstrap95Percent", "fasterPairs",
)


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def digest_file(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def object_hash(value):
    return digest_bytes(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                   allow_nan=False).encode())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True,
                                    allow_nan=False) + "\n")


def read_json(path):
    return json.loads(Path(path).read_text())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git_bytes(root, *args):
    return subprocess.check_output(["git", *args], cwd=root)


def git(root, *args):
    return git_bytes(root, *args).decode().strip()


def run_identity():
    return {
        "githubRunId": os.environ.get("GITHUB_RUN_ID"),
        "githubRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    }


def source_binding(root, *, need_node):
    control = root / CONTROL
    require(Path(__file__).resolve().parent == control.resolve(),
            "Runner must execute from its frozen control directory")
    plan_path = control / "plan.json"
    manifest_path = control / "source-manifest.json"
    plan, manifest = read_json(plan_path), read_json(manifest_path)
    require(plan["baseline"] == BASELINE and plan["candidate"] == CANDIDATE,
            "Plan runtime identities differ")
    require(manifest["baseline"] == BASELINE and manifest["candidate"] == CANDIDATE,
            "Manifest runtime identities differ")
    actual = {}
    for relative, expected in manifest["files"].items():
        path = root / relative
        require(path.resolve().is_relative_to(root), "Control escapes repository")
        require(path.is_file() and not path.is_symlink(), f"Missing control: {relative}")
        actual[relative] = digest_file(path)
        require(actual[relative] == expected["sha256"], f"Changed control: {relative}")
        require(path.stat().st_size == expected["bytes"], f"Control size changed: {relative}")
    required_controls = {
        str(path.relative_to(root))
        for path in control.iterdir()
        if path.is_file() and path.name != "source-manifest.json"
    } | {WORKFLOW}
    require(set(manifest["files"]) == required_controls,
            "Manifest must cover every control file and the workflow exactly")
    for relative, expected in manifest["stockHelpers"].items():
        data = git_bytes(root, "show", f"{BASELINE['commit']}:{relative}")
        require(digest_bytes(data) == expected["sha256"],
                f"Frozen baseline helper differs: {relative}")
        require(git(root, "rev-parse", f"{BASELINE['commit']}:{relative}") == expected["blob"],
                f"Frozen helper Git blob differs: {relative}")
        require((root / relative).read_bytes() == data,
                f"Research helper differs from the frozen baseline: {relative}")
        require(git_bytes(root, "show", f"{CANDIDATE['commit']}:{relative}") == data,
                f"Candidate helper differs from the frozen baseline: {relative}")
    require(git(root, "status", "--porcelain=v1", "--untracked-files=all") == "",
            "Research source is dirty")
    head, tree = git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD^{tree}")
    github_sha = os.environ.get("GITHUB_SHA")
    if github_sha:
        require(head == github_sha, "Research checkout differs from GITHUB_SHA")
    if os.environ.get("GITHUB_RUN_ATTEMPT"):
        require(os.environ["GITHUB_RUN_ATTEMPT"] == "1",
                "An unchanged workflow attempt must not reacquire this cohort")
    for label, identity in (("baseline", BASELINE), ("candidate", CANDIDATE)):
        require(git(root, "rev-parse", f"{identity['commit']}^{{tree}}") == identity["tree"],
                f"{label} tree differs")
    require(git(root, "rev-list", "--parents", "-n", "1", CANDIDATE["commit"]).split() ==
            [CANDIDATE["commit"], BASELINE["commit"]], "Candidate parent differs")
    subprocess.run(["git", "merge-base", "--is-ancestor", CANDIDATE["commit"], head],
                   cwd=root, check=True)
    allowed = set(manifest["files"]) | {str(manifest_path.relative_to(root))}
    research_changes = git(root, "diff", "--name-only", CANDIDATE["commit"], head).splitlines()
    require(all(path in allowed or path.startswith(EVIDENCE_PREFIX)
                for path in research_changes), "Research branch changes runtime or unrelated tooling")
    product = read_json(control / "product-source.json")
    require(product["base"] == BASELINE["commit"] and product["baseTree"] == BASELINE["tree"]
            and product["candidateTree"] == CANDIDATE["tree"], "Product manifest differs")
    expected_paths = sorted(item["path"] for item in product["files"])
    require(sorted(git(root, "diff", "--name-only", BASELINE["commit"],
                       CANDIDATE["commit"]).splitlines()) == expected_paths,
            "Product change inventory differs")
    for item in product["files"]:
        data = git_bytes(root, "show", f"{CANDIDATE['commit']}:{item['path']}")
        require(len(data) == item["bytes"] and digest_bytes(data) == item["sha256"]
                and git(root, "rev-parse", f"{CANDIDATE['commit']}:{item['path']}") == item["blob"],
                f"Product bytes differ: {item['path']}")
    for dictionary in ("jmdict", "jitendex", "vndb"):
        for order in ("AB", "BA"):
            require(plan["schedules"][dictionary][order] == schedule(dictionary, order),
                    "Frozen schedule differs from the statistics module")
    node = subprocess.check_output(["node", "--version"], text=True).strip() if need_node else None
    if need_node:
        require(node == "v22.22.0", f"Unexpected Node version: {node}")
    identity = {
        "controlCommit": head, "controlTree": tree,
        "planSha256": digest_file(plan_path), "manifestSha256": digest_file(manifest_path),
        "baseline": BASELINE, "candidate": CANDIDATE,
    }
    return {
        "studyIdentity": identity, "runIdentity": run_identity(),
        "controlHashes": actual, "stockHelpers": manifest["stockHelpers"],
        "researchChanges": research_changes, "sourceDirty": False,
        "nodeVersion": node, "pythonVersion": sys.version,
    }, plan


def require_gate_context(gate, binding):
    require(type(gate) is dict and gate.get("complete") is True and gate.get("passed") is True,
            "Prerequisite is incomplete or failed")
    require(gate.get("studyIdentity") == binding["studyIdentity"],
            "Prerequisite source or controls differ")
    require(gate.get("runIdentity") == binding["runIdentity"],
            "Prerequisite belongs to another workflow run or attempt")


def require_verification_gate(gate, binding, plan):
    require_gate_context(gate, binding)
    require(gate.get("kind") == "repository-verification", "Expected repository prerequisite")
    require(gate.get("candidate") == CANDIDATE, "Verification candidate differs")
    actual = gate.get("commands", [])
    expected = plan["verification"]["commands"]
    require(len(actual) == len(expected), "Repository gate command inventory differs")
    for completed, prescribed in zip(actual, expected):
        require(completed.get("id") == prescribed["id"] and
                completed.get("command") == prescribed["command"] and
                completed.get("returncode") == 0, "A required repository gate did not pass")
    require(gate.get("candidateDirtyAfter") is False, "Candidate changed during verification")


def crosscheck_stock_analysis(stock, timing):
    for comparison in ("candidateVsBaseline", "identicalCodeControl"):
        expected = {key: timing[comparison][key] for key in ORIGINAL_COMPARISON_KEYS}
        require(stock.get(comparison) == expected,
                f"Prospective arithmetic differs from the unchanged common runner: {comparison}")
    require(stock.get("status") == "correctness-memory-passed" and stock.get("memoryPassed") is True,
            "Common semantic or memory gate failed")


def require_cell_gate(gate, binding):
    require_gate_context(gate, binding)
    require(gate.get("kind") == "cell", "Expected per-host cell prerequisite")
    dictionary, order = gate.get("dictionary"), gate.get("initialOrder")
    timing = analyze(gate["observations"], dictionary, order)
    require(timing == gate["timing"] and timing["timingPassed"] is True,
            "Cell statistics do not pass the frozen per-host rules")
    require(gate.get("runtimeIdentities") == {"A": BASELINE, "B": CANDIDATE},
            "Cell runtime source differs")
    memory = gate.get("memoryAudit", {})
    require(memory.get("observations") == 4 and memory.get("everyObservationQualified") is True
            and memory.get("passesProspectiveMemoryScreen") is True,
            "Cell lacks qualified original memory observations")
    return dictionary, order


def aggregate_gates(gates, stage, binding):
    expected = ({("jmdict", "AB"), ("jmdict", "BA")} if stage == "jmdict" else
                {(dictionary, order) for dictionary in ("jitendex", "vndb")
                 for order in ("AB", "BA")})
    require(len(gates) == len(expected), "Stage must contain every prescribed independent host exactly once")
    identities = [require_cell_gate(gate, binding) for gate in gates]
    require(len(identities) == len(set(identities)) and set(identities) == expected,
            "Stage host identity, order, or dictionary differs")
    return [
        {"dictionary": dictionary, "initialOrder": order, "gateSha256": object_hash(gate),
         "timing": gate["timing"], "memoryAudit": gate["memoryAudit"], "cellGate": gate}
        for (dictionary, order), gate in sorted(zip(identities, gates), key=lambda item: item[0])
    ]


def require_jmdict_stage(gate, binding, verification):
    require_gate_context(gate, binding)
    require(gate.get("kind") == "jmdict-stage" and
            gate.get("hostIdentities") == [["jmdict", "AB"], ["jmdict", "BA"]],
            "JMdict prerequisite is not the complete opposite-order stage")
    cells = gate.get("cells", [])
    require(type(cells) is list and len(cells) == 2, "JMdict prerequisite cells are missing")
    recomputed = aggregate_gates([cell["cellGate"] for cell in cells], "jmdict", binding)
    require(recomputed == cells, "JMdict prerequisite cell proof differs")
    require(gate.get("prerequisites") == [
        {"kind": verification["kind"], "sha256": object_hash(verification)}
    ], "JMdict prerequisite repository gate differs")


def tail_diagnostics(cohort):
    def visit(value, path, output):
        if isinstance(value, dict):
            for name, child in value.items():
                child_path = path + [name]
                if name in ("parserParallelOwnedTailLookaheadCount",
                            "fastPathParserParallelOwnedTailLookaheadCount"):
                    output.append({"path": child_path, "value": child})
                visit(child, child_path, output)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, path + [index], output)
    reports = []
    if cohort.is_dir():
        for path in sorted(cohort.rglob("run-1.json")):
            values = []
            visit(read_json(path), [], values)
            reports.append({"path": str(path.relative_to(cohort)),
                            "sha256": digest_file(path), "fields": values})
    return {
        "meaning": "Admission counter only; does not prove simultaneous CPU work",
        "expectedJmdictCandidateRange": [0, 11],
        "selectionOrExclusionRule": None,
        "duplicateMirrorsAreNotSummed": True, "reports": reports,
    }


class Runner:
    def __init__(self, root, evidence):
        self.root = root
        self.evidence = evidence
        self.commands = []
        self.worktrees = {"research": root}

    def command(self, identifier, command, cwd, *, env=None):
        entry = {"id": identifier, "command": command, "cwd": str(cwd),
                 "startedAtEpochMs": time.time_ns() // 1000000, "returncode": None}
        self.commands.append(entry)
        write_json(self.evidence / "commands.json", self.commands)
        started = time.monotonic()
        with (self.evidence / f"{identifier}.log").open("wb") as output:
            completed = subprocess.run(command, cwd=cwd, env=env, stdout=output,
                                       stderr=subprocess.STDOUT)
        entry.update(returncode=completed.returncode, elapsedSeconds=time.monotonic() - started)
        write_json(self.evidence / "commands.json", self.commands)
        require(completed.returncode == 0,
                f"Command {identifier} failed ({completed.returncode}); original log retained")

    def capture_state(self):
        result = {}
        state_dir = self.evidence / "source-state"
        state_dir.mkdir(exist_ok=True)
        for name, target in self.worktrees.items():
            if not target.exists():
                result[name] = {"captureError": "Expected worktree is missing", "path": str(target)}
                continue
            try:
                status = git(self.root if name == "research" else target,
                             "status", "--porcelain=v1", "--untracked-files=all")
                diff = git_bytes(target, "diff", "--binary", "HEAD")
                (state_dir / f"{name}.diff.patch").write_bytes(diff)
                generated = {}
                library = target / "ext/lib"
                if library.is_dir():
                    for path in sorted(library.rglob("*")):
                        if path.is_file() and path.suffix in (".js", ".mjs", ".map", ".wasm"):
                            generated[str(path.relative_to(target))] = {
                                "bytes": path.stat().st_size, "sha256": digest_file(path)}
                result[name] = {
                    "path": str(target), "head": git(target, "rev-parse", "HEAD"),
                    "tree": git(target, "rev-parse", "HEAD^{tree}"), "porcelain": status,
                    "diffSha256": digest_bytes(diff), "generatedFiles": generated,
                }
            except Exception as error:
                result[name] = {"captureError": repr(error), "path": str(target)}
        write_json(self.evidence / "source-state.json", result)
        require(all("captureError" not in item and item["porcelain"] == ""
                    for item in result.values()),
                "Final source-state capture failed or found source changes; original diagnostics retained")

    def verification(self, binding, plan):
        target = self.evidence.parent / (self.evidence.name + "-verified-candidate")
        require(not target.exists(), "Verification worktree already exists")
        self.command("worktree", ["git", "worktree", "add", "--detach", str(target),
                                 CANDIDATE["commit"]], self.root)
        self.worktrees["candidate"] = target
        shutil.copytree(self.root / "node_modules", target / "node_modules",
                        copy_function=os.link, symlinks=True)
        for item in plan["verification"]["commands"]:
            cwd = self.root if item["scope"] == "controls" else target
            self.command(item["id"], item["command"], cwd)
        require(git(target, "rev-parse", "HEAD") == CANDIDATE["commit"] and
                git(target, "rev-parse", "HEAD^{tree}") == CANDIDATE["tree"],
                "Verified checkout identity changed")
        require(git(target, "status", "--porcelain=v1", "--untracked-files=all") == "",
                "Candidate source changed during repository gates")
        after, _ = source_binding(self.root, need_node=True)
        require(after["studyIdentity"] == binding["studyIdentity"], "Controls changed during verification")
        result = {
            "schema": 1, "kind": "repository-verification", "complete": True, "passed": True,
            "studyIdentity": binding["studyIdentity"], "runIdentity": binding["runIdentity"],
            "candidate": CANDIDATE, "candidateDirtyAfter": False,
            "commands": [row for row in self.commands if row["id"] != "worktree"],
            "sourceBindingBefore": binding, "sourceBindingAfter": after,
        }
        require_verification_gate(result, binding, plan)
        write_json(self.evidence / "verification-gate.json", result)
        return result

    def cell(self, binding, plan, dictionary, order, prerequisites):
        verification = [item for item in prerequisites if item.get("kind") == "repository-verification"]
        require(len(verification) == 1, "One exact repository prerequisite is required")
        require_verification_gate(verification[0], binding, plan)
        if dictionary == "jmdict":
            require(len(prerequisites) == 1, "Unexpected JMdict prerequisite")
        else:
            stages = [item for item in prerequisites if item.get("kind") == "jmdict-stage"]
            require(len(stages) == 1 and len(prerequisites) == 2,
                    "Other dictionaries require both JMdict hosts to pass first")
            require_jmdict_stage(stages[0], binding, verification[0])
        cohort = self.evidence / "cohort"
        for label in ("A", "B"):
            self.worktrees[label] = self.evidence / "cohort-sources" / label
        command = [
            sys.executable, str(self.root / CONTROL / "common-runner.py"),
            "--baseline", BASELINE["commit"], "--candidate", CANDIDATE["commit"],
            "--dictionary", dictionary, "--initial-order", order,
            "--pairs", str(24 if dictionary == "jmdict" else 12),
            "--expected-workers", "3", "--evidence", str(cohort),
        ]
        for name in plan["expectedPackageChanges"]:
            command.extend(("--expected-package-entry", name))
        for name in plan["expectedPackageAdditions"]:
            command.extend(("--expected-added-package-entry", name))
        if dictionary == "vndb":
            command.extend(("--vndb-sah-allocation-units", "37", "37"))
        write_json(self.evidence / "pre-acquisition-binding.json", {
            "sourceBinding": binding, "dictionary": dictionary, "initialOrder": order,
            "command": command, "schedule": schedule(dictionary, order),
            "prerequisites": [{"kind": row["kind"], "sha256": object_hash(row)}
                              for row in prerequisites],
            "flags": {}, "expectedWorkers": 3, "authoritativeTiming": "ordinary browser only",
        })
        try:
            self.command("common-runner", command, self.root)
        finally:
            write_json(self.evidence / "tail-admission-diagnostics.json", tail_diagnostics(cohort))
        observations = read_json(cohort / "observations.json")
        timing = analyze(observations, dictionary, order)
        stock = read_json(cohort / "analysis.json")
        crosscheck_stock_analysis(stock, timing)
        registered = read_json(cohort / "registered-plan.json")
        require(registered["schedule"] == plan["schedules"][dictionary][order] == timing["schedule"],
                "Executed schedule differs")
        require(registered["flags"] == {} and registered["expectedWorkers"] == 3,
                "Runtime settings differ")
        identities = read_json(cohort / "source-identities.json")
        for label, expected in (("A", BASELINE), ("B", CANDIDATE)):
            require(identities["arms"][label]["sha"] == expected["commit"] and
                    identities["arms"][label]["tree"] == expected["tree"], "Executed source differs")
        audit = read_json(cohort / "memory/memory-audit.json")
        after, _ = source_binding(self.root, need_node=True)
        require(after["studyIdentity"] == binding["studyIdentity"], "Controls changed during cell")
        result = {
            "schema": 1, "kind": "cell", "complete": True, "passed": timing["timingPassed"],
            "studyIdentity": binding["studyIdentity"], "runIdentity": binding["runIdentity"],
            "dictionary": dictionary, "initialOrder": order,
            "runtimeIdentities": {"A": BASELINE, "B": CANDIDATE},
            "observations": observations, "timing": timing, "memoryAudit": audit,
            "originalReceiptHashes": {
                name: digest_file(cohort / name) for name in (
                    "registered-plan.json", "source-identities.json", "browser-identity.json",
                    "analysis.json", "observations.json", "memory/memory-comparison.json",
                    "memory/memory-audit.json", "memory/semantic-failures.json")},
            "diagnosticSha256": digest_file(self.evidence / "tail-admission-diagnostics.json"),
            "sourceBindingBefore": binding, "sourceBindingAfter": after,
        }
        write_json(self.evidence / "cell-result.json", result)
        require_cell_gate(result, binding)
        write_json(self.evidence / "cell-gate.json", result)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("verify", "cell", "aggregate"), required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"))
    parser.add_argument("--initial-order", choices=("AB", "BA"))
    parser.add_argument("--prerequisite", type=Path, action="append", default=[])
    parser.add_argument("--gate-directory", type=Path)
    parser.add_argument("--stage", choices=("jmdict", "nonregression"))
    args = parser.parse_args()
    root, evidence = args.repository.resolve(), args.evidence.resolve()
    require(not evidence.exists(), "Evidence directory already exists; no implicit retry or overwrite")
    evidence.mkdir(parents=True)
    runner = Runner(root, evidence)
    outcome = {"schema": 1, "mode": args.mode, "complete": False, "passed": False,
               "retried": False, "startedAtEpochMs": time.time_ns() // 1000000}
    failed = False
    try:
        for path in sorted((root / CONTROL).glob("*.py")):
            ast.parse(path.read_text(), filename=str(path))
        binding, plan = source_binding(root, need_node=args.mode != "aggregate")
        write_json(evidence / "source-binding.json", binding)
        prerequisites = [read_json(path) for path in args.prerequisite]
        if args.mode == "verify":
            require(not prerequisites and args.dictionary is None and args.stage is None,
                    "Unexpected verification arguments")
            result = runner.verification(binding, plan)
        elif args.mode == "cell":
            require(args.dictionary is not None and args.initial_order is not None and args.stage is None,
                    "Cell identity is required")
            result = runner.cell(binding, plan, args.dictionary, args.initial_order, prerequisites)
        else:
            require(args.gate_directory is not None and args.stage is not None,
                    "Aggregate stage and gate directory are required")
            verification = [item for item in prerequisites if item.get("kind") == "repository-verification"]
            require(len(verification) == 1, "Aggregate requires the exact repository gate")
            require_verification_gate(verification[0], binding, plan)
            if args.stage == "jmdict":
                require(len(prerequisites) == 1, "Unexpected JMdict stage prerequisite")
            else:
                stages = [item for item in prerequisites if item.get("kind") == "jmdict-stage"]
                require(len(stages) == 1 and len(prerequisites) == 2,
                        "Final aggregation requires the passed JMdict stage")
                require_jmdict_stage(stages[0], binding, verification[0])
            gates = [read_json(path) for path in sorted(args.gate_directory.rglob("cell-gate.json"))]
            cells = aggregate_gates(gates, args.stage, binding)
            result = {
                "schema": 1, "kind": "jmdict-stage" if args.stage == "jmdict" else "complete-study",
                "complete": True, "passed": True, "studyIdentity": binding["studyIdentity"],
                "runIdentity": binding["runIdentity"], "cells": cells,
                "hostIdentities": [[cell["dictionary"], cell["initialOrder"]] for cell in cells],
                "prerequisites": [{"kind": row["kind"], "sha256": object_hash(row)}
                                  for row in prerequisites],
                "scope": "Every required host passes independently; no pooled timing conclusion",
            }
            after, _ = source_binding(root, need_node=False)
            require(after["studyIdentity"] == binding["studyIdentity"], "Controls changed during aggregation")
            write_json(evidence / "stage-gate.json", result)
        outcome.update(complete=True, passed=True, resultKind=result["kind"])
    except Exception as error:
        failed = True
        outcome["failure"] = {"type": type(error).__name__, "message": str(error),
                              "traceback": traceback.format_exc()}
    finally:
        try:
            runner.capture_state()
        except Exception as error:
            failed = True
            outcome["stateCaptureFailure"] = repr(error)
        if failed:
            outcome["complete"] = False
            outcome["passed"] = False
            # A failed final capture must never leave a publishable gate.
            for name in ("verification-gate.json", "cell-gate.json", "stage-gate.json"):
                path = evidence / name
                if path.is_file():
                    path.rename(evidence / ("failed-" + name))
        outcome["finishedAtEpochMs"] = time.time_ns() // 1000000
        write_json(evidence / "outcome.json", outcome)
        print("TAIL_OUTCOME " + json.dumps(outcome, sort_keys=True))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
