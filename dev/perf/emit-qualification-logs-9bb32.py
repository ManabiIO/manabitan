#!/usr/bin/env python3
"""Read-only compact log projection; retain complete source files as artifacts.

Run as an always() post-step after the frozen qualification command. This script
never edits evidence, removes observations, retries a run, or changes pass/fail.
Each single-line record starts QUALIFICATION_JSON so connector callers can parse
the complete structuredContent.content job log without printing unrelated logs.
"""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()


def emit(kind, **values):
    print("QUALIFICATION_JSON " + json.dumps({"kind": kind, **values}, sort_keys=True, separators=(",", ":")), flush=True)


def load(relative, required=False):
    path = root / relative
    if not path.is_file():
        emit("missing", path=relative, required=required)
        return None
    data = path.read_bytes()
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as error:
        emit("invalid-json", path=relative, error=str(error), sha256=hashlib.sha256(data).hexdigest())
        return None
    return value, hashlib.sha256(data).hexdigest()


emit("evidence-root", path=str(root), projectionOnly=True)
for relative in ("registered-plan.json", "browser-identity.json", "analysis.json", "memory/plan.json", "memory/memory-comparison.json", "memory/memory-audit.json", "memory/memory-audit-failure.json", "memory/semantic-failures.json"):
    result = load(relative, required=relative in {"registered-plan.json", "analysis.json", "memory/memory-audit.json"})
    if result:
        value, digest = result
        if relative == "memory/plan.json":
            # The two source manifests are already bound in source-identities.
            value = {k: v for k, v in value.items() if k != "sourceHashes"}
        emit("document", path=relative, fileSha256=digest, value=value)

result = load("source-identities.json", required=True)
if result:
    identities, digest = result
    changed = identities.get("changedPackageEntries", [])
    arms = {
        arm: {**{k: v for k, v in item.items() if k != "entries"},
              "packageEntryCount": len(item.get("entries", {})),
              "changedEntryHashes": {path: item.get("entries", {}).get(path) for path in changed}}
        for arm, item in identities.get("arms", {}).items()
    }
    emit("source-identities", fileSha256=digest, changedPackageEntries=changed, arms=arms)

result = load("observations.json", required=True)
if result:
    observations, digest = result
    emit("observations", fileSha256=digest, observations=observations)

receipts = []
for path in sorted(root.rglob("canonical-receipt.json")):
    relative = str(path.relative_to(root))
    result = load(relative, required=True)
    if not result:
        continue
    value, digest = result
    common = json.dumps(value.get("common"), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    media = json.dumps(value.get("media"), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    receipts.append({"path": relative, "fileSha256": digest, "commonSha256": hashlib.sha256(common).hexdigest(), "mediaSha256": hashlib.sha256(media).hexdigest()})
    # Full first receipt includes all 72 lookup digests and exact normalized
    # storage inventory. Every receipt's equality remains inspectable below.
    if len(receipts) == 1:
        emit("reference-receipt", path=relative, value=value)
    if relative.startswith("exhaustive-media-"):
        emit("exhaustive-media", path=relative, media=value.get("media"))
emit("receipt-digests", receipts=receipts)

for path in sorted(root.rglob("summary.json")):
    result = load(str(path.relative_to(root)))
    if not result:
        continue
    value, digest = result
    runs = value.get("runs", [])
    if len(runs) != 1:
        emit("unexpected-summary-shape", path=str(path.relative_to(root)), runCount=len(runs))
        continue
    run = runs[0]
    breakdown = run.get("step4Breakdown") or {}
    dictionaries = breakdown.get("dictionaries", [])
    relative = str(path.relative_to(root))
    emit("import-summary", path=relative, fileSha256=digest,
         gitSha=value.get("gitSha"), sourceDirty=(value.get("source") or {}).get("dirty"),
         browserVersion=value.get("browserVersion"), packageSha256=run.get("packageSha256"),
         authoritativeTiming=value.get("authoritativeTiming"), totalImportMs=run.get("totalImportMs"),
         separatelyInstrumented=relative.startswith("memory/"),
         hostEnvironment=value.get("hostEnvironment"),
         importFlags=value.get("importFlags"), mediaCheck=value.get("mediaCheck"),
         importDebug=run.get("importDebug"),
         step4Dictionaries=dictionaries)

for path in sorted(root.rglob("sampling-failure.json")):
    relative = str(path.relative_to(root))
    result = load(relative)
    if result:
        emit("sampling-failure", path=relative, value=result[0])

if not (root / "analysis.json").is_file():
    logs = sorted(root.rglob("*.log"), key=lambda item: item.stat().st_mtime)
    for path in logs[-3:]:
        emit("incomplete-cohort-log-tail", path=str(path.relative_to(root)), lines=path.read_text(errors="replace").splitlines()[-35:])

emit("projection-complete", receiptCount=len(receipts))
