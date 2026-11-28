#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Screen one exact parser inlining change with the unchanged full qualifier.

No flags, observation retries, measurement overlays, or acceptance policies are
added here. The shared qualifier owns timing, controls, exhaustive media checks,
separate memory observations, semantic checks, and the stop-on-failure policy.
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parents[2]
BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
PRODUCT_FILES = (
    "ext/js/dictionary/wasm/term-bank-parser.c",
    "dev/data/dictionary-wasm/manifest.json",
    "dev/data/dictionary-wasm/term-bank-parser.wasm",
)
TOOLING_FILES = (
    ".github/workflows/parser-inline-screen-5a86.yml",
    "dev/perf/parser-inline-screen-5a86.py",
)
PACKAGE_ENTRIES = (
    "js/dictionary/wasm/term-bank-parser.c",
    "lib/term-bank-parser.wasm",
)
PARSER_HASHES = {
    "A": "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee",
    "B": "1cb15eda380145fe66c98e2b8397d1146552fc520dfdb600f22a0e478d7f6245",
}
FROZEN_HASHES = {
    "dev/perf/import-qualification-20261125-a7f7.py": "cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef",
    "dev/perf/import-memory-20261125-a7f7/qualification_receipts.py": "4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51",
    "dev/perf/benchmark-support.js": "eacc5eeee1aaeb13ea44867f0d2ff168f5e723392652ebfee6dfc717ba3865d0",
    "test/chromium/extension-two-dictionary-import.e2e.js": "d0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf",
    "test/perf/dictionaries.lock.json": "60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89",
    "package-lock.json": "01e065503317a90b43a5bc60cd9f874238762c75a13c8115a9c484a626960a96",
}


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def emit(label, value):
    print(label + " " + json.dumps(value, sort_keys=True, separators=(",", ":")), flush=True)


def source_check(candidate):
    if re.fullmatch(r"[a-f0-9]{40}", candidate or "") is None or candidate == BASELINE:
        raise ValueError("Candidate must be a distinct exact commit SHA")
    if git("rev-parse", "HEAD").decode().strip() != candidate:
        raise ValueError("Checkout differs from the frozen candidate")
    changed = set(git("diff", "--name-only", BASELINE, candidate).decode().splitlines())
    if changed != set(PRODUCT_FILES + TOOLING_FILES):
        raise ValueError(f"Unexpected source delta: {sorted(changed)}")
    before = git("show", f"{BASELINE}:{PRODUCT_FILES[0]}")
    after = (ROOT / PRODUCT_FILES[0]).read_bytes()
    old = b"static inline int next_format3_field("
    new = b"static __attribute__((always_inline)) inline int next_format3_field("
    if before.count(old) != 1 or after != before.replace(old, new):
        raise ValueError("Native source differs from the one-line inlining experiment")
    modules = {"A": git("show", f"{BASELINE}:{PRODUCT_FILES[2]}"),
               "B": (ROOT / PRODUCT_FILES[2]).read_bytes()}
    for arm, data in modules.items():
        if sha256(data) != PARSER_HASHES[arm]:
            raise ValueError(f"Unexpected parser module for arm {arm}")
    for relative, expected in FROZEN_HASHES.items():
        current = (ROOT / relative).read_bytes()
        if sha256(current) != expected or current != git("show", f"{BASELINE}:{relative}"):
            raise ValueError(f"Shared runner, harness or fixture differs: {relative}")
    identity = {
        "baseline": BASELINE, "candidate": candidate,
        "candidateTree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "changedPaths": sorted(changed), "packageEntries": PACKAGE_ENTRIES,
        "parserModules": {arm: {"sha256": sha256(data), "bytes": len(data)}
                          for arm, data in modules.items()},
        "productHashes": {path: sha256((ROOT / path).read_bytes()) for path in PRODUCT_FILES},
        "frozenHashes": FROZEN_HASHES,
        "fixture": json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())["dictionaries"]["jmdict"],
    }
    emit("SOURCE_IDENTITY", identity)
    return identity


def read_json(path):
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        return {"readError": str(error), "path": str(path)}


def summarize(evidence):
    driver = evidence.with_name(evidence.name + "-driver")
    for label, path in (
        ("INVOCATION", driver / "invocation.json"),
        ("BROWSER", evidence / "browser-identity.json"),
        ("REGISTERED_PLAN", evidence / "registered-plan.json"),
        ("RAW_TIMING_OBSERVATIONS", evidence / "observations.json"),
        ("FINAL_ANALYSIS", evidence / "analysis.json"),
        ("MEMORY_COMPARISON", evidence / "memory/memory-comparison.json"),
        ("MEMORY_AUDIT", evidence / "memory/memory-audit.json"),
        ("MEMORY_AUDIT_FAILURE", evidence / "memory/memory-audit-failure.json"),
        ("MEMORY_SEMANTIC_FAILURES", evidence / "memory/semantic-failures.json"),
    ):
        value = read_json(path)
        if label == "MEMORY_COMPARISON" and isinstance(value, dict) and "observations" in value:
            observation_keys = (
                "name", "arm", "pair", "qualifiedForWholeTreePss", "qualificationFailures",
                "maxSampledPssKiB", "maxSampledPrivateKiB", "stableFullyReadImportSampleCount",
                "maximumCoveredSampleGapMs", "preImportBracketGapMs", "postImportBracketGapMs",
            )
            value = {**value, "observations": [
                {key: item.get(key) for key in observation_keys} for item in value["observations"]
            ]}
        emit(label, value)
    identities = read_json(evidence / "source-identities.json")
    if isinstance(identities, dict) and "arms" in identities:
        identities = {
            "changedPackageEntries": identities.get("changedPackageEntries"),
            "controlC": identities.get("controlC"),
            "arms": {arm: {key: value for key, value in identity.items() if key != "entries"}
                     for arm, identity in identities["arms"].items()},
            "parserPackageHashes": {arm: identity["entries"].get("lib/term-bank-parser.wasm")
                                    for arm, identity in identities["arms"].items()},
        }
    emit("BUILT_SOURCE_IDENTITIES", identities)
    receipt_paths = sorted(evidence.glob("*/canonical-receipt.json"))
    emit("SEMANTIC_RECEIPTS", {
        "timingAndMediaCount": len(receipt_paths),
        "memoryCount": len(list(evidence.glob("memory/*/canonical-receipt.json"))),
        "exhaustiveMedia": {path.parent.name: read_json(path).get("media")
                            for path in receipt_paths if path.parent.name.startswith("exhaustive-media-")},
        "note": "No timing estimate is constructed here if the qualifier did not produce analysis.json.",
    })
    policies = []
    for path in sorted(evidence.glob("*/summary.json")):
        summary = read_json(path)
        if isinstance(summary, dict):
            for observation in summary.get("runs", []):
                policies.append({"id": path.parent.name,
                                 "parserPolicy": observation.get("step4Breakdown", {}).get("dictionaries")})
    emit("OBSERVED_PARSER_POLICY", policies)
    log = driver / "qualification.log"
    if log.is_file():
        with log.open("rb") as source:
            source.seek(max(0, log.stat().st_size - 8192))
            print("QUALIFICATION_LOG_TAIL\n" + source.read().decode(errors="replace"), flush=True)


def run(candidate, order, evidence):
    driver = evidence.with_name(evidence.name + "-driver")
    driver.mkdir(parents=True, exist_ok=False)
    receipt = {"baseline": BASELINE, "candidate": candidate, "dictionary": "jmdict",
               "order": order, "pairs": 6, "flags": {}, "retries": 0, "status": "preflight"}

    def save():
        (driver / "invocation.json").write_text(json.dumps(receipt, indent=2) + "\n")

    save()
    try:
        receipt["sourceIdentity"] = source_check(candidate)
        command = [sys.executable, "dev/perf/import-qualification-20261125-a7f7.py",
                   "--baseline", BASELINE, "--candidate", candidate, "--dictionary", "jmdict",
                   "--initial-order", order, "--pairs", "6", "--evidence", str(evidence)]
        for entry in PACKAGE_ENTRIES:
            command.extend(("--expected-package-entry", entry))
        receipt.update({"command": command, "status": "running", "startedUnixSeconds": time.time()})
        save()
        with (driver / "qualification.log").open("wb") as log:
            completed = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        receipt.update({"exitCode": completed.returncode, "endedUnixSeconds": time.time(),
                        "status": "complete" if completed.returncode == 0 else "failed"})
        save()
        return completed.returncode
    except BaseException as error:
        receipt.update({"status": "failed", "error": {"type": type(error).__name__, "message": str(error)}})
        save()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "run", "summary"))
    parser.add_argument("--candidate")
    parser.add_argument("--order", choices=("AB", "BA"))
    parser.add_argument("--evidence", type=pathlib.Path)
    args = parser.parse_args()
    if args.mode != "summary" and not args.candidate:
        parser.error("check and run require --candidate")
    if args.mode in ("run", "summary") and args.evidence is None:
        parser.error("run and summary require --evidence")
    if args.mode == "run" and args.order is None:
        parser.error("run requires --order")
    if args.mode == "check":
        source_check(args.candidate)
        return 0
    if args.mode == "summary":
        summarize(args.evidence.resolve())
        return 0
    return run(args.candidate, args.order, args.evidence.resolve())


if __name__ == "__main__":
    sys.exit(main())
