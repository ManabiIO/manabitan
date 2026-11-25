# SPDX-License-Identifier: GPL-3.0-or-later
"""Fixed, temporary complete-import screen; no product defaults are changed."""

import hashlib
import json
import os
import pathlib
import statistics
import subprocess
import tempfile
import time
import zipfile


BASELINE = "7d1643e6147a10cb2165e9744cf0e63b59e46632"
ORDERS = ("ABC", "CBA", "BCA", "ACB", "BAC", "CAB")
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "builds/perf/import-screen-5ccd"
DICTIONARY = os.environ["PERF_DICTIONARY"]
if DICTIONARY not in {"jmdict", "jitendex", "vndb"}:
    raise ValueError("Unsupported dictionary")
OUTPUT.mkdir(parents=True, exist_ok=False)


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def command(args, cwd=ROOT, env=None, log=None, timeout=1200):
    if log is None:
        return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()
    started = time.time()
    result = {"argv": args, "cwd": str(cwd), "started": started}
    try:
        with log.open("w") as stream:
            process = subprocess.run(args, cwd=cwd, env=env, stdout=stream,
                                     stderr=subprocess.STDOUT, timeout=timeout)
        result["returncode"] = process.returncode
        if process.returncode != 0:
            raise RuntimeError(f"Command failed ({process.returncode}): {log}")
    except Exception as error:
        result["error"] = repr(error)
        raise
    finally:
        result["finished"] = time.time()
        save(log.with_suffix(".receipt.json"), result)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


work = pathlib.Path(tempfile.mkdtemp(prefix="import-screen-5ccd-"))
baseline = work / "baseline"
manifest = {
    "baseline": BASELINE,
    "candidate": command(["git", "rev-parse", "HEAD"]),
    "candidateTree": command(["git", "rev-parse", "HEAD^{tree}"]),
    "dictionary": DICTIONARY,
    "arms": {"A": "baseline", "B": "candidate", "C": "identical baseline"},
    "warmups": "ABC",
    "measuredOrders": ORDERS,
    "timingBoundary": "page file-input change to post-UI import completion",
    "timingMediaCheck": "sample",
    "diagnosticMediaCheck": "all",
    "node": command(["node", "--version"]),
    "lockSha256": digest(ROOT / "test/perf/dictionaries.lock.json"),
    "sourceChanges": command(["git", "diff", "--stat", BASELINE, "HEAD"]),
}
save(OUTPUT / "manifest.json", manifest)
command(["git", "worktree", "add", "--detach", str(baseline), BASELINE],
        log=OUTPUT / "baseline-checkout.log")
for name in ("package-lock.json", "test/perf/dictionaries.lock.json"):
    if digest(ROOT / name) != digest(baseline / name):
        raise RuntimeError(f"Baseline/candidate inputs differ: {name}")

fixture_program = (
    "import {ensureSelectedPinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js';"
    "await ensureSelectedPinnedDictionaryCache('./builds/e2e-dictionary-cache',[process.argv[1]])"
)
command(["node", "--input-type=module", "-e", fixture_program, DICTIONARY],
        log=OUTPUT / "fixtures.log")
(baseline / "builds").mkdir(exist_ok=True)
(baseline / "builds/e2e-dictionary-cache").symlink_to(ROOT / "builds/e2e-dictionary-cache", target_is_directory=True)
command(["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"],
        cwd=baseline, log=OUTPUT / "baseline-install.log")
command(["npm", "run", "build:libs"], cwd=baseline,
        log=OUTPUT / "baseline-libs.log")
command(["npm", "run", "license-report:html"], cwd=baseline,
        log=OUTPUT / "baseline-license.log")
packages = {}
for label, checkout in (("baseline", baseline), ("candidate", ROOT)):
    command(["node", "dev/bin/build.js", "--target", "chrome"], cwd=checkout,
            log=OUTPUT / f"{label}-build.log")
    package = checkout / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(package) as archive:
        entries = {entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
                   for entry in archive.infolist() if not entry.is_dir()}
    packages[label] = {"sha256": digest(package), "entries": entries}
    save(OUTPUT / f"{label}-package.json", packages[label])

entry_names = set(packages["baseline"]["entries"]) | set(packages["candidate"]["entries"])
changed_entries = sorted(name for name in entry_names
                         if packages["baseline"]["entries"].get(name) != packages["candidate"]["entries"].get(name))
expected_changes = {
    "js/dictionary/dictionary-generation-media-store.js",
    "js/dictionary/dictionary-importer.js",
    "js/dictionary/term-bank-wasm-parser.js",
    "js/dictionary/wasm/term-bank-parser.c",
    "lib/term-bank-parser.wasm",
}
save(OUTPUT / "package-changes.json", {"actual": changed_entries, "expected": sorted(expected_changes)})
if set(changed_entries) != expected_changes:
    raise RuntimeError("Packaged source changes differ from the five reviewed implementation files")

environment = dict(os.environ)
environment.update({
    "MANABITAN_E2E_STRICT_RUNTIME": "1",
    "MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK": "0",
})
observations = []
semantic_references = {}


def observe(arm, block, warmup=False, media="sample"):
    checkout = ROOT if arm == "B" else baseline
    label = f"{'warmup' if warmup else 'block'}-{block}-{arm}"
    if media == "all":
        label = f"diagnostic-{arm}"
    folder = OUTPUT / label
    folder.mkdir()
    env = dict(environment)
    command(["node", str(ROOT / "dev/perf/host-environment.js")], cwd=checkout,
            env=env, log=folder / "host-before.json")
    command(["node", "dev/perf/import-benchmark.js", DICTIONARY, "--runs", "1",
             "--no-build", "--build-target", "chrome", "--media-check", media,
             "--output", str(folder / "import")], cwd=checkout, env=env,
            log=folder / "import.log", timeout=1800 if DICTIONARY == "vndb" else 600)
    summary = json.loads((folder / "import/summary.json").read_text())
    source_label = "candidate" if arm == "B" else "baseline"
    expected_sha = manifest["candidate"] if arm == "B" else BASELINE
    if summary["gitSha"] != expected_sha or summary["source"]["gitSha"] != expected_sha:
        raise RuntimeError(f"Unexpected source revision in {label}")
    if summary["runs"][0]["packageSha256"] != packages[source_label]["sha256"]:
        raise RuntimeError(f"Unexpected package identity in {label}")
    if observations and summary["browserVersion"] != observations[0]["browserVersion"]:
        raise RuntimeError(f"Browser version changed in {label}")
    validation = summary["runs"][0]["validation"]
    lookup_receipt = sorted(
        ({key: item[key] for key in ("pass", "term", "sha256", "results", "originalTextLength", "hasExactHeadwordMatch")}
         for item in validation["lookup"]["observations"]),
        key=lambda item: (item["pass"], item["term"]),
    )
    media_receipt = {key: validation["media"][key]
                     for key in ("mode", "totalFiles", "totalBytes", "files", "bytes", "sha256")}
    receipt = {"lookup": lookup_receipt, "media": media_receipt}
    save(folder / "semantic-receipt.json", receipt)
    if semantic_references.setdefault("lookup", lookup_receipt) != lookup_receipt:
        raise RuntimeError(f"Public lookup responses differ in {label}")
    if semantic_references.setdefault(f"media-{media}", media_receipt) != media_receipt:
        raise RuntimeError(f"Persisted media responses differ in {label}")
    row = {"arm": arm, "block": block, "warmup": warmup,
           "diagnostic": media == "all", "path": str(folder.relative_to(OUTPUT)),
           "totalImportMs": summary["timing"]["medianMs"],
           "source": summary["source"], "browserVersion": summary["browserVersion"],
           "packageSha256": summary["runs"][0]["packageSha256"]}
    observations.append(row)
    save(OUTPUT / "observations.json", observations)
    print(json.dumps({key: row[key] for key in ("arm", "block", "warmup", "totalImportMs")} ), flush=True)


for arm in "ABC":
    observe(arm, 0, warmup=True)
for block, order in enumerate(ORDERS, 1):
    for arm in order:
        observe(arm, block)

measured = [row for row in observations if not row["warmup"] and not row["diagnostic"]]
comparisons = {}
for numerator, denominator in (("B", "A"), ("B", "C"), ("C", "A")):
    pairs = []
    for block in range(1, len(ORDERS) + 1):
        times = {row["arm"]: row["totalImportMs"] for row in measured if row["block"] == block}
        pairs.append({"block": block, "numeratorMs": times[numerator],
                      "denominatorMs": times[denominator],
                      "changePercent": 100 * (times[numerator] / times[denominator] - 1)})
    comparisons[f"{numerator}/{denominator}"] = {
        "pairs": pairs,
        "medianPairedPercent": statistics.median(pair["changePercent"] for pair in pairs),
        "equalWorkPercent": 100 * (sum(pair["numeratorMs"] for pair in pairs) /
                                    sum(pair["denominatorMs"] for pair in pairs) - 1),
        "fasterPairs": sum(pair["changePercent"] < 0 for pair in pairs),
    }
save(OUTPUT / "comparison.json", {"comparisons": comparisons, "manifest": manifest})
observe("B", 0, media="all")
save(OUTPUT / "completed.json", {"status": "success", "observations": len(observations),
                                "measured": len(measured), "diagnostics": 1,
                                "semanticsEqual": True})
