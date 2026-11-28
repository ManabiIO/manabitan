"""One registered, diagnostic-only cold JMdict canonical-column screen."""

import hashlib
import json
import os
import pathlib
import platform
import statistics
import subprocess
import time
import urllib.request


BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
ORDERS = ["ABC", "CBA", "BCA", "ACB", "CAB", "BAC"]
EXPECTED_DIGEST = "7d00fb3f8f54a44853c9fb7ab5df724c6319e280bad2790df5e5dad5f59a4da5"
ARENA_SOURCE = "ext/js/dictionary/term-content-metadata-arena.js"
root = pathlib.Path(__file__).resolve().parents[2]
baseline = pathlib.Path(os.environ["PERF_BASELINE_DIRECTORY"])
evidence = root / "builds/perf/canonical-column-spacing-4a779"
evidence.mkdir(parents=True, exist_ok=True)
screen = root / ".github/scripts/canonical-column-spacing-4a779.mjs"


def save(name, value):
    (evidence / name).write_text(json.dumps(value, indent=2) + "\n")


def git(repository, *args):
    return subprocess.check_output(["git", "-C", str(repository), *args], text=True).strip()


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


assert git(baseline, "rev-parse", "HEAD") == BASELINE
assert git(root, "diff", "--name-only", BASELINE, "HEAD", "--", "ext") == ARENA_SOURCE
node_version = subprocess.check_output(["node", "--version"], text=True).strip()
assert node_version.startswith("v22."), node_version
lock = json.loads((root / "test/perf/dictionaries.lock.json").read_text())["dictionaries"]["jmdict"]
archive = root / "builds/e2e-dictionary-cache" / lock["cacheFile"]
archive.parent.mkdir(parents=True, exist_ok=True)
if not archive.exists():
    request = urllib.request.Request(lock["url"], headers={"User-Agent": "ManabitanCanonicalColumnExperiment"})
    with urllib.request.urlopen(request) as source, archive.open("wb") as output:
        while block := source.read(1024 * 1024):
            output.write(block)
assert archive.stat().st_size == lock["sizeBytes"]
assert digest(archive) == lock["sha256"]

source_hashes = {"A": digest(baseline / ARENA_SOURCE), "B": digest(root / ARENA_SOURCE)}
source_hashes["C"] = source_hashes["A"]
assert source_hashes["A"] != source_hashes["B"]
cpu_info = pathlib.Path("/proc/cpuinfo").read_text()
registration = {
    "purpose": "Resolve noisy local controls with one hosted diagnostic component screen; no automatic promotion or full-import claim.",
    "baseline": BASELINE,
    "candidate": git(root, "rev-parse", "HEAD"),
    "orders": ORDERS,
    "processes": 18,
    "node": node_version,
    "platform": platform.platform(),
    "cpuModel": next((line.partition(":")[2].strip() for line in cpu_info.splitlines() if line.startswith("model name")), "unknown"),
    "sourceSha256": source_hashes,
    "screenSha256": digest(screen),
    "launcherSha256": digest(pathlib.Path(__file__)),
    "fixture": lock,
    "expectedLogicalDigest": EXPECTED_DIGEST,
    "expectedArenaBytes": {"A": 26214400, "B": 26279936, "C": 26214400},
    "comparison": "Retain every cold 12-group observation. Compare whole-wrapper and native wall/CPU, identical A/C controls, first group and later-group sums. Do not trim outliers or add repetitions after seeing results.",
    "followupGate": "For further investigation only: whole-wrapper median at least 5% lower than each control; at least 5/6 faster paired observations against each; A/C whole-wrapper median difference within 5%; whole-wrapper CPU median no more than 2% above either control. Anything weaker closes the candidate without further replication. Passing is not PR or release approval.",
    "scope": "Parsing/preparation excluded; first scanner includes instantiation. Exact verification included in wrapper. Publication excluded. One fixed-capacity metadata index across all groups. Logical state/output hashing occurs only after all groups.",
}
save("registration.json", registration)

environment = dict(os.environ)
environment["PERF_BASELINE_DIRECTORY"] = str(baseline)
environment["PERF_CANDIDATE_DIRECTORY"] = str(root)
environment["PERF_JMDICT_ARCHIVE"] = str(archive)
receipt = {"registration": registration, "runs": []}
observations = {arm: [] for arm in "ABC"}
reference_stats = None
for block, order in enumerate(ORDERS, 1):
    for arm in order:
        output = evidence / f"run-{block}-{arm}.json"
        assert not output.exists(), output
        started = time.time()
        result = subprocess.run(["node", str(screen), arm, str(output)], cwd=root, env=environment, text=True, capture_output=True)
        row = {
            "block": block, "order": order, "arm": arm, "startedEpoch": started,
            "processMs": (time.time() - started) * 1000,
            "returncode": result.returncode, "stdout": result.stdout,
            "stderr": result.stderr, "output": output.name,
        }
        receipt["runs"].append(row)
        save("launch.json", receipt)
        print(json.dumps(row), flush=True)
        assert result.returncode == 0, result.stderr
        observation = json.loads(output.read_text())
        assert observation["outputDigest"] == EXPECTED_DIGEST
        assert observation["arenaBytes"] == registration["expectedArenaBytes"][arm]
        assert observation["arenaSourceSha256"] == source_hashes[arm]
        assert observation["node"] == node_version
        if reference_stats is None:
            reference_stats = observation["stats"]
        assert observation["stats"] == reference_stats
        observations[arm].append(observation)

assert digest(screen) == registration["screenSha256"]
assert digest(archive) == lock["sha256"]
assert digest(baseline / ARENA_SOURCE) == source_hashes["A"]
assert digest(root / ARENA_SOURCE) == source_hashes["B"]
all_observations = [sample for samples in observations.values() for sample in samples]
assert len({sample["parserSha256"] for sample in all_observations}) == 1
assert len({sample["kernelSha256"] for sample in all_observations}) == 1


def summarize(values):
    medians = {arm: statistics.median(samples) for arm, samples in values.items()}
    pairs = {pair: [(y / x - 1) * 100 for x, y in zip(values[pair[0]], values[pair[1]])] for pair in ["AB", "CB", "AC"]}
    return {
        "values": values,
        "medians": medians,
        "ratioOfMediansPct": {pair: (medians[pair[1]] / medians[pair[0]] - 1) * 100 for pair in pairs},
        "pairedPct": pairs,
        "pairedMedianPct": {pair: statistics.median(samples) for pair, samples in pairs.items()},
        "candidateFasterPairs": {pair: sum(value < 0 for value in samples) for pair, samples in pairs.items()},
    }


summary = {
    "decision": "Diagnostic only; manual assessment required before any full-import cohort.",
    "registration": registration,
    "stats": reference_stats,
    "metrics": {
        metric: summarize({arm: [sample["totals"][metric] for sample in samples] for arm, samples in observations.items()})
        for metric in ["totalMs", "nativeMs", "cpuMs", "nativeCpuMs"]
    },
    "firstGroup": {
        metric: summarize({arm: [sample["measurements"][0][metric] for sample in samples] for arm, samples in observations.items()})
        for metric in ["totalMs", "nativeMs", "cpuMs", "nativeCpuMs"]
    },
    "laterGroups": {
        metric: summarize({arm: [sum(group[metric] for group in sample["measurements"][1:]) for sample in samples] for arm, samples in observations.items()})
        for metric in ["totalMs", "nativeMs", "cpuMs", "nativeCpuMs"]
    },
}
wall = summary["metrics"]["totalMs"]
cpu = summary["metrics"]["cpuMs"]
summary["followupGatePassed"] = (
    all(wall["ratioOfMediansPct"][pair] <= -5 for pair in ["AB", "CB"])
    and all(wall["candidateFasterPairs"][pair] >= 5 for pair in ["AB", "CB"])
    and abs(wall["ratioOfMediansPct"]["AC"]) <= 5
    and all(cpu["ratioOfMediansPct"][pair] <= 2 for pair in ["AB", "CB"])
)
save("summary.json", summary)
print(json.dumps({key: {"medians": value["medians"], "ratioOfMediansPct": value["ratioOfMediansPct"], "pairedMedianPct": value["pairedMedianPct"]} for key, value in summary["metrics"].items()}, indent=2))
