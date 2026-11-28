#!/usr/bin/env python3
"""Expose compact hosted results while preserving the unchanged a7f7 acquisition.

This is a current-source re-evaluation of the remaining record-field helper
bypass from PR #764. It is not a new full-import improvement claim.
"""
import json
import pathlib
import subprocess
import sys
import traceback

arguments = sys.argv[1:]
if "--evidence" not in arguments:
    raise SystemExit("Pass the existing runner's --evidence option")
evidence = pathlib.Path(arguments[arguments.index("--evidence") + 1]).resolve()
evidence.parent.mkdir(parents=True, exist_ok=True)
log_path = evidence.with_name(evidence.name + "-runner.log")
summary_path = evidence.with_name(evidence.name + "-console-summary.json")
root = pathlib.Path(__file__).resolve().parents[2]
exit_code = 1
failure = None
try:
    with log_path.open("wb") as log:
        command = [sys.executable, str(root / "dev/perf/import-qualification-20261125-a7f7.py"), *arguments]
        exit_code = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT).returncode
except Exception as error:
    failure = {"type": type(error).__name__, "message": str(error)}
    traceback.print_exc()
finally:
    summary = {"runnerExitCode": exit_code, "wrapperFailure": failure,
               "candidate": arguments[arguments.index("--candidate") + 1],
               "baseline": arguments[arguments.index("--baseline") + 1],
               "dictionary": arguments[arguments.index("--dictionary") + 1],
               "initialOrder": arguments[arguments.index("--initial-order") + 1],
               "qualificationRunner": "dev/perf/import-qualification-20261125-a7f7.py",
               "existingProposal": "https://github.com/ManabiIO/manabitan/pull/764",
               "speedupQualified": False}
    for name in ["analysis.json", "observations.json", "memory/memory-audit.json",
                 "memory/semantic-failures.json", "memory/memory-audit-failure.json"]:
        path = evidence / name
        if path.is_file():
            try:
                summary[name] = json.loads(path.read_text())
            except Exception as error:
                summary[name] = {"readFailure": str(error)}
    identity_path = evidence / "source-identities.json"
    if identity_path.is_file():
        identities = json.loads(identity_path.read_text())
        summary["sourceIdentities"] = {
            "changedPackageEntries": identities["changedPackageEntries"],
            "arms": {arm: {key: value[key] for key in ["sha", "tree", "packageSha256", "lockSha256", "fixtureLockSha256"]}
                     for arm, value in identities["arms"].items()},
        }
    memory_path = evidence / "memory/memory-comparison.json"
    if memory_path.is_file():
        memory = json.loads(memory_path.read_text())
        summary["memoryComparison"] = {key: memory[key] for key in [
            "everyObservationQualified", "passesProspectiveMemoryScreen", "metrics", "pairs"]}
    summary_path.write_text(json.dumps(summary, sort_keys=True, indent=2) + "\n")
    print("RECORD_FIELD_SCREEN_RESULT " + json.dumps(summary, sort_keys=True), flush=True)
    if exit_code:
        logs = [log_path]
        if evidence.is_dir():
            logs += sorted(evidence.rglob("*.log"), key=lambda path: path.stat().st_mtime)[-3:]
        for path in logs:
            if path.is_file():
                with path.open("rb") as log:
                    log.seek(max(0, path.stat().st_size - 16384))
                    tail = log.read().decode("utf-8", errors="replace")
                print(f"RECORD_FIELD_SCREEN_FAILURE_LOG {path}\n{tail}", flush=True)
sys.exit(exit_code)
