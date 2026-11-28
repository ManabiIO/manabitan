#!/usr/bin/env python3
"""A frozen, bounded import regression screen; not speed or memory qualification."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import zipfile


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, cwd, env=None):
    print("+", " ".join(map(str, command)), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def package_members(package):
    with zipfile.ZipFile(package) as archive:
        return {
            entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
            for entry in archive.infolist()
            if not entry.is_dir()
        }


def receipt(validation):
    return {
        "title": validation["title"],
        "revision": validation["revision"],
        "termRows": validation["termRows"],
        "probeTerms": validation["probeTerms"],
        "outputDigestSha256": validation["outputDigestSha256"],
        "media": {
            key: validation["media"][key]
            for key in ("mode", "totalFiles", "totalBytes", "files", "bytes", "sha256")
        },
        "lookup": sorted(
            [
                {key: row[key] for key in ("pass", "term", "results", "sha256")}
                for row in validation["lookup"]["observations"]
            ],
            key=lambda row: (row["pass"], row["term"]),
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"), required=True)
    parser.add_argument("--allowed-entry", action="append", required=True)
    parser.add_argument("--harness-overlay-ref")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    for ref in (args.baseline, args.candidate, *([args.harness_overlay_ref] if args.harness_overlay_ref else [])):
        if len(ref) != 40 or any(c not in "0123456789abcdef" for c in ref):
            raise ValueError("Product revisions must be complete commit SHAs")
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "schedule.json").exists():
        raise ValueError("Refusing to overwrite or reacquire an existing screen")
    schedule = ["A1", "B1", "B2", "A2"]
    write_json(output / "schedule.json", {
        "schedule": schedule,
        "baseline": args.baseline,
        "candidate": args.candidate,
        "dictionary": args.dictionary,
        "allowedPackageChanges": sorted(args.allowed_entry),
        "boundary": "file-input change to post-UI completion, browser monotonic clock",
        "scope": "Single-host ABBA regression screen; no speed or peak-memory qualification",
        "failurePolicy": "Stop on failure and retain all observations; no replacement runs",
        "scriptSha256": sha256(Path(__file__)),
        "harnessOverlayRef": args.harness_overlay_ref,
    })
    cache = root / "builds/e2e-dictionary-cache"
    run(["node", "dev/perf/prepare-dictionaries.js", "--all"], root)
    workdir = Path(tempfile.mkdtemp(prefix="import-allocation-9175-"))
    roots = {}
    member_hashes = {}
    package_hashes = {}
    shared_files = [
        "package-lock.json", "test/perf/dictionaries.lock.json",
        "dev/perf/import-benchmark.js", "dev/perf/benchmark-support.js",
        "dev/perf/dictionary-fixtures.js", "test/e2e/import-timing.js",
        "test/chromium/extension-two-dictionary-import.e2e.js",
    ]
    for label, ref in (("A", args.baseline), ("B", args.candidate)):
        source = workdir / label
        run(["git", "worktree", "add", "--detach", str(source), ref], root)
        roots[label] = source
        for relative in shared_files:
            if sha256(source / relative) != sha256(root / relative):
                raise ValueError(f"Shared harness/lock mismatch: {label} {relative}")
        (source / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
        (source / "builds").mkdir(exist_ok=True)
        (source / "builds/e2e-dictionary-cache").symlink_to(cache, target_is_directory=True)
        run(["npm", "run", "build:libs"], source)
        run(["npm", "run", "build", "--", "--target", "chrome"], source)
        package = source / "builds/manabitan-chrome.zip"
        package_hashes[label] = sha256(package)
        member_hashes[label] = package_members(package)
        shutil.copy2(package, output / f"{label}-manabitan-chrome.zip")
        write_json(output / f"{label}-package-members.json", member_hashes[label])
        write_json(output / f"{label}-shared-source.json", {
            relative: sha256(source / relative) for relative in shared_files
        })
    changed = sorted(
        name for name in member_hashes["A"].keys() | member_hashes["B"].keys()
        if member_hashes["A"].get(name) != member_hashes["B"].get(name)
    )
    write_json(output / "package-comparison.json", {
        "sha256": package_hashes, "changedEntries": changed,
    })
    if changed != sorted(args.allowed_entry):
        raise ValueError(f"Unexpected shipped changes: {changed}")
    overlay_hash = None
    if args.harness_overlay_ref:
        relative = "dev/perf/benchmark-support.js"
        original = (roots["A"] / relative).read_bytes()
        overlay = subprocess.check_output([
            "git", "show", f"{args.harness_overlay_ref}:{relative}",
        ], cwd=root)
        overlay_hash = hashlib.sha256(overlay).hexdigest()
        (output / "original-benchmark-support.js").write_bytes(original)
        (output / "corrected-benchmark-support.js").write_bytes(overlay)
        write_json(output / "harness-overlay.json", {
            "ref": args.harness_overlay_ref, "path": relative,
            "originalSha256": hashlib.sha256(original).hexdigest(),
            "overlaySha256": overlay_hash,
            "scope": "Identical measurement-only overlay after unchanged product packages are built",
        })
        for label, source in roots.items():
            (source / relative).write_bytes(overlay)
            status = subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True)
            (output / f"{label}-status-with-harness-overlay.txt").write_text(status)
    observations = []
    expected_receipt = None
    expected_browser = None
    for observation in schedule:
        label = observation[0]
        destination = output / observation
        run([
            "node", "dev/perf/import-benchmark.js", args.dictionary,
            "--runs", "1", "--no-build", "--build-target", "chrome",
            "--media-check", "all", "--output", str(destination),
        ], roots[label])
        summary = json.loads((destination / "summary.json").read_text())
        sample = summary["runs"][0]
        if summary["hostEnvironment"]["nodeVersion"] != "v22.22.0":
            raise ValueError("Unexpected Node version")
        browser = sample["browserVersion"]
        if not isinstance(browser, str) or not browser:
            raise ValueError("Missing browser identity")
        if expected_browser is None:
            expected_browser = browser
        elif browser != expected_browser:
            raise ValueError("Browser changed during screen")
        if summary["gitSha"] != (args.baseline if label == "A" else args.candidate):
            raise ValueError("Source SHA changed during screen")
        if sample["packageSha256"] != package_hashes[label]:
            raise ValueError("Package changed during screen")
        if overlay_hash and summary["source"]["sha256"]["dev/perf/benchmark-support.js"] != overlay_hash:
            raise ValueError("Measurement overlay changed during screen")
        current_receipt = receipt(sample["validation"])
        write_json(destination / "semantic-receipt.json", current_receipt)
        if expected_receipt is None:
            expected_receipt = current_receipt
        elif current_receipt != expected_receipt:
            raise ValueError(f"Cross-arm content or media mismatch: {observation}")
        observations.append({
            "id": observation,
            "totalImportMs": sample["totalImportMs"],
            "workerImportMs": sample["workerImportMs"],
            "browserVersion": sample["browserVersion"],
            "storage": sample["validation"]["storage"],
        })
        write_json(output / "observations.json", observations)
    values = {row["id"]: row["totalImportMs"] for row in observations}
    deltas = [(values[f"B{n}"] / values[f"A{n}"] - 1) * 100 for n in (1, 2)]
    write_json(output / "result.json", {
        "complete": True,
        "matchedSemanticReceipts": len(observations),
        "pairedChangePercent": deltas,
        "medianPairedChangePercent": statistics.median(deltas),
        "scope": "Four-import screen only; no established whole-import speedup or peak-memory reduction",
        "observations": observations,
    })
    component = roots["B"] / "test/perf/lazy-media-deferral-20261126/screen.mjs"
    if args.dictionary == "vndb" and component.exists():
        with (output / "catalog-component.json").open("w") as report:
            subprocess.run([
                "node", str(component), str(cache / "vndb_characters_by_bee.zip"),
            ], cwd=roots["B"], check=True, stdout=report)


if __name__ == "__main__":
    main()
