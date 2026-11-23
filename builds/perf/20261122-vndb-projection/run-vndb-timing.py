#!/usr/bin/env python3
"""Replay or summarize the fixed VNDB component screen; does not import a database."""

import argparse
import hashlib
import json
import statistics
import subprocess
from pathlib import Path


SCHEDULE = [
    {"triple": triple, "position": position, "arm": arm}
    for triple in range(1, 5)
    for position, arm in (("A", "baseline"), ("B", "candidate"), ("C", "baseline"))
]


def label(run):
    return f"triple-{run['triple']}-{run['position']}-{run['arm']}"


def write_json(destination, value):
    destination.write_text(json.dumps(value, indent=2) + "\n")


def summarize(directory):
    directory = directory.resolve()
    plan = json.loads((directory / "plan.json").read_text())
    assert plan["runs"] == SCHEDULE, "Expected the complete fixed four-triple schedule"
    observations = []
    identities = {}
    for run in SCHEDULE:
        report = json.loads((directory / f"{label(run)}.json").read_text())
        arm = run["arm"]
        assert report["mode"] == "measure"
        assert report["selectedGroupCount"] == report["productionGroupCount"] == 170
        assert report["totalBanks"] == 665
        assert report["termRows"] == 6648310
        assert report["mediaRows"] == 146725
        assert report["fixtureSha256"] == "da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792"
        assert report["identities"][0] == report["identities"][1]
        assert report["identities"][0]["root"] == plan[f"{arm}Root"]
        assert report["identities"][0]["head"] == plan[f"{arm}Commit"]
        if arm in identities:
            assert identities[arm] == report["identities"][0], "Sources changed during the cohort"
        identities[arm] = report["identities"][0]
        groups = report["observations"]
        assert [group["index"] for group in groups] == list(range(170))
        assert sum(len(group["banks"]) for group in groups) == 665
        assert sum(group["termRows"] for group in groups) == 6648310
        assert all(group["resultFallbacks"] == 0 for group in groups)
        totals = {
            key: sum(group[key] for group in groups)
            for key in ("elapsedMs", "sourceInflateMs", "rowDecodeMs", "parseBankMs")
        }
        observations.append({**run, **totals, "rawReport": f"{label(run)}.json"})
    triples = []
    for index in range(0, len(observations), 3):
        before, candidate, after = observations[index:index + 3]
        reference_ms = (before["elapsedMs"] + after["elapsedMs"]) / 2
        triples.append({
            "triple": before["triple"],
            "baselineBeforeMs": before["elapsedMs"],
            "candidateMs": candidate["elapsedMs"],
            "baselineAfterMs": after["elapsedMs"],
            "baselineMeanMs": reference_ms,
            "candidateTimeChangePercent": 100 * (candidate["elapsedMs"] / reference_ms - 1),
            "unchangedBaselineDriftPercent": 100 * (after["elapsedMs"] / before["elapsedMs"] - 1),
        })
    result = {
        "schemaVersion": 1,
        "boundary": plan["boundary"],
        "signConvention": "Negative candidateTimeChangePercent means less measured time; baseline drift is C/A minus one.",
        "completeArms": len(observations),
        "termRowsPerArm": 6648310,
        "perGroupMediaRepresentativesPerArm": 146725,
        "fusedFallbacks": 0,
        "observations": observations,
        "triples": triples,
        "medianCandidateTimeChangePercent": statistics.median(row["candidateTimeChangePercent"] for row in triples),
        "equalWorkAggregateTimeChangePercent": 100 * (
            sum(row["candidateMs"] for row in triples) / sum(row["baselineMeanMs"] for row in triples) - 1
        ),
        "minimumBaselineDriftPercent": min(row["unchangedBaselineDriftPercent"] for row in triples),
        "maximumBaselineDriftPercent": max(row["unchangedBaselineDriftPercent"] for row in triples),
    }
    write_json(directory / "summary.json", result)
    print(json.dumps(result, indent=2))


def run_cohort(args):
    directory = args.output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    component = args.component.resolve()
    baseline = args.baseline_root.resolve()
    candidate = args.candidate_root.resolve()
    archive = args.archive.resolve()
    plan = {
        "schemaVersion": 1,
        "comparison": "4 baseline/candidate/baseline triples; candidate versus mean enclosing baselines",
        "warmup": "none; each arm starts a fresh Node process, module compiled before group timers",
        "groups": 170,
        "sourceBanks": 665,
        "expectedRows": 6648310,
        "baselineRoot": str(baseline),
        "candidateRoot": str(candidate),
        "baselineCommit": subprocess.check_output(["git", "-C", str(baseline), "rev-parse", "HEAD"], text=True).strip(),
        "candidateCommit": subprocess.check_output(["git", "-C", str(candidate), "rev-parse", "HEAD"], text=True).strip(),
        "componentSha256": hashlib.sha256(component.read_bytes()).hexdigest(),
        "node": str(args.node),
        "archivePath": str(archive),
        "boundary": "serialized compressed-source inflation, fused column parsing, owned result/image projection, prepared lookup indexes; source ZIP reads/sha256, module loading/compilation, output hashing, browser and storage excluded",
        "runs": SCHEDULE,
    }
    write_json(directory / "plan.json", plan)
    for run in SCHEDULE:
        source = baseline if run["arm"] == "baseline" else candidate
        output = directory / f"{label(run)}.json"
        command = [str(args.node), str(component), "measure", str(source), str(source), str(archive), str(output)]
        with (directory / f"{label(run)}.log").open("w") as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
        print(f"{label(run)}: exit {result.returncode}", flush=True)
        if result.returncode != 0:
            raise SystemExit(result.returncode)
    summarize(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Run all twelve arms sequentially; output directory must be new")
    run.add_argument("--node", type=Path, required=True, help="Absolute Node.js 22 executable path")
    run.add_argument("--baseline-root", type=Path, required=True)
    run.add_argument("--candidate-root", type=Path, required=True)
    run.add_argument("--archive", type=Path, required=True)
    run.add_argument("--output-dir", type=Path, required=True)
    run.add_argument("--component", type=Path, default=Path(__file__).with_name("vndb-component.mjs"))
    summary = commands.add_parser("summarize", help="Validate and summarize all twelve existing raw reports")
    summary.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "run":
        run_cohort(args)
    else:
        summarize(args.directory)


if __name__ == "__main__":
    main()
