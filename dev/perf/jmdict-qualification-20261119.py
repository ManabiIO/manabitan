#!/usr/bin/env python3
"""Research-only orchestration; production and measurement code stay unchanged."""

import hashlib
import json
import math
import os
from pathlib import Path
import signal
import statistics
import subprocess
import sys
import zipfile


def plan():
    observations = [
        {"id": "warmup-A", "kind": "warmup", "arm": "A"},
        {"id": "warmup-B", "kind": "warmup", "arm": "B"},
        {"id": "control-pre-A1", "kind": "control-pre", "arm": "A"},
        {"id": "control-pre-A2", "kind": "control-pre", "arm": "A"},
    ]
    for pair in range(1, 7):
        for arm in ("AB" if pair % 2 else "BA"):
            observations.append({"id": f"pair-{pair:02d}-{arm}", "kind": "measured", "pair": pair, "arm": arm})
    observations.extend([
        {"id": "control-post-B1", "kind": "control-post", "arm": "B"},
        {"id": "control-post-B2", "kind": "control-post", "arm": "B"},
    ])
    return observations


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def write_json(file, value):
    file = Path(file)
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(file)


def output(args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def source_identity(root):
    package = root / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(package) as archive:
        entries = {entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
                   for entry in archive.infolist() if not entry.is_dir()}
    flags = output(["node", "--input-type=module", "-e",
                    "import {snapshotTermBankExperiments} from './ext/js/dictionary/term-bank-experiments.js'\n"
                    "console.log(JSON.stringify(snapshotTermBankExperiments()))"], root)
    return {
        "gitSha": output(["git", "rev-parse", "HEAD"], root),
        "gitTree": output(["git", "rev-parse", "HEAD^{tree}"], root),
        "gitStatus": output(["git", "status", "--porcelain"], root),
        "packageSha256": digest(package),
        "packageEntries": entries,
        "defaultWorkerFlags": json.loads(flags),
    }


def prepare(roots, evidence, dictionary):
    shared = ["package.json", "package-lock.json", "test/perf/dictionaries.lock.json",
              "test/chromium/extension-two-dictionary-import.e2e.js",
              "dev/perf/import-benchmark.js", "dev/perf/benchmark-support.js",
              "dev/perf/dictionary-fixtures.js", "dev/perf/host-environment.js"]
    shared.extend(str(file.relative_to(roots["B"])) for file in sorted((roots["B"] / "test/e2e").glob("*.js")))
    hashes = {}
    for name in shared:
        hashes[name] = {arm: digest(root / name) for arm, root in roots.items()}
        if hashes[name]["A"] != hashes[name]["B"]:
            raise ValueError(f"Shared harness/dependency/fixture changed: {name}")
    identities = {arm: source_identity(root) for arm, root in roots.items()}
    if identities["A"]["gitSha"] != os.environ["PERF_BASELINE_SHA"]:
        raise ValueError("Wrong baseline source")
    if identities["A"]["defaultWorkerFlags"] != identities["B"]["defaultWorkerFlags"]:
        raise ValueError("This experiment must preserve production worker defaults")
    lock = json.loads((roots["B"] / "test/perf/dictionaries.lock.json").read_text())
    entries_a, entries_b = (identities[arm]["packageEntries"] for arm in "AB")
    changed = [name for name in sorted(entries_a.keys() | entries_b.keys()) if entries_a.get(name) != entries_b.get(name)]
    manifest = {
        "schemaVersion": 1, "dictionary": dictionary, "fixture": lock["dictionaries"][dictionary],
        "sources": identities, "sharedInputs": hashes, "changedPackageEntries": changed,
        "sameProductControl": not changed, "plan": plan(),
        "runnerSha256": digest(__file__),
        "workflowSha256": digest(roots["B"] / ".github/workflows/jmdict-qualification-20261119.yml"),
        "timingBoundary": "browser file-input change to post-UI completion; fresh profiles; no trace during timing",
        "limitations": "Six pairs on one Ubuntu host; sampled content equality, not exhaustive stored-row equality or memory qualification.",
    }
    write_json(evidence / "manifest.json", manifest)
    (evidence / "candidate.patch").write_text(output(["git", "diff", "--binary", identities["A"]["gitSha"], identities["B"]["gitSha"]], roots["B"]) + "\n")


def execute(args, root, log):
    with log.open("w") as stream:
        process = subprocess.Popen(args, cwd=root, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=660)
        except BaseException:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
    if status:
        raise RuntimeError(f"Observation exited {status}; retained log: {log}")


def validate_summary(summary, source, manifest, trace):
    if (summary.get("schemaVersion") != 3 or summary.get("dictionary") != manifest["dictionary"] or
            summary.get("buildTarget") != "chrome" or summary.get("traceEnabled") is not trace or
            summary.get("authoritativeTiming") is not (not trace) or summary.get("importFlags") is not None or
            summary.get("fixture") != manifest["fixture"] or summary.get("gitSha") != source["gitSha"]):
        raise ValueError("Wrong observation configuration/source")
    runs = summary.get("runs", [])
    if len(runs) != 1:
        raise ValueError("Expected exactly one fresh-profile observation")
    run = runs[0]
    if run.get("packageSha256") != source["packageSha256"]:
        raise ValueError("Measured package differs from the prepared package")
    milliseconds = run.get("totalImportMs")
    if not isinstance(milliseconds, (float, int)) or isinstance(milliseconds, bool) or not math.isfinite(milliseconds) or milliseconds <= 0:
        raise ValueError("Invalid browser timing")
    validation = run.get("validation", {})
    fixture = manifest["fixture"]
    expected = {"title": fixture["expectedTitle"], "revision": fixture["revision"], "termRows": fixture["termRows"],
                "contentReadable": True, "probeCount": 12}
    for phase in (validation, validation.get("restart", {})):
        if any(phase.get(key) != value for key, value in expected.items()):
            raise ValueError("Missing or invalid complete/restarted content validation")
    output_digest = validation.get("outputDigestSha256", "")
    if len(output_digest) != 64 or any(char not in "0123456789abcdef" for char in output_digest):
        raise ValueError("Missing persisted output digest")
    receipts = []
    for phase in run.get("importDebug", {}).get("importerPhaseTimings", []):
        details = phase.get("details") or {}
        for key in ("parserExperiments", "fastPathParserEffectiveExperiments"):
            if key in details:
                receipt = details[key]
                if receipt != source["defaultWorkerFlags"]:
                    raise ValueError(f"Effective worker flags mismatch: {key}")
                receipts.append({"phase": phase.get("phase"), "key": key, "flags": receipt})
    if not receipts:
        raise ValueError("No effective parser-worker receipts")
    return {"totalImportMs": milliseconds, "workerImportMs": run.get("workerImportMs"),
            "browserVersion": summary.get("browserVersion"), "outputDigestSha256": output_digest,
            "validation": validation, "effectiveWorkerReceipts": receipts,
            "packageSha256": run["packageSha256"], "authoritativeTiming": not trace}


def observe(spec, roots, evidence, manifest, trace=False):
    root = roots[spec["arm"]]
    directory = evidence / spec["id"]
    directory.mkdir()
    host = ["node", "dev/perf/host-environment.js"]
    (directory / "host-before.json").write_text(output(host, root) + "\n")
    source = manifest["sources"][spec["arm"]]
    if digest(root / "builds/manabitan-chrome.zip") != source["packageSha256"]:
        raise ValueError("Built package changed during the cohort")
    command = ["node", "dev/perf/import-benchmark.js", manifest["dictionary"], "--runs", "1",
               "--no-build", "--build-target", "chrome", "--output", str(directory)]
    if trace:
        command.append("--trace")
    write_json(directory / "command.json", {"cwd": str(root), "argv": command})
    print(f"Starting {spec['id']}", flush=True)
    try:
        execute(command, root, directory / "run.log")
        summary = json.loads((directory / "summary.json").read_text())
        result = validate_summary(summary, source, manifest, trace)
        result["reportSha256"] = digest(directory / "run-1.json")
        result["summarySha256"] = digest(directory / "summary.json")
        if trace:
            result["traceSha256"] = digest(directory / "run-1.trace.json")
        print(f"Completed {spec['id']}: {result['totalImportMs']:.2f} ms (timing authoritative={not trace})", flush=True)
        return {**spec, "result": result}
    finally:
        (directory / "host-after.json").write_text(output(host, root) + "\n")


def change(a, b):
    return (b / a - 1) * 100


def summarize(observations):
    if [item["id"] for item in observations] != [item["id"] for item in plan()]:
        raise ValueError("Incomplete or reordered cohort; no performance estimate")
    for key in ("browserVersion", "outputDigestSha256"):
        if len({item["result"][key] for item in observations}) != 1:
            raise ValueError(f"Cross-observation {key} mismatch; no performance estimate")
    pairs = []
    for pair in range(1, 7):
        arms = {item["arm"]: item["result"]["totalImportMs"] for item in observations if item.get("pair") == pair}
        pairs.append({"pair": pair, "baselineMs": arms["A"], "candidateMs": arms["B"], "changePercent": change(arms["A"], arms["B"])})
    controls = {}
    for kind in ("control-pre", "control-post"):
        times = [item["result"]["totalImportMs"] for item in observations if item["kind"] == kind]
        controls[kind] = {"firstMs": times[0], "secondMs": times[1], "changePercent": change(*times)}
    return {"pairs": pairs, "sameCodeControls": controls,
            "medianPairedChangePercent": statistics.median(item["changePercent"] for item in pairs),
            "equalWorkTotalChangePercent": change(sum(item["baselineMs"] for item in pairs), sum(item["candidateMs"] for item in pairs)),
            "fasterPairs": sum(item["changePercent"] < 0 for item in pairs),
            "interpretation": "Screening evidence only; preserve controls and all tails. No cross-device or total-memory claim."}


def main():
    action = sys.argv[1]
    if action == "plan":
        print(json.dumps(plan(), indent=2))
        return
    roots = {"A": Path(os.environ["PERF_BASELINE_ROOT"]), "B": Path(os.environ["PERF_CANDIDATE_ROOT"])}
    evidence = Path(os.environ["PERF_EVIDENCE_ROOT"])
    dictionary = os.environ["PERF_DICTIONARY"]
    if action == "prepare":
        prepare(roots, evidence, dictionary)
        return
    if action not in ("run", "trace"):
        raise ValueError("Choose plan, prepare, run or trace")
    manifest = json.loads((evidence / "manifest.json").read_text())
    state = {"complete": False, "observations": []}
    destination = evidence / ("diagnostics.json" if action == "trace" else "results.json")
    write_json(destination, state)
    schedule = [{"id": f"trace-{arm}", "kind": "trace", "arm": arm} for arm in "AB"] if action == "trace" else plan()
    try:
        for spec in schedule:
            try:
                state["observations"].append(observe(spec, roots, evidence, manifest, action == "trace"))
            except Exception as error:
                state["observations"].append({**spec, "error": str(error)})
                write_json(destination, state)
                if action != "trace":
                    raise
            write_json(destination, state)
        if any("error" in item for item in state["observations"]):
            raise ValueError("Diagnostic failure; inspect retained observations")
        if action == "run":
            state["summary"] = summarize(state["observations"])
        state["complete"] = True
    except Exception as error:
        state["error"] = str(error)
        raise
    finally:
        write_json(destination, state)


if __name__ == "__main__":
    main()
