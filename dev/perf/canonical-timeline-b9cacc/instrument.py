#!/usr/bin/env python3
"""Apply guarded marks to exact develop 9e10; never run an import itself."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile

BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
SOURCES = {
    "ext/js/dictionary/term-bank-wasm-parser.js": "31854cfb3d20ba60b701ec31cf19de26bd55cc745cc4f998cb33f0554ec83cca",
    "ext/js/dictionary/dictionary-database.js": "75da1c10c8cefd238e17aaabb44fca71f39e2f4e412660420c1e675d9cc7b84b",
    "ext/js/dictionary/dictionary-importer.js": "a99e3cb99ad92383e4ec4d83b025b15add7b0552f14da3c777773cb6b8ae17bb",
    "ext/js/dictionary/term-record-opfs-store.js": "7325a63fa3d054a3c8b426c87880671ca57f5956dce842d9daef4acd4d617594",
    "dev/perf/import-benchmark.js": "aa4d887c2106369c7ec27b3548f2fce58be4dd2b85807435e2eb783b2400ccc6",
}
PRODUCT_PATHS = tuple(p for p in SOURCES if p.startswith("ext/"))
RUNTIME = "ext/js/dictionary/import-canonical-timeline-b9cacc.js"
BLOCK = re.compile(r"(?ms)^([ \t]*)// B9CACC_TIMELINE_BEGIN\n.*?^\1// B9CACC_TIMELINE_END\n")
SCOPE = "Diagnostic only: exact 9e10 plus standalone markers; no A/B timing or speedup claim."


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(root: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def replace_once(source: str, anchor: str, replacement: str) -> str:
    count = source.count(anchor)
    if count != 1:
        raise ValueError(f"Expected one source anchor, found {count}: {anchor[:160]!r}")
    return source.replace(anchor, replacement, 1)


def marker(statement: str, indent: str = "") -> str:
    if "\n" in statement or not statement.endswith(";"):
        raise ValueError("Markers must be one standalone statement")
    return f"{indent}// B9CACC_TIMELINE_BEGIN\n{indent}{statement}\n{indent}// B9CACC_TIMELINE_END\n"


def before(source: str, anchor: str, statement: str, indent: str = "") -> str:
    return replace_once(source, anchor, marker(statement, indent) + anchor)


def after(source: str, anchor: str, statement: str, indent: str = "") -> str:
    return replace_once(source, anchor, anchor + marker(statement, indent))


def add_import(source: str, names: str) -> str:
    first_import = source.index("\nimport ") + 1
    return source[:first_import] + marker(f"import {{{names}}} from './import-canonical-timeline-b9cacc.js';") + source[first_import:]


def instrument_source(path: str, source: str) -> str:
    original = source
    if sha256(original.encode()) != SOURCES[path]:
        raise ValueError(f"Unrecognized baseline source: {path}")
    if path.endswith("term-bank-wasm-parser.js"):
        source = add_import(source, "beginCanonicalTimeline, bindCanonicalTimelineGroup, markCanonicalTimeline")
        source = after(source, "    async _runPipeline(workers) {\n        this._createSlots();\n",
                       "beginCanonicalTimeline(this, this._groups.length, workers.length);", "        ")
        source = before(source, "                this._resultSlots[groupIndex].resolve({...result, sourceBytes, ownedContentBytes, consume});\n",
                        "bindCanonicalTimelineGroup(this, result.chunk, groupIndex, {rowCount: result.rowCount, uniqueCount: result.chunk?.contentDedupPlan?.uniqueCount ?? null, mediaRows: result.chunk?.mediaRows?.length ?? 0, sourceBytes, ownedContentBytes, borrowsWorkerMemory: result.borrowsWorkerMemory, resultFinishedAtMs: result.finishedAt});", "                ")
        source = before(source, "                        await this._onChunk(chunk, {\n",
                        "markCanonicalTimeline(chunk, 'sink-enter');", "                        ")
        source = before(source, "                        consume?.();\n                        delete chunk.releaseBorrowedContent;\n",
                        "markCanonicalTimeline(chunk, 'sink-exit');", "                        ")
    elif path.endswith("dictionary-database.js"):
        source = add_import(source, "markCanonicalTimeline")
        source = before(source, "            const dedup = await this._resolveArtifactTermContentDedup(chunk, true);\n",
                        "markCanonicalTimeline(chunk, 'dedup-start');", "            ")
        source = after(source, "            const dedup = await this._resolveArtifactTermContentDedup(chunk, true);\n",
                       "markCanonicalTimeline(chunk, 'dedup-end');", "            ")
        source = after(source, "            const canonicalScanStart = safePerformance.now();\n",
                       "markCanonicalTimeline(chunk, 'canonical-start');", "            ")
        source = after(source, "            const dedupCanonicalScanMs = Math.max(\n                0,\n                safePerformance.now() - canonicalScanStart - dedupExactCompareMs,\n            );\n",
                       "markCanonicalTimeline(chunk, 'canonical-end', {canonicalMs: dedupCanonicalScanMs, exactMs: dedupExactCompareMs, pendingCount: pendingContentCount});", "            ")
        source = before(source, "                    if (earlyContentPersistence === null) {\n                        this._addTermContentBlockProfile(importMetrics, persistenceResult.blockProfile ?? null);\n",
                        "markCanonicalTimeline(chunk, 'content-storage-ready', {early: earlyContentPersistence !== null});", "                    ")
        source = before(source, "                    if (earlyContentPersistence !== null) {\n                        const metadataPublishedAt = safePerformance.now();\n",
                        "markCanonicalTimeline(chunk, 'metadata-published', {early: earlyContentPersistence !== null});", "                    ")
        source = before(source, "                        // Prepare the record append before creating the derived\n",
                        "markCanonicalTimeline(chunk, 'lookahead-gate');", "                        ")
        source = after(source, "                                contentCompletedAt = safePerformance.now();\n",
                       "markCanonicalTimeline(chunk, 'content-done');", "                                ")
        source = after(source, "                        const concurrentResults = await Promise.allSettled([\n                            measuredContentCompletion,\n                            pendingRecordAppend,\n                        ]);\n",
                       "markCanonicalTimeline(chunk, 'join-done');", "                        ")
        source = after(source, "    async _appendResolvedArtifactTermRecords(chunk, contentOffsets, contentLengths, resolvedContentDictNames, importMetrics) {\n",
                       "markCanonicalTimeline(chunk, 'record-start');", "        ")
        source = after(source, "        const metrics = await this._termRecordStore.appendBatchFromArtifactChunkResolvedContent(\n            chunk,\n            contentOffsets,\n            contentLengths,\n            resolvedContentDictNames,\n        );\n",
                       "markCanonicalTimeline(chunk, 'record-done', {stage: 'existing-record-store-await-resolved'});", "        ")
    elif path.endswith("dictionary-importer.js"):
        source = add_import(source, "appendCanonicalTimelinePhase")
        source = before(source, "            return result;\n        } catch (error) {\n            const closeError = await archiveOwnership.closeIfOwned();\n",
                        "appendCanonicalTimelinePhase(result);", "            ")
    elif path.endswith("term-record-opfs-store.js"):
        source = add_import(source, "markCanonicalTimeline")
        source = before(source, "            const tValidationStart = safePerformance.now();\n            const useFixedContentSpan = hasFixedContentSpan(chunk, count);\n",
                        "markCanonicalTimeline(chunk, 'record-validation-start', {runStart});", "            ")
        source = after(source, "            const runValidationMs = safePerformance.now() - tValidationStart;\n",
                       "markCanonicalTimeline(chunk, 'record-validation-end', {runStart, rows: runEnd - runStart});", "            ")
        source = before(source, "        const tValidationStart = safePerformance.now();\n        let contentOffsetBase = validatedContentOffsetBase;\n",
                        "markCanonicalTimeline(chunk, 'record-encode-start', {rows: chunk.rowCount});", "        ")
        source = before(source, "        return {\n            contentOffsetBase,\n            lookupIndexBytes,\n            recordFields,\n            recordFieldsFormat,\n            validationMs,\n            recordFieldEncodeMs,\n",
                        "markCanonicalTimeline(chunk, 'record-encode-end', {rows: chunk.rowCount});", "        ")
    elif path == "dev/perf/import-benchmark.js":
        source = replace_once(source, "    authoritativeTiming: !options.trace,\n",
                              "    authoritativeTiming: false, // B9CACC: instrumented diagnostic, never timing evidence\n    diagnosticScope: '" + SCOPE + "',\n")
        source = replace_once(source, "    console.log(`[perf-import] ${fixture.label} run ${String(index)}/${String(runCount)}${options.trace ? ' (trace; timing is non-authoritative)' : ''}`);\n",
                              "    console.log(`[perf-import] ${fixture.label} diagnostic ${String(index)}/${String(runCount)} (instrumented; timing is non-authoritative)`);\n")
        source = replace_once(source, "console.log(`[perf-import] ${fixture.label} ${options.trace ? 'trace captured' : `median=${summary.timing.medianMs.toFixed(1)}ms min=${summary.timing.minMs.toFixed(1)}ms p95=${summary.timing.p95Ms.toFixed(1)}ms`} (${String(runCount)} run${runCount === 1 ? '' : 's'})`);\n",
                              "console.log(`[perf-import] ${fixture.label} non-authoritative canonical-lookahead diagnostic captured`);\n")
    else:
        raise ValueError(f"Unsupported source path {path}")
    if path in PRODUCT_PATHS and BLOCK.sub("", source) != original:
        raise AssertionError(f"Removing marker blocks did not restore exact baseline bytes: {path}")
    return source


def apply(root: pathlib.Path, output: pathlib.Path) -> None:
    if git(root, "rev-parse", "HEAD") != BASE:
        raise ValueError("Instrumentation requires exact frozen baseline HEAD")
    if git(root, "diff", "--name-only") or git(root, "diff", "--cached", "--name-only"):
        raise ValueError("Baseline must have no tracked changes")
    if git(root, "ls-files", "--others", "--exclude-standard", "ext"):
        raise ValueError("Unexpected untracked extension input before instrumentation")
    if (root / RUNTIME).exists():
        raise ValueError("Diagnostic runtime already exists")
    originals = {p: (root / p).read_text() for p in SOURCES}
    # Validate every hash, anchor, and inverse proof before the first mutation.
    changed = {p: instrument_source(p, s) for p, s in originals.items()}
    runtime = pathlib.Path(__file__).with_name("timeline-runtime.js").read_bytes()
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1, "scope": SCOPE, "baseline": BASE,
        "baselineTree": git(root, "rev-parse", "HEAD^{tree}"),
        "instrumenterSha256": sha256(pathlib.Path(__file__).read_bytes()),
        "files": {p: {"beforeSha256": SOURCES[p], "afterSha256": sha256(s.encode()),
                       "markerCount": len(BLOCK.findall(s)), "inverseByteProof": p in PRODUCT_PATHS}
                  for p, s in changed.items()},
        "runtime": {"path": RUNTIME, "sha256": sha256(runtime)},
        "unchangedInputs": {p: sha256((root / p).read_bytes()) for p in (
            "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
            "dev/perf/dictionary-fixtures.js", "test/chromium/extension-two-dictionary-import.e2e.js",
            "test/chromium/import-flags-ab-benchmark.js", "test/e2e/import-timing.js",
            "ext/js/pages/settings/dictionary-import-controller.js",
            "dev/data/dictionary-wasm/manifest.json")},
    }
    diff = []
    for p, source in changed.items():
        diff.extend(difflib.unified_diff(originals[p].splitlines(keepends=True), source.splitlines(keepends=True), fromfile="a/" + p, tofile="b/" + p))
        (root / p).write_text(source)
        copy = output / "instrumented-source" / p
        copy.parent.mkdir(parents=True, exist_ok=True)
        copy.write_text(source)
    (root / RUNTIME).write_bytes(runtime)
    diff.extend(difflib.unified_diff([], runtime.decode().splitlines(keepends=True), fromfile="/dev/null", tofile="b/" + RUNTIME))
    runtime_copy = output / "instrumented-source" / RUNTIME
    runtime_copy.parent.mkdir(parents=True, exist_ok=True)
    runtime_copy.write_bytes(runtime)
    (output / "instrumentation.patch").write_text("".join(diff))
    (output / "instrumentation.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"baseline": BASE, "files": list(changed), "runtime": RUNTIME, "scope": SCOPE}, indent=2))


def verify(root: pathlib.Path, output: pathlib.Path, package: pathlib.Path | None) -> None:
    manifest = json.loads((output / "instrumentation.json").read_text())
    if manifest["baseline"] != BASE or git(root, "rev-parse", "HEAD") != BASE:
        raise ValueError("Baseline HEAD changed")
    names = set(git(root, "diff", "--name-only").splitlines())
    if names != set(SOURCES) or git(root, "diff", "--cached", "--name-only"):
        raise ValueError(f"Unexpected tracked changes: {sorted(names)}")
    if set(git(root, "ls-files", "--others", "--exclude-standard", "ext").splitlines()) != {RUNTIME}:
        raise ValueError("Unexpected untracked extension input after instrumentation")
    for p, entry in manifest["files"].items():
        data = (root / p).read_bytes()
        if sha256(data) != entry["afterSha256"]:
            raise ValueError(f"Instrumented source changed: {p}")
        if p in PRODUCT_PATHS and sha256(BLOCK.sub("", data.decode()).encode()) != SOURCES[p]:
            raise ValueError(f"Inverse source proof failed: {p}")
    if sha256((root / RUNTIME).read_bytes()) != manifest["runtime"]["sha256"]:
        raise ValueError("Runtime changed")
    for p, expected in manifest["unchangedInputs"].items():
        if sha256((root / p).read_bytes()) != expected:
            raise ValueError(f"Unchanged input drifted: {p}")
    receipt = {"baseline": BASE, "scope": SCOPE, "sourceVerified": True}
    if package is not None:
        with zipfile.ZipFile(package) as archive:
            contents = {name: sha256(archive.read(name)) for name in archive.namelist() if not name.endswith("/")}
            for p in (*PRODUCT_PATHS, RUNTIME):
                if contents.get(p.removeprefix("ext/")) != sha256((root / p).read_bytes()):
                    raise ValueError(f"Packaged instrumentation mismatch: {p}")
        receipt["package"] = {"path": str(package), "sha256": sha256(package.read_bytes()), "entryCount": len(contents), "entries": contents}
    (output / "verified-source-package.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: v for k, v in receipt.items() if k != "package"}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--package", type=pathlib.Path)
    args = parser.parse_args()
    if args.verify:
        verify(args.root.resolve(), args.output.resolve(), args.package)
    else:
        apply(args.root.resolve(), args.output.resolve())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"canonical-timeline instrumentation rejected: {error}", file=sys.stderr)
        raise
