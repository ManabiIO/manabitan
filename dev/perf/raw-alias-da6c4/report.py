#!/usr/bin/env python3
"""Compact, always-run public job-log receipts; never infer missing results."""
from __future__ import annotations

import json
from pathlib import Path
import sys


def emit(label, value):
    print(label + " " + json.dumps(value, ensure_ascii=True), flush=True)


def load(filename):
    if not filename.exists():
        return None
    try:
        return json.loads(filename.read_bytes())
    except BaseException as error:
        emit("RAW_ALIAS_INVALID_JSON", {
            "file": str(filename), "error": str(error),
            "retainedTail": filename.read_bytes()[-6000:].decode("utf8", errors="replace"),
        })
        return None


def main():
    output = Path(sys.argv[1]).resolve()
    if not output.exists():
        emit("RAW_ALIAS_OUTPUT_UNAVAILABLE", {
            "path": str(output), "reason": "Setup did not create output; inspect preceding workflow-step logs.",
        })
        return
    setup = load(output / "setup.json")
    if setup is not None:
        keep = ["complete", "failure", "node", "researchBinding", "preAcquisitionBinding",
                "capture", "protocolSha256", "sourceManifestSha256", "runId", "runAttempt", "advance"]
        emit("RAW_ALIAS_SETUP_COMPACT", {key: setup.get(key) for key in keep})
        emit("RAW_ALIAS_PHASE_STATUS", [
            {key: phase.get(key) for key in ["label", "returnCode", "shellEquivalentExitCode", "failure", "logSha256",
                                           "startedUnixSeconds", "endedUnixSeconds"]}
            for phase in setup.get("phases", [])
        ])
    route = load(output / "new-route-receipt.json")
    if route is not None:
        emit("RAW_ALIAS_ROUTE_COMPACT", {
            "complete": route.get("complete"), "groups": len(route.get("groups", [])),
            "rows": route.get("rows"), "routeWitnessSha256": route.get("routeWitnessSha256"),
            "contentFiles": route.get("contentFiles"), "failures": route.get("failures"),
            "aliasCapture": route.get("aliasCapture"),
        })
    capture = load(output / "capture/manifest.json")
    if capture is not None:
        emit("RAW_ALIAS_CAPTURE_COMPACT", {
            "complete": capture.get("complete"), "groups": [group.get("index") for group in capture.get("groups", [])],
            "binaryBytes": capture.get("binaryBytes"), "seed": capture.get("seed"),
            "failures": capture.get("failures"),
        })
    for filename in sorted((output / "observations").glob("*/observation.json")):
        value = load(filename)
        if value is None:
            continue
        proof = value.get("verification") or {}
        emit("RAW_ALIAS_OBSERVATION_COMPACT", {
            "file": str(filename.relative_to(output)),
            **{key: value.get(key) for key in [
                "complete", "arm", "block", "ordinal", "elapsedNs", "elapsedMs",
                "processCpuDeltaMicroseconds", "maximumRssKiBAfterTiming",
                "inputWitnessBefore", "inputWitnessAfter", "postFinalizationQuiescence",
                "failures", "cleanupFailures", "workerFailures", "workerTransports",
            ]},
            "groupElapsedNs": [{key: group.get(key) for key in ["group", "elapsedNs", "promoted", "rawRows"]}
                               for group in value.get("groupDiagnostics", [])],
            "verification": {key: proof.get(key) for key in [
                "verifiedRows", "lookupProbes", "referencedCanonicalDefinitions", "logicalSha256",
                "normalizedPhysicalSha256", "descriptorBytes", "indexBytes", "lookupPayloadBytes",
                "affectedPayloadBytes", "addedContentBytes", "promotedGroups",
            ]},
            "recordFinalization": value.get("recordFinalization"),
            "contentFinalization": value.get("contentFinalization"),
            "ioScope": "These store counters and owner file-operation receipts are not a total cross-thread syscall census.",
        })
    analysis = load(output / "analysis.json")
    if analysis is not None:
        emit("RAW_ALIAS_ANALYSIS", analysis)
    if setup is not None:
        for phase in setup.get("phases", []):
            failed = phase.get("returnCode", 0) != 0 or phase.get("failure") is not None or "endedUnixSeconds" not in phase
            if not failed:
                continue
            filename = output / phase.get("log", str(phase.get("label")) + ".log")
            if filename.exists():
                lines = filename.read_bytes().decode("utf8", errors="replace").splitlines()
                emit("RAW_ALIAS_FAILED_PHASE_LOG_TAIL", {
                    "phase": phase.get("label"), "file": filename.name,
                    "tail": "\n".join(lines[-100:])[-12000:],
                })


if __name__ == "__main__":
    main()
