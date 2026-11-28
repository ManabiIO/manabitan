#!/usr/bin/env python3
"""Emit original compact evidence and failed log tails, even after a failed gate."""
import argparse
import hashlib
import json
from pathlib import Path


def report(root):
    names = [
        "outcome.json", "source-binding.json", "commands.json",
        "verification-gate.json", "failed-verification-gate.json",
        "cell-result.json", "cell-gate.json", "failed-cell-gate.json",
        "stage-gate.json", "failed-stage-gate.json", "pre-acquisition-binding.json",
        "tail-admission-diagnostics.json", "source-state.json",
        "cohort/registered-plan.json", "cohort/browser-identity.json",
        "cohort/observations.json", "cohort/analysis.json",
        "cohort/memory/memory-comparison.json", "cohort/memory/memory-audit.json",
        "cohort/memory/memory-audit-failure.json", "cohort/memory/semantic-failures.json",
    ]
    for name in names:
        path = root / name
        if not path.is_file():
            continue
        raw = path.read_bytes()
        try:
            data = json.loads(raw)
            if name == "source-state.json":
                for state in data.values():
                    generated = state.pop("generatedFiles", {})
                    state["generatedFileCount"] = len(generated)
                    state["generatedFilesSha256"] = hashlib.sha256(
                        json.dumps(generated, sort_keys=True, separators=(",", ":")).encode()
                    ).hexdigest()
            print("TAIL_RECEIPT " + json.dumps({
                "path": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "data": data,
            }, sort_keys=True), flush=True)
        except Exception as error:
            print("TAIL_REPORT_ERROR " + json.dumps({"path": name, "error": repr(error),
                                                     "rawTail": raw[-4000:].decode(errors="replace")}), flush=True)
    identity = root / "cohort/source-identities.json"
    if identity.is_file():
        raw = identity.read_bytes()
        data = json.loads(raw)
        for arm in data["arms"].values():
            entries = arm.pop("entries")
            arm["packageMemberCount"] = len(entries)
            arm["packageEntriesSha256"] = hashlib.sha256(
                json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        print("TAIL_IDENTITY " + json.dumps({
            "path": "cohort/source-identities.json", "sha256": hashlib.sha256(raw).hexdigest(),
            "data": data,
        }, sort_keys=True), flush=True)
    outcome_path = root / "outcome.json"
    passed = outcome_path.is_file() and json.loads(outcome_path.read_text()).get("passed") is True
    if not passed:
        for parent in (root, root / "cohort"):
            if not parent.is_dir():
                continue
            paths = sorted(parent.glob("*.log"))
            if parent.name == "cohort":
                paths.extend(sorted(parent.glob("*/*.log")))
                paths.extend(sorted(parent.glob("memory/*/*.log")))
            for path in paths:
                if path.name == "run.log" and (path.parent / "canonical-receipt.json").is_file():
                    continue
                print("TAIL_LOG " + str(path.relative_to(root)), flush=True)
                print("\n".join(path.read_text(errors="replace").splitlines()[-80:]), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    report(args.evidence)
