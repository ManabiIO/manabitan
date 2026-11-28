#!/usr/bin/env python3
"""Freeze phase2A evidence only; never change originals or run product code.

This needs the original retained workspace and Git object database. To verify a
published checkpoint, use verify-phase2a-checkpoint.py instead. Phase1 is read
only. The output directory must not already exist.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


AS_OF = "2026-11-28T05:16:45Z"
BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
FINGERPRINT = "178ee43328141693e88b90b4b518d483c87b2fac"
MINSIZE = "2907ba1bad0958c22fe363f88d7cceb4d4bc604e"
WIDE = "ebf4278afc59d83f191692bd587f0e1f7e8682b3"
PHASE1_COMMIT = "35069bdeb7a904fb9a39c919717b61021af9e78b"
PHASE1_REPO_PATH = "dev/perf/import-optimization-9bb32/phase1"
REPO_PATH = "dev/perf/import-optimization-9bb32/phase2a"
CELLS = ("jmdict-AB", "jmdict-BA", "jitendex-AB", "jitendex-BA", "vndb-AB", "vndb-BA")


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def main(workspace, output):
    prof = workspace / "profiling"
    require(not output.exists(), f"Output already exists: {output}")
    require((prof / "checkpoint-phase1/checkpoint-phase1.tar.gz").is_file(), "Immutable phase1 archive missing")
    files, origins = {}, {}
    selection_exclusions = []

    def add(name, value, origin=None):
        require(name not in files, f"Duplicate proof path: {name}")
        if isinstance(value, Path):
            require(value.is_file() and not value.is_symlink(), f"Expected regular input: {value}")
            files[name] = value.read_bytes()
            origins[name] = origin or {"kind": "local-retained-file", "path": str(value)}
        else:
            files[name] = value
            origins[name] = origin or {"kind": "generated-checkpoint-metadata", "asOfUtc": AS_OF}

    def add_local(relative):
        add("profiling/" + relative, prof / relative)

    # These entire new evidence directories are frozen. Preserve all attempts,
    # empty logs, prior status wording, and distinct reviewed revisions.
    for directory in ("long-keyword-wide-static-phase2", "long-keyword-correctness-phase2",
                      "minsize-causal-phase2", "hosted-wide-parity-spec", "hosted-plans"):
        for path in sorted((prof / directory).rglob("*")):
            if not path.is_file():
                continue
            if "__pycache__" in path.parts or path.suffix == ".pyc":
                selection_exclusions.append({"path": str(path), "reason": "Reproducible Python bytecode cache"})
                continue
            add("profiling/" + path.relative_to(prof).as_posix(), path)

    for name in (
        "minsize-hosted-qa.json", "minsize-hosted-qa.log",
        "wide-literal-ownership-contract-review.json", "scanner-simd-prior-review-phase2.json",
        "archive-hosted-artifact.py", "analyze-hosted-cell.py",
        "audit-hosted-cell-semantics-memory.py", "audit-hosted-cell-semantics-memory-v2.py",
        "audit-hosted-cell-semantics-memory-v2-provenance.json",
        "audit-hosted-cell-semantics-memory-v2-independent-review.json",
        "emit-qualification-logs.py", "pipeline-replay.mjs", "canonical-corpus.mjs",
        "canonical-capture-jmdict.json", "canonical-capture-jitendex.json", "canonical-capture-vndb.json",
        "canonical-capture-archive-receipt.json", "canonical-jmdict-capture-archive-receipt.json",
        "archive-jmdict-capture.py", "local-package-cleanup.json", "rejected-worktree-cleanup.json",
        "minsize-jmdict-ba-log-projection-binding.json", "minsize-jmdict-ba-log-stage-projection.json",
    ):
        add_local(name)

    cells = []
    for cell in CELLS:
        folder = prof / "hosted-qualification/fingerprint" / cell
        for path in sorted(folder.iterdir()):
            if path.name == "raw-evidence.tar.gz":
                continue
            require(path.is_file() and not path.is_symlink(), f"Unexpected cell input: {path}")
            add("profiling/" + path.relative_to(prof).as_posix(), path)
        retention = json.loads((folder / "retention-manifest.json").read_bytes())
        audit = json.loads((folder / "independent-semantics-memory-audit.json").read_bytes())
        analysis = json.loads((folder / "audit-and-stage-analysis.json").read_bytes())
        github = json.loads((folder / "github-artifact.json").read_bytes())
        require(audit["passed"] and analysis["checksPassed"], f"Unpassed cell: {cell}")
        data = (folder / "raw-evidence.tar.gz").read_bytes()
        check_identity(data, retention["retainedArchive"], cell)
        cells.append({
            "cell": cell, "publicationName": f"fingerprint-{cell}.raw-evidence.tar.gz",
            "originalPath": str(folder / "raw-evidence.tar.gz"), **identity(data),
            "sourceArtifact": retention["sourceArtifact"],
            "githubArtifactUrl": github["url"], "artifactExpiresAt": github["expires_at"],
            "proofDirectory": "profiling/hosted-qualification/fingerprint/" + cell,
            "includedOriginalFiles": len(retention["included"]),
            "derivedFiles": len(retention["derived"]), "omittedOriginalPayloads": len(retention["omittedRedundant"]),
            "allImportCount": analysis["allImportCount"],
            "sourceNativeStageChecks": analysis["checkCount"], "independentChecks": audit["checkCount"],
            "rawMemoryScans": audit["memorySummary"]["rawScanCount"],
            "frozenHarnessAnalysis": analysis["frozenHarnessAnalysis"],
        })
    add("CELL-INDEX.json", encoded({
        "asOfUtc": AS_OF, "scope": "All six fixed fingerprint cells; no observations removed or repeated",
        "allImportCount": sum(c["allImportCount"] for c in cells), "cells": cells,
        "timingUnits": "Percent change B versus A; positive means slower. Controls use identical A code.",
        "memoryScope": "Separate qualified sampled Linux process-tree PSS/private memory, not an absolute peak guarantee",
        "decision": "No repeatable full-import gain. No PR for fingerprint candidate.",
    }))

    def git(repo, *arguments):
        return subprocess.check_output(["git", *arguments], cwd=repo)

    def frozen_file(repo, commit, source, destination):
        data = git(repo, "show", f"{commit}:{source}")
        add(destination, data, {"kind": "git-object", "repository": "ManabiIO/manabitan",
                                "commit": commit, "path": source, "gitBlobSha1": blob(data)})
        return data

    wide = workspace / "wide-keyword"
    publication = json.loads(files["profiling/long-keyword-correctness-phase2/published-source-identity.json"])
    require(git(wide, "rev-parse", "HEAD").decode().strip() == WIDE, "Wide working branch moved")
    require(git(wide, "rev-parse", "HEAD^{tree}").decode().strip() == publication["remote"]["tree"], "Wide tree moved")
    require(not git(wide, "status", "--porcelain").strip(), "Wide worktree is not clean")
    changed = git(wide, "diff", "--name-only", BASE, WIDE, "--").decode().splitlines()
    require(sorted(changed) == sorted(item["path"] for item in publication["local"]["files"]), "Wide five-file delta differs")
    for item in publication["local"]["files"]:
        data = frozen_file(wide, WIDE, item["path"], "source-snapshots/wide-keyword/" + item["path"])
        check_identity(data, item, item["path"])
        require((wide / item["path"]).read_bytes() == data, "Working file differs from published source")
    add("source-snapshots/wide-keyword/SNAPSHOT.json", encoded({
        "remoteCommit": WIDE, "tree": publication["remote"]["tree"], "baseCommit": BASE,
        "originalLocalCommit": publication["local"]["localCommit"],
        "sameCompleteTree": True, "files": publication["local"]["files"],
        "sourceDigest": publication["local"]["sourceDigest"],
        "note": "Exact five changed files copied from immutable Git objects. No new product execution.",
    }))

    baseline = workspace / "baseline"
    baseline_files = [
        "ext/js/dictionary/wasm/term-bank-parser.c", "dev/data/dictionary-wasm/term-bank-parser.wasm",
        "dev/data/dictionary-wasm/manifest.json", "dev/bin/build-dictionary-wasm.js", "dev/dictionary-wasm.js",
        "dev/perf/import-qualification-20261125-a7f7.py", "test/perf/dictionaries.lock.json",
    ]
    baseline_files += [path.relative_to(baseline).as_posix()
                       for path in sorted((baseline / "dev/perf/import-memory-20261125-a7f7").rglob("*"))
                       if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"]
    for source in baseline_files:
        frozen_file(baseline, BASE, source, "source-snapshots/baseline/" + source)

    # Resolve prior /tmp paths through the already published archive, without
    # recreating them or claiming they survived the execution-environment reset.
    phase1 = prof / "checkpoint-phase1"
    prior_inventory_bytes = (phase1 / "INVENTORY.json").read_bytes()
    prior_inventory = json.loads(prior_inventory_bytes)
    require(sha(prior_inventory_bytes) == "bd57cff8bd2624dfefa4881106ca75c1b00dc78b5e55918efbc35376d0f17206", "Phase1 inventory changed")
    prior_archive = identity((phase1 / "checkpoint-phase1.tar.gz").read_bytes())
    require(prior_archive["sha256"] == "050a01b9994034c0e070d66e17d1f879b20d724772e8c187af354a879936d161", "Phase1 archive changed")
    add("prior-checkpoint/phase1-INVENTORY.json", prior_inventory_bytes,
        {"kind": "published-git-blob", "commit": PHASE1_COMMIT, "path": PHASE1_REPO_PATH + "/INVENTORY.json",
         "gitBlobSha1": blob(prior_inventory_bytes)})
    dependency_prefixes = (
        "compiler-static/", "toolchain-provenance/", "profiling/parser-symbol-map/",
        "profiling/composite-minsize-screen-1/", "profiling/composite-minsize-vndb-parity-1/",
    )
    dependency_names = {
        "profiling/pipeline-replay.mjs", "profiling/canonical-corpus.mjs", "profiling/parser-symbol-map.mjs",
        "profiling/exploratory-observation-status.json", "profiling/composite-minsize-final-source-binding.json",
        "profiling/hosted-baseline-summary.json", "profiling/parser-cold-path-analysis.json",
        "profiling/finalization-tail-analysis.json", "profiling/parser-slot-compatibility.json",
    }
    dependencies = []
    for item in prior_inventory["files"]:
        if item["path"].startswith(dependency_prefixes) or item["path"] in dependency_names:
            dependencies.append({"path": item["path"], "phase1InventoryEntry": item,
                                 "originalPathExistsAtCheckpoint": Path(item["origin"]).exists()
                                 if item["origin"].startswith("/") else None,
                                 "authority": "Immutable phase1 archive member, regardless of original scratch path availability"})
    add("PHASE1-DEPENDENCIES.json", encoded({
        "repository": "ManabiIO/manabitan", "commit": PHASE1_COMMIT,
        "repositoryDirectory": PHASE1_REPO_PATH,
        "archive": {"name": "checkpoint-phase1.tar.gz", **prior_archive},
        "inventory": {"name": "INVENTORY.json", **identity(prior_inventory_bytes)},
        "fullPriorInventoryCopy": "prior-checkpoint/phase1-INVENTORY.json",
        "members": dependencies,
        "limits": "The execution environment recovered with /tmp reset. Original path strings are historical. Missing inputs remain recoverable from the exact phase1 archive; no toolchains or lost worktrees were reconstructed.",
    }))

    add("EXCLUSIONS.json", encoded({
        "scope": "Selection boundaries only; no deletion of retained original evidence by this checkpoint",
        "originalHostedArtifacts": {
            "retainedRawEvidence": "All 269 original JSON/JSONL/log/protocol-JS files per fingerprint cell, byte-for-byte, plus one derived package audit",
            "omittedPayloads": "42 rendered HTML and 2 package ZIP payloads per cell; every original size/SHA256 is retained",
            "verificationBeforeOmission": "Original GitHub ZIP digest checked; both actual nested package byte hashes and all 554 members per arm rehashed; exact five prospective package changes checked",
            "currentVerificationLimit": "Omitted bytes are not recreated or rehashed now. The verifier checks the retained original verification records and their consistency. HTML hashes are recorded, not a proof of independent HTML/JSON equivalence.",
        },
        "deferredEvidence": [
            "MinSize full browser raw cohorts and their later independent audits: preserve separately for a later checkpoint; this snapshot contains only two explicitly partial JMdict log projections.",
            "Wide source-QA and untimed parity result artifacts, not completed/reviewed at the 05:16:45 snapshot; no wide performance run launched.",
        ],
        "omittedBulk": [
            "Locked dictionary ZIPs, canonical .groups and compressed corpus captures; capture manifests and archival receipts are retained",
            "Node/Clang distributions, dependency directories, and generated release packages",
            "Previously published phase1 bulk evidence; exact dependency/member locators retained instead",
        ],
        "omittedReproducibleCaches": selection_exclusions,
        "smallDiagnosticBinariesRetained": "Wide compiler .bc/.o/.wasm outputs and exact parser artifact are retained as diagnostic/source proofs, not distribution/toolchain bundles",
    }))

    status = {
        "schemaVersion": 1, "asOfUtc": AS_OF, "repository": "ManabiIO/manabitan", "baselineCommit": BASE,
        "purpose": "Phase2A evidence checkpoint; no product publication or new measurements",
        "pullRequestsCreatedByThisTask": 0, "supersedesPhase1": False,
        "fingerprint": {
            "source": FINGERPRINT, "qualificationRun": 46104243724,
            "workflowCommit": "b64b3d0423d758252fce9333ceef6e98431de47b",
            "sourceQaRun": 46102827974, "sourceQa": "PASS; raw receipt/log retained in phase1",
            "completeCells": 6, "totalImports": 252, "allRawObservationsRetained": True,
            "sourceNativeStageChecksPerCell": 585,
            "independentSemanticsMemoryChecks": sum(c["independentChecks"] for c in cells),
            "rawMemoryScansAudited": sum(c["rawMemoryScans"] for c in cells),
            "decision": "SHELVE; no reproducible full-import gain; no PR",
        },
        "minsize": {
            "source": MINSIZE, "sourceQaRun": 46104779877,
            "sourceQa": "PASS: pinned native regeneration; 380 focused tests; JS lint; four TypeScript projects; 669 unit files / 15135 passed / 47 skipped; all-target dry build",
            "qualificationRun": 46104898097,
            "workflowCommit": "0c2a8a75cd0322cc13348b977a7e915b555d5a88",
            "qualification": "INCOMPLETE at snapshot; no complete performance conclusion in this checkpoint",
            "partialObservationContext": "Two JMdict cells disagree. Their partial projections do not constitute full qualification; raw cohorts remain outside phase2A for later retention.",
        },
        "wideKeyword": {
            "source": WIDE, "tree": "611b6e1591ffbbc9c978c33dee9af72a7b618536",
            "originalLocalCommit": "1ec7369996d8b4e24802854b0524709aa54aadb3",
            "parserSha256": "6962928b4810ac489048b6a686e3a6cdbcd7fe3116328a13fa458bd02634024c",
            "localValidation": "56 actual-WASM cases passed; ordinary pinned regeneration matched; lint and broader focused tests ended by SIGKILL without verdict or retry",
            "sourceQaRun": 46110109833, "sourceQa": "PENDING at snapshot",
            "untimedParityRun": 46111036970,
            "untimedParityWorkflowCommit": "52a7f01ef88021a35f90d05510cec7f58557e935",
            "untimedParity": "PENDING at snapshot; reviewed helper/workflow and baseline digests retained",
            "performanceRunLaunched": False, "speedupClaim": False,
        },
        "failedAttemptsRetained": [
            "First wide static compile wrapper failed only at the assembler subprocess; retained optimized output was subsequently assembled/linked without another source optimization variant",
            "New-case test setup rejected unsupported --minWorkers before discovery; corrected setup passed all 56 cases",
            "Changed-file lint SIGKILL, no verdict or retry",
            "Eleven existing focused suites SIGKILL, no JSON verdict or retry",
            "Initial same-tree remote alignment did not execute during exec-server outage; exactly one guarded alignment succeeded after recovery",
        ],
        "runtimeVersions": {"localValidation": "Node 24.20.0", "hostedQaAndQualification": "Node 22.22.0"},
        "limits": [
            "Static smaller code or reduced load counts are hypotheses, not import-speed claims",
            "Full parser-output component digests and hosted sampled persisted lookup checks have different coverage",
            "Each hosted lookup receipt covers twelve fixed terms over one cold and five warm passes; prescribed separate media slots scan all referenced media",
            "Memory is sampled process-tree PSS/private with qualifying coverage, not a guaranteed absolute peak",
            "Internal stage durations overlap and cannot be summed as independent CPU time",
        ],
    }
    add("STATUS.json", encoded(status))

    table = "\n".join(
        f"| {c['cell']} | {c['frozenHarnessAnalysis']['candidateVsBaseline']['medianPairedChangePercent']:+.3f}% | "
        f"{c['frozenHarnessAnalysis']['candidateVsBaseline']['equalWorkChangePercent']:+.3f}% | "
        f"{c['frozenHarnessAnalysis']['identicalCodeControl']['medianPairedChangePercent']:+.3f}% |"
        for c in cells)
    readme = f"""# Manabitan import optimization — phase2A evidence

**Canonical slot fingerprints did not produce a repeatable full-import gain and
will not receive a PR. MinSize qualification remains incomplete; wide-keyword
correctness is still pending. No PR has been created by this task.**

This is the immutable status snapshot at **2026-11-28 05:16:45 UTC**. It appends to
phase1 at `{PHASE1_COMMIT}`; it does not rewrite phase1's earlier pending status.
No import, benchmark, test, or source compilation was run to create this checkpoint.

## Completed fingerprint comparison

All six fixed cohorts from run 46104243724 are retained: three dictionaries and
two independently scheduled starting orders, 42 imports per cell, **252 total**.
Each cell includes 24 measured pair imports, 8 identical-code controls, 4 warmups,
4 separate memory observations, and 2 exhaustive referenced-media checks. All
outliers remain. No observation was dropped, replaced, or rerun for this archive.

Percent changes below are copied from the frozen harness analysis; positive is
slower. The full paired ratios, descriptive intervals, stage reports, controls,
and individual observations are retained. The equal-work column is the frozen
aggregate elapsed-time comparison, not a new resampling analysis.

| Cell | Median paired change | Equal-work change | Identical-code control median |
|---|---:|---:|---:|
{table}

JMdict changes direction between cells and does not demonstrate a replicated
gain. Jitendex and VNDB also fail to demonstrate a consistent improvement.
Correctness and qualified sampled-memory gates passed in every cell. Those
passes establish the stated validation scopes, not a speedup.

Baseline is `{BASE}`; candidate is `{FINGERPRINT}`. The exact qualification
workflow is `{status['fingerprint']['workflowCommit']}`. Each cell binds its
original GitHub artifact ID, run, job, digest, byte count, source pins, browser,
registered schedule, package identities, and all observations.

## Contents and lossless scope

`proofs-and-sources.tar.gz` contains new wide-keyword static/compiler/causal
evidence, the exact five changed files from published source `{WIDE}`, all 56-case
test receipts, all failed local attempts, outage/alignment receipts, minsize causal
analysis and successful hosted source-QA log, frozen workflow revisions, the
reviewed untimed parity helper, six completed cell audits, and retention scripts.
The native source, parser WASM, manifest, new test, and source-QA workflow are in
`source-snapshots/wide-keyword/`. Baseline source and qualification/memory tools
are also included. Small diagnostic `.bc`, `.o`, and `.wasm` outputs remain.

Six separate `fingerprint-<cell>.raw-evidence.tar.gz` files are **unchanged copies**
of the verified per-cell archives. Each contains all **269 original JSON, JSONL,
log, and protocol-JS files**, plus a derived package-verification record. That is
270 members per cell. The checkpoint is lossless for these original raw records;
it is not a byte-complete copy of each downloaded GitHub ZIP.

Before retention, the original GitHub artifact digest was checked. Both actual
nested package byte hashes and all **554 package members per arm** were independently
rehashed and matched to the source identity. The actual changed-member set was
checked against the prospective plan's exact five entries. Only the two package
ZIP payloads and 42 rendered HTML files per cell were then omitted; their original
sizes and hashes remain in each `retention-manifest.json`. The original artifact
identities/URLs remain in `github-artifact.json` and `CELL-INDEX.json`.

The present verifier checks the retained bytes and consistency of those original
package-verification records. It cannot rehash omitted payloads without obtaining
the original artifact. Recorded HTML hashes do not claim an independent proof of
HTML/JSON equivalence. Original dictionary and media payloads are not duplicated.

## Failed and pending work stays explicit

The first wide compiler attempt preserved optimized assembly but encountered a
relocated-wrapper assembler failure. Its raw logs are retained along with the
authorized completion that assembled/linked those unchanged outputs. There was
one source-optimization variant. Ordinary production regeneration later matched
the same parser bytes.

The unsupported `--minWorkers` setup failure happened before discovery. The
corrected invocation passed all 56 actual-WASM cases. Changed-file lint and the
eleven pre-existing focused suites later ended by SIGKILL, with no complete
verdict or retry. Empty logs remain empty. The initial remote-alignment attempt
did not execute during the environment outage; a single guarded same-tree
alignment subsequently succeeded. Historical receipts remain verbatim, including
earlier statements such as static-only or not-yet-published; use `STATUS.json` for
this checkpoint's later state.

MinSize hosted source QA **46104779877 passed** at source `{MINSIZE}`: pinned
native check, 380 focused tests, JavaScript lint, four TypeScript projects,
669 unit files / 15,135 tests passed / 47 skipped, and all-target dry build.
Its full browser run **46104898097 is incomplete at this snapshot**. Two partial
JMdict log projections are included as partial notes only; minsize raw cohorts
and subsequent audits are reserved for the next checkpoint. No full minsize
performance conclusion is asserted here.

Wide source QA **46110109833** and untimed full-parser-output parity
**46111036970** remain pending at the snapshot. The parity diagnostic commit is
`52a7f01ef88021a35f90d05510cec7f58557e935`. No wide performance run has launched.
The smaller bytecode and changed long-literal loads establish an experiment
hypothesis; the causal review explicitly does not infer dictionary-specific
literal frequency, physical JIT register behavior, or an import-speed gain.

## Earlier dependencies and reproducibility

`PHASE1-DEPENDENCIES.json` gives immutable archive/member hashes for earlier IR,
assembly, baseline profiles/receipts, and local components. The complete phase1
inventory is retained under `prior-checkpoint/`. In particular, the original
`/tmp` minsize IR and toolchain paths disappeared during environment recovery;
their historical path strings are not claims that those paths still exist.
Recover the evidence bytes from phase1 rather than reconstructing a toolchain or
silently substituting new compiler output.

Phase1 lives at `{PHASE1_REPO_PATH}` in `{PHASE1_COMMIT}`. Its archive SHA256 is
`{prior_archive['sha256']}` and Git blob is `{prior_archive['gitBlobSha1']}`.
Corpus capture manifests and archival receipts are retained; large corpus
payloads, compiler/runtime distributions, dependencies, and generated product
ZIPs are excluded. `EXCLUSIONS.json` states the exact retention/deferment limits.

Hosted QA and qualification use **Node 22.22.0**. The retained local correctness
and component receipts use **Node 24.20.0**. Follow each original command, runtime,
source identity, and locked dictionary manifest; do not relabel local results as
hosted observations. Complete parser-output component digests differ in scope
from hosted persisted lookup checks: the latter sample twelve fixed terms across
one cold and five warm passes. Prescribed separate media slots scan all referenced
media. Memory is non-atomic sampled process-tree PSS/private with the frozen
coverage gate, so between-scan peaks can be missed. Stage timers overlap.

## Verify without rerunning work

Run `python3 verify-phase2a-checkpoint.py .` from this directory. Optionally add
`--phase1 /path/to/checkpoint-phase1.tar.gz` to check prior dependency bytes, and
`--repack /path/to/new-proof.tar.gz` to confirm deterministic proof repacking.
These operations only read/hash retained records and write the requested repack.
They do not run any import, test, or benchmark.

`PROOF-INVENTORY.json` binds every proof member except itself; it also occurs
inside the archive. `INVENTORY.json` binds every other publication item by size,
SHA256, and Git blob SHA1. It excludes itself to avoid a recursive hash, so its
trusted identity is supplied by the containing Git tree and the external
publication receipt. A later independent audit may be published adjacent to this
sealed set; it does not alter the recorded evidence. Tar entries are sorted regular
files with mode 0644, UID/GID zero, empty owner names, and mtime zero; gzip has an
empty filename, mtime zero, and compression level 9. A second proof pack must have
identical bytes. The six existing raw archives are copied, never repacked.
"""
    add("README.md", readme.encode())
    add("build-phase2a-checkpoint.py", Path(__file__).resolve())
    add("verify-phase2a-checkpoint.py", prof / "verify-phase2a-checkpoint.py")

    proof_inventory = {
        "schemaVersion": 1, "asOfUtc": AS_OF,
        "selfExcluded": "PROOF-INVENTORY.json; its exact bytes are supplied outside and inside the archive",
        "files": [{"path": name, **identity(data), "origin": origins[name]} for name, data in sorted(files.items())],
    }
    proof_inventory_bytes = encoded(proof_inventory)
    files["PROOF-INVENTORY.json"] = proof_inventory_bytes
    output.mkdir(parents=True)
    pack(output / "proofs-and-sources.tar.gz", files)
    proof_identity = identity((output / "proofs-and-sources.tar.gz").read_bytes())
    with tempfile.TemporaryDirectory(prefix="manabitan-phase2a-9bb32-") as directory:
        repeated = Path(directory) / "proof-repack.tar.gz"
        pack(repeated, files)
        require(repeated.read_bytes() == (output / "proofs-and-sources.tar.gz").read_bytes(), "Proof repack differs")
    for cell in cells:
        destination = output / cell["publicationName"]
        shutil.copyfile(cell["originalPath"], destination)
        check_identity(destination.read_bytes(), cell, cell["cell"])
    for name in ("README.md", "STATUS.json", "CELL-INDEX.json", "EXCLUSIONS.json", "PHASE1-DEPENDENCIES.json",
                 "PROOF-INVENTORY.json", "build-phase2a-checkpoint.py", "verify-phase2a-checkpoint.py"):
        (output / name).write_bytes(files[name])
    packaging = {
        "asOfUtc": AS_OF, "originalsModified": False, "phase1Modified": False,
        "proofArchive": {"name": "proofs-and-sources.tar.gz", **proof_identity,
                         "members": len(files), "uncompressedBytes": sum(len(data) for data in files.values())},
        "deterministicProofRepackByteIdentical": True, "rawArchivesCopiedByteIdentically": 6,
        "rawArchivesRepacked": False, "rawArchivePayloadBytes": sum(c["bytes"] for c in cells),
        "allPayloadBytes": proof_identity["bytes"] + sum(c["bytes"] for c in cells),
        "sourceFilesCopiedFromExactWideCommit": 5,
        "phase1DependencyMembers": len(dependencies),
        "outerInventorySelfExcluded": True,
        "independentAudit": "Required after seal; its receipt is outside this immutable proof archive",
    }
    (output / "PACKAGING.json").write_bytes(encoded(packaging))
    outer = [{"name": p.name, **identity(p.read_bytes()), "proposedRepositoryPath": REPO_PATH + "/" + p.name}
             for p in sorted(output.iterdir()) if p.is_file()]
    (output / "INVENTORY.json").write_bytes(encoded({
        "schemaVersion": 1, "asOfUtc": AS_OF, "repositoryDirectory": REPO_PATH,
        "selfExcluded": "INVENTORY.json; authoritative bytes are bound by its containing Git tree and external publication receipt",
        "files": outer,
    }))
    publication_files = [{"path": str(p), "name": p.name, **identity(p.read_bytes()),
                          "proposedRepositoryPath": REPO_PATH + "/" + p.name}
                         for p in sorted(output.iterdir()) if p.is_file()]
    (prof / "checkpoint-phase2a-publication-files.json").write_bytes(encoded({
        "asOfUtc": AS_OF, "sealedForIndependentAudit": True, "published": False,
        "proofArchive": packaging["proofArchive"], "files": publication_files,
        "independentAudit": "Pending; root publishes only after independent byte audit",
    }))
    print(json.dumps({"output": str(output), "proofArchive": packaging["proofArchive"],
                      "rawArchivePayloadBytes": packaging["rawArchivePayloadBytes"],
                      "publicationFiles": len(publication_files), "phase1Dependencies": len(dependencies)}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path("/workspace/scratch/9bb32f82fa3b"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("phase2a_verifier", args.workspace / "profiling/verify-phase2a-checkpoint.py")
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    require, sha, blob = verifier.require, verifier.sha, verifier.blob
    identity, check_identity, pack = verifier.identity, verifier.check_identity, verifier.pack
    main(args.workspace.resolve(), (args.output or args.workspace / "profiling/checkpoint-phase2a").resolve())
