"""Verify the frozen candidate and retained control, then seed one hosted replay."""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys


ARCHIVE = pathlib.Path(__file__).resolve().parent


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def load(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def preflight(args):
    protocol = load(ARCHIVE / "protocol.json")
    seed = load(ARCHIVE / "seed-vndb.json")
    original = load(ARCHIVE / "control-origin-vndb.json")
    observation = {
        "protocolSha256": digest(ARCHIVE / "protocol.json"),
        "candidateCheckout": str(args.candidate),
        "candidateStudyCommit": git(args.candidate, "rev-parse", "HEAD"),
        "candidateStudyTree": git(args.candidate, "rev-parse", "HEAD^{tree}"),
        "candidateProductCommit": protocol["candidateProductCommit"],
        "baselineCheckout": str(args.baseline),
        "baselineCommit": git(args.baseline, "rev-parse", "HEAD"),
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "python": sys.version,
        "platform": platform.platform(),
        "nodeOptions": os.environ.get("NODE_OPTIONS"),
        "oracleNavigatorHint": protocol["oracleNavigatorHint"],
        "runnerMeminfo": pathlib.Path("/proc/meminfo").read_text(),
        "archiveFiles": {},
        "runtimeTreeEntries": {},
        "sourceFiles": {"baseline": {}, "candidate": {}},
        "checksPassed": False,
    }
    try:
        assert observation["baselineCommit"] == protocol["baselineCommit"]
        assert observation["node"] == "v" + protocol["hostedNodeVersion"]
        memory_kib = int(observation["runnerMeminfo"].split("MemTotal:", 1)[1].split()[0])
        assert memory_kib * 1024 >= protocol["minimumRunnerMemoryBytes"], "Runner is below the declared memory class"
        for name, expected in protocol["archiveFiles"].items():
            actual = digest(ARCHIVE / name)
            observation["archiveFiles"][name] = actual
            assert actual == expected, f"Archived input changed: {name}"
        assert seed["arms"]["baseline"] == original["arms"]["baseline"], "Retained control arm changed"
        assert original["complete"] is True
        assert original["hardware"] == protocol["oracleNavigatorHint"]
        assert len(seed["arms"]["baseline"]["groups"]) == protocol["expectedGroups"]
        assert seed["arms"]["baseline"]["totals"]["rows"] == protocol["expectedRows"]
        assert seed["fixture"] == protocol["fixture"] == original["fixture"]
        assert seed["attemptedCandidate"]["sourceCommit"] == protocol["candidateProductCommit"]
        for key in ["fixture", "lockSha256", "parserWasmSha256"]:
            assert seed[key] == original[key], f"Control identity changed: {key}"
        for path, expected in protocol["candidateRuntimeTreeEntries"].items():
            actual = git(args.candidate, "rev-parse", f"HEAD:{path}")
            observation["runtimeTreeEntries"][path] = actual
            assert actual == expected, f"Candidate runtime tree changed: {path}"
        for arm, root, expected_files in [
            ("baseline", args.baseline, seed["arms"]["baseline"]["sourceIdentity"]),
            ("candidate", args.candidate, seed["attemptedCandidate"]["sourceIdentity"]),
        ]:
            for name, expected in expected_files.items():
                actual = digest(root / name)
                observation["sourceFiles"][arm][name] = actual
                assert actual == expected, f"Frozen {arm} source changed: {name}"
        for root in [args.baseline, args.candidate]:
            assert digest(root / "test/perf/dictionaries.lock.json") == seed["lockSha256"]
            assert digest(root / "dev/data/dictionary-wasm/term-bank-parser.wasm") == seed["parserWasmSha256"]
            assert digest(root / "package-lock.json") == protocol["packageLockSha256"]
        assert digest(args.candidate / "ext/lib/term-bank-parser.wasm") == seed["parserWasmSha256"]
        assert not git(args.candidate, "diff", "--name-only", "HEAD", "--", *protocol["candidateRuntimeTreeEntries"]), "Runtime worktree changed"
        # Candidate-only replay imports no baseline modules. Its native identity
        # check needs the normal generated asset, copied from this baseline's
        # own byte-verified committed artifact, without rebuilding any code.
        baseline_asset = args.baseline / "ext/lib/term-bank-parser.wasm"
        if not baseline_asset.exists():
            baseline_asset.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(args.baseline / "dev/data/dictionary-wasm/term-bank-parser.wasm", baseline_asset)
        assert digest(baseline_asset) == seed["parserWasmSha256"]
        output = args.evidence / "vndb.json"
        assert not output.exists(), "Refusing to replace an existing observation"
        shutil.copyfile(ARCHIVE / "seed-vndb.json", output)
        observation["seedSha256"] = digest(output)
        observation["command"] = [
            "node", str(ARCHIVE / "replay.mjs"), str(args.baseline), str(args.candidate),
            str(args.candidate / "builds/e2e-dictionary-cache"), str(output), "vndb", "candidate",
        ]
        observation["checksPassed"] = True
    except BaseException as error:
        observation["error"] = repr(error)
        raise
    finally:
        write(args.evidence / "preflight.json", observation)


def outcome(args):
    report_path = args.evidence / "vndb.json"
    report = load(report_path) if report_path.is_file() else None
    value = {
        "oracleStepOutcome": args.oracle_outcome,
        "sourceStudyCommit": git(args.candidate, "rev-parse", "HEAD"),
        "complete": report is not None and report.get("complete") is True,
        "files": {},
    }
    for path in sorted(args.evidence.rglob("*")):
        if path.is_file() and path.name != "outcome.json":
            value["files"][str(path.relative_to(args.evidence))] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    if value["complete"]:
        value["candidateTotals"] = report["arms"]["candidate"]["totals"]
        value["candidateGroups"] = len(report["arms"]["candidate"]["groups"])
        value["comparisons"] = report["comparisons"]
    write(args.evidence / "outcome.json", value)


parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["preflight", "outcome"])
parser.add_argument("--baseline", type=pathlib.Path, required=True)
parser.add_argument("--candidate", type=pathlib.Path, required=True)
parser.add_argument("--evidence", type=pathlib.Path, required=True)
parser.add_argument("--oracle-outcome", default="unknown")
arguments = parser.parse_args()
for name in ["baseline", "candidate", "evidence"]:
    setattr(arguments, name, getattr(arguments, name).resolve())
arguments.evidence.mkdir(parents=True, exist_ok=True)
(preflight if arguments.mode == "preflight" else outcome)(arguments)
