#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Frozen, single-host exploratory screens of complete dictionary imports.

Every cell executes its registered schedule once. Warmups and exhaustive media
checks are excluded from timing comparisons. This is measurement tooling only;
it never modifies product code or relaxes the native import verifier.
"""

import argparse
import copy
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
import zipfile


BASELINE = "0143e9596cd8f790d5e166d4ba6a2425fbc57f14"
STUDIES = {
    "utf8": {
        "A": BASELINE,
        "B": "6ddfacf26fd2d5069192ac279bcc61f81b7832ee",
        "C": "3dab279bb671f4a4f26d145209b6415159410bd3",
    },
    "borrowed-content": {
        "A": BASELINE,
        "B": "1a234772a0be1001ca63ce9d320d218123bd9449",
        "C": BASELINE,
    },
}
NODE_VERSION = "v22.22.0"
PLAYWRIGHT_VERSION = "1.63.0"
CHROMIUM_VERSION = "153.0.8010.12"
CHROMIUM_REVISION = "1243"
OVERLAY = "dev/perf/benchmark-support.js"
PERMUTATIONS = tuple("".join(order) for order in itertools.permutations("ABC"))
TIMING_BOUNDARY = "page file-input change event to post-UI import-complete event; browser monotonic clock"
LOOKUP_BOUNDARY = "settings-page termsFind RPC; first pass after restart, then five warm passes; excludes result hashing"
STORAGE_KIND = "OPFS logical file sizes after restart and verification"
SHA256 = re.compile(r"[a-f0-9]{64}")
SQLITE_NAME = re.compile(r"manabitan/sqlite-sahpool-v1/\.opaque/[a-z0-9]+")
MEDIA_NAME = re.compile(r"manabitan-dictionary-media-v1/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin")
PROVENANCE_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json", OVERLAY,
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js",
    "test/chromium/import-flags-ab-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/e2e/import-timing.js", "ext/js/pages/settings/dictionary-import-controller.js",
    "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)
SOURCE_BANKS = {
    "jmdict": (53, 15632849, 171617523),
    "jitendex": (219, 33829614, 538927310),
    "vndb": (665, 86850424, 4267992967),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def same(actual, expected, message):
    require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False), message)


def sha256_file(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        for data in iter(lambda: source.read(4 * 1024 * 1024), b""):
            result.update(data)
    return result.hexdigest()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(path.name + ".tmp")
    staged.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    staged.replace(path)


def read_json(path):
    return json.loads(path.read_text())


def schedule():
    result = [{"id": f"warmup-{arm}", "kind": "warmup", "arm": arm,
               "block": None, "mediaCheck": "sample"} for arm in "ABC"]
    for block, order in enumerate(PERMUTATIONS, 1):
        for position, arm in enumerate(order, 1):
            result.append({"id": f"block-{block:02d}-{position}-{arm}", "kind": "timed",
                           "block": block, "position": position, "order": order,
                           "arm": arm, "mediaCheck": "sample"})
    result.extend({"id": f"exhaustive-media-{arm}", "kind": "exhaustive-media",
                   "arm": arm, "block": None, "mediaCheck": "all"} for arm in "ABC")
    return result


def package_entries(path):
    with zipfile.ZipFile(path) as package:
        files = package.infolist()
        names = [entry.filename for entry in files]
        require(len(names) == len(set(names)), "Duplicate package entries")
        return {entry.filename: hashlib.sha256(package.read(entry)).hexdigest()
                for entry in files if not entry.is_dir()}


def canonical_storage(storage):
    require(type(storage) is dict and set(storage) == {"kind", "bytes", "files"}, "Invalid storage receipt")
    same(storage["kind"], STORAGE_KIND, "Unexpected storage boundary")
    require(type(storage["bytes"]) is int and storage["bytes"] > 0, "Invalid storage total")
    require(type(storage["files"]) is list and storage["files"], "Missing storage inventory")
    seen = set()
    normalized = []
    for row in storage["files"]:
        require(type(row) is dict and set(row) == {"path", "bytes"}, "Invalid storage file")
        name, size = row["path"], row["bytes"]
        require(isinstance(name, str) and name and not name.startswith("/") and
                ".." not in name.split("/") and name not in seen, "Invalid or duplicate storage path")
        require(type(size) is int and 0 <= size <= 2 ** 53 - 1, "Invalid storage size")
        seen.add(name)
        if SQLITE_NAME.fullmatch(name):
            name = "manabitan/sqlite-sahpool-v1/.opaque/{random}"
        elif name.startswith("manabitan/sqlite-sahpool-v1/.opaque/"):
            raise ValueError("Unrecognized random SQLite basename")
        elif MEDIA_NAME.fullmatch(name):
            name = "manabitan-dictionary-media-v1/{generation}.bin"
        elif name.startswith("manabitan-dictionary-media-v1/"):
            raise ValueError("Unrecognized generation-media basename")
        normalized.append({"path": name, "bytes": size})
    require(sum(row["bytes"] for row in normalized) == storage["bytes"], "Storage inventory total mismatch")
    return {**storage, "files": sorted(normalized, key=lambda row: (row["path"], row["bytes"]))}


def semantic_receipts(validation, fixture, media_check):
    """Separate public results from physical placement; preserve both receipts."""
    require(type(validation) is dict, "Missing validation")
    for key, expected in (("title", fixture["expectedTitle"]), ("revision", fixture["revision"]),
                          ("termRows", fixture["termRows"]), ("contentReadable", True), ("probeCount", 12)):
        same(validation.get(key), expected, f"Invalid validation {key}")
        same(validation.get("restart", {}).get(key), expected, f"Invalid restart {key}")
    same(validation["restart"].get("mediaFiles"), fixture["mediaFiles"], "Invalid restart media count")
    terms = validation.get("probeTerms")
    require(type(terms) is list and len(terms) == 12 and len(set(terms)) == 12 and
            all(isinstance(term, str) and term for term in terms), "Expected twelve distinct probes")
    lookup = validation.get("lookup", {})
    same(lookup.get("timingBoundary"), LOOKUP_BOUNDARY, "Unexpected lookup boundary")
    rows = lookup.get("observations")
    require(type(rows) is list and len(rows) == 72, "Expected all 72 lookup observations")
    expected_pairs = {(number, term) for number in range(6) for term in terms}
    seen, by_term, canonical_rows = set(), {}, []
    for row in rows:
        require(type(row) is dict, "Invalid lookup observation")
        pair = (row.get("pass"), row.get("term"))
        require(type(pair[0]) is int and pair in expected_pairs and pair not in seen, "Duplicate or unknown lookup")
        seen.add(pair)
        require(type(row.get("elapsedMs")) in (int, float) and math.isfinite(row["elapsedMs"]) and
                row["elapsedMs"] >= 0, "Invalid lookup time")
        require(type(row.get("results")) is int and row["results"] > 0, "Empty lookup")
        same(row.get("originalTextLength"), len(pair[1].encode("utf-16-le", "surrogatepass")) // 2, "Lookup length mismatch")
        same(row.get("hasExactHeadwordMatch"), True, "Missing exact result")
        require(isinstance(row.get("sha256"), str) and SHA256.fullmatch(row["sha256"]), "Invalid public lookup digest")
        public = {key: value for key, value in row.items() if key != "elapsedMs"}
        repeated = {key: value for key, value in public.items() if key != "pass"}
        if pair[1] in by_term:
            same(repeated, by_term[pair[1]], "Cold/warm public lookup results differ")
        by_term[pair[1]] = repeated
        canonical_rows.append(public)
    require(seen == expected_pairs, "Incomplete lookup coverage")
    media = validation.get("media", {})
    expected_files = fixture["mediaFiles"] if media_check == "all" else min(64, fixture["mediaFiles"])
    for key, expected in (("mode", media_check), ("totalFiles", fixture["mediaFiles"]),
                          ("totalBytes", fixture["mediaBytes"]), ("files", expected_files)):
        same(media.get(key), expected, f"Invalid media {key}")
    require(type(media.get("bytes")) is int and 0 <= media["bytes"] <= fixture["mediaBytes"], "Invalid checked media bytes")
    require(isinstance(media.get("sha256"), str) and SHA256.fullmatch(media["sha256"]), "Invalid media digest")
    require(not expected_files or media["bytes"] > 0, "Missing media bytes")
    if media_check == "all" or expected_files == fixture["mediaFiles"]:
        same(media["bytes"], fixture["mediaBytes"], "Incomplete exhaustive media bytes")
    if expected_files == 0:
        same(media["sha256"], hashlib.sha256(b"").hexdigest(), "Nonempty empty-media digest")
    physical_digest = validation.get("outputDigestSha256")
    require(isinstance(physical_digest, str) and SHA256.fullmatch(physical_digest), "Missing physical content digest")
    public = {key: copy.deepcopy(value) for key, value in validation.items()
              if key not in {"outputDigestSha256", "storage", "media", "lookup"}}
    public["lookup"] = {"timingBoundary": LOOKUP_BOUNDARY,
                        "observations": sorted(canonical_rows, key=lambda row: (row["pass"], row["term"]))}
    return {"public": public, "media": media,
            "physical": {"outputDigestSha256": physical_digest, "storage": canonical_storage(validation.get("storage"))}}


class Screen:
    def __init__(self, args):
        self.args = args
        self.root = Path(__file__).resolve().parents[2]
        self.evidence = args.evidence.resolve()
        self.evidence.mkdir(parents=True, exist_ok=False)
        self.work = Path(tempfile.mkdtemp(prefix=f"manabitan-{args.study}-{args.dictionary}-", dir=os.environ.get("RUNNER_TEMP")))
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(("MANABITAN_E2E_", "MANABITAN_CHROMIUM_"))}
        self.deadline = time.monotonic() + 80 * 60
        self.observations, self.identities, self.sources = [], {}, {}
        self.fatal_error = None
        self.references = {"public": None, "physical": {}, "media": {}, "parserPolicy": None}
        self.fixture = read_json(self.root / "test/perf/dictionaries.lock.json")["dictionaries"][args.dictionary]
        self.plan = {
            "schemaVersion": 1, "study": args.study, "dictionary": args.dictionary,
            "arms": STUDIES[args.study], "schedule": schedule(),
            "runtime": {"node": NODE_VERSION, "playwright": PLAYWRIGHT_VERSION,
                        "chromium": CHROMIUM_VERSION, "chromiumRevision": CHROMIUM_REVISION},
            "fixture": self.fixture, "overlayWhitelist": [OVERLAY],
            "overlaySha256": sha256_file(self.root / OVERLAY),
            "runnerSha256": sha256_file(Path(__file__)),
            "workflowSha256": sha256_file(self.root / ".github/workflows/import-screen-20261126-fbc.yml"),
            "sourceBankCounts": dict(zip(("banks", "compressedBytes", "uncompressedBytes"), SOURCE_BANKS[args.dictionary])),
            "sourceBoundary": "Frozen revisions; identical measurement-only benchmark-support overlay; runtime package allowlist checked before observations",
            "timingBoundary": TIMING_BOUNDARY,
            "comparison": "All six ABC permutations; six within-block pairs for B/A, C/A and C/B; paired median percentage and faster-pair counts only",
            "qualificationClaim": False, "scope": "Exploratory single-host cell; no host pooling or speed qualification",
            "failurePolicy": "Record every planned/attempted observation; no retries, replacement observations or partial-pair statistics; continue prescribed attempts after isolated failures until the fixed budget expires",
            "physicalPolicy": "Exact content placement digest and complete normalized storage inventory within each arm; never used as a cross-arm semantic oracle",
            "semanticPolicy": "All 72 public lookup hashes and validation fields match across arms; media compared separately for sample and exhaustive modes",
            "profilePolicy": "Private empty TMPDIR per attempt; native harness creates a fresh profile and restarts that same profile for all72 lookups",
            "mediaPolicy": "Sample checks in warmups/timed observations; exactly one separate exhaustive-media observation per arm after timing",
            "controlC": "Byte-identical A package and source under a separate fresh-profile label" if args.study == "borrowed-content" else "Fixed-width UTF8 candidate",
            "github": {key: os.environ.get(key) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_JOB")},
        }
        write_json(self.evidence / "registered-plan.json", self.plan)

    def command(self, argv, cwd, log, env=None, timeout=900, check=True, stdin=None):
        require(time.monotonic() < self.deadline, "Fixed screen budget exhausted")
        record = {"argv": [str(value) for value in argv], "cwd": str(cwd), "log": str(log.relative_to(self.evidence)),
                  "startedAtUnix": time.time(), "timeoutSeconds": min(timeout, max(1, int(self.deadline - time.monotonic())))}
        log.parent.mkdir(parents=True, exist_ok=True)
        with (self.evidence / "commands.jsonl").open("a") as stream:
            stream.write(json.dumps({"event": "started", **record}) + "\n")
        with log.open("wb") as output:
            child = subprocess.Popen(record["argv"], cwd=cwd, env=env or self.env, stdout=output,
                                     stderr=subprocess.STDOUT, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                                     start_new_session=True)
            try:
                child.communicate(input=stdin.encode() if stdin is not None else None, timeout=record["timeoutSeconds"])
                record["returnCode"] = child.returncode
            except subprocess.TimeoutExpired:
                record["timedOut"] = True
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                record["returnCode"] = child.returncode
        record["finishedAtUnix"] = time.time()
        with (self.evidence / "commands.jsonl").open("a") as stream:
            stream.write(json.dumps({"event": "finished", **record}) + "\n")
        if check:
            require(record["returnCode"] == 0 and not record.get("timedOut"), f"Command failed; see {record['log']}")
        return record

    def git(self, *args, cwd=None):
        return subprocess.check_output(["git", *args], cwd=cwd or self.root, env=self.env, text=True).strip()

    def prepare(self):
        require(os.environ.get("GITHUB_RUN_ATTEMPT", "1") == "1", "Selective workflow reruns are not replacement observations")
        runtime_script = """import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {writeFileSync} from 'node:fs'
import {chromium} from 'playwright'
const require = createRequire(import.meta.url)
const packagePath = require.resolve('playwright-core/package.json')
const browsersPath = join(dirname(packagePath), 'browsers.json')
writeFileSync(process.argv[1], JSON.stringify({node:process.version,nodeExecutable:process.execPath,playwright:require(packagePath).version,
chromiumExecutable:chromium.executablePath(),browsersPath,browsers:require(browsersPath).browsers}))
"""
        self.command(["node", "--input-type=module", "-e", runtime_script, str(self.evidence / "runtime-discovery.json")], self.root, self.evidence / "runtime-discovery.log")
        runtime = read_json(self.evidence / "runtime-discovery.json")
        same(runtime["node"], NODE_VERSION, "Node version differs from frozen plan")
        same(runtime["playwright"], PLAYWRIGHT_VERSION, "Playwright differs from locked plan")
        browser = next(row for row in runtime["browsers"] if row["name"] == "chromium")
        same(browser["revision"], CHROMIUM_REVISION, "Chromium revision mismatch")
        same(browser["browserVersion"], CHROMIUM_VERSION, "Chromium lock version mismatch")
        cache = self.env.get("PLAYWRIGHT_BROWSERS_PATH")
        require(isinstance(cache, str) and Path(cache).is_absolute(), "A private absolute PLAYWRIGHT_BROWSERS_PATH is required")
        runner_temp = self.env.get("RUNNER_TEMP")
        require(isinstance(runner_temp, str) and Path(runner_temp).is_absolute(), "This hosted screen requires RUNNER_TEMP")
        private_parent = Path(runner_temp).resolve()
        require(private_parent.is_dir() and private_parent != Path("/"), "Invalid private runner temporary directory")
        self.browser_cache = Path(cache).resolve()
        require(self.browser_cache == private_parent / "manabitan-import-screen-browsers", "Browser cleanup is restricted to the exact private job cache")
        require(Path(runtime["chromiumExecutable"]).resolve().is_relative_to(self.browser_cache), "Chromium is outside the private job cache")
        self.command([runtime["chromiumExecutable"], "--version"], self.root, self.evidence / "chromium-version.txt")
        version = re.search(r"\d+\.\d+\.\d+\.\d+", (self.evidence / "chromium-version.txt").read_text())
        require(version is not None and version.group() == CHROMIUM_VERSION, "Installed Chromium version mismatch")
        self.runtime = {**runtime, "chromiumSha256": sha256_file(runtime["chromiumExecutable"]),
                        "nodeSha256": sha256_file(runtime["nodeExecutable"]), "browsersJsonSha256": sha256_file(runtime["browsersPath"])}
        write_json(self.evidence / "runtime-identity.json", self.runtime)
        self.command(["node", "dev/perf/prepare-dictionaries.js", self.args.dictionary], self.root, self.evidence / "fixtures.log", timeout=300)
        fixture_path = self.root / "builds/e2e-dictionary-cache" / self.fixture["cacheFile"]
        same(fixture_path.stat().st_size, self.fixture["sizeBytes"], "Fixture byte length mismatch")
        same(sha256_file(fixture_path), self.fixture["sha256"], "Fixture SHA mismatch")
        write_json(self.evidence / "fixture-identity.json", {"fixture": self.fixture, "lockSha256": sha256_file(self.root / "test/perf/dictionaries.lock.json")})
        revisions = list(dict.fromkeys(STUDIES[self.args.study].values()))
        self.command(["git", "fetch", "--no-tags", "origin", *revisions], self.root, self.evidence / "fetch-frozen-sources.log", timeout=300)
        required_same = {"package.json", "package-lock.json", "test/perf/dictionaries.lock.json", ".github/actions/setup/action.yml",
                         "dev/perf/import-benchmark.js", "dev/perf/dictionary-fixtures.js", "dev/perf/import-media-validation.js", "dev/perf/host-environment.js"}
        required_same.update(name for name in self.git("ls-tree", "-r", "--name-only", BASELINE, "test/e2e", "test/chromium").splitlines()
                             if name.endswith((".js", ".mjs", ".html")))
        for arm, revision in STUDIES[self.args.study].items():
            if arm == "C" and self.args.study == "borrowed-content":
                self.sources[arm] = self.sources["A"]
                self.identities[arm] = {**copy.deepcopy(self.identities["A"]), "byteIdenticalAliasOf": "A"}
                write_json(self.evidence / f"package-entries-{arm}.json", self.identities[arm]["entries"])
                continue
            target = self.work / arm
            self.command(["git", "worktree", "add", "--no-checkout", "--detach", str(target), revision], self.root, self.evidence / f"worktree-{arm}.log")
            self.command(["git", "sparse-checkout", "set", "--no-cone", "/*", "!/builds/", "!/dev/perf/*-evidence*/"], target, self.evidence / f"sparse-{arm}.log")
            same(self.git("rev-parse", "HEAD", cwd=target), revision, f"Wrong source for {arm}")
            for name in required_same:
                same(sha256_file(target / name), sha256_file(self.root / name), f"Non-shared harness/dependency: {arm} {name}")
            original_overlay = sha256_file(target / OVERLAY)
            shutil.copyfile(self.root / OVERLAY, target / OVERLAY)
            (self.evidence / f"measurement-overlay-{arm}.patch").write_text(self.git("diff", "--", OVERLAY, cwd=target) + "\n")
            shutil.copytree(self.root / "node_modules", target / "node_modules", copy_function=os.link, symlinks=True)
            (target / "builds").mkdir(exist_ok=True)
            (target / "builds/e2e-dictionary-cache").symlink_to(self.root / "builds/e2e-dictionary-cache", target_is_directory=True)
            for command, name in ((["npm", "run", "build:libs"], "libs"), (["npm", "run", "license-report:html"], "license"),
                                  (["npm", "run", "build", "--", "--target", "chrome"], "build")):
                self.command(command, target, self.evidence / f"{name}-{arm}.log")
            changed = self.git("diff", "--name-only", cwd=target).splitlines()
            require(set(changed) <= {OVERLAY}, f"Unexpected source mutation in {arm}: {changed}")
            archive = target / "builds/manabitan-chrome.zip"
            hashes = {name: sha256_file(target / name) if (target / name).is_file() else None for name in PROVENANCE_PATHS}
            product_names = self.git("ls-tree", "-r", "--name-only", revision, "ext", "dev/data", "dev/bin", "dev/build-libs.js", "dev/manifest-util.js", "dev/util.js").splitlines()
            product_hashes = {name: sha256_file(target / name) for name in product_names if (target / name).is_file()}
            entries = package_entries(archive)
            self.identities[arm] = {
                "sha": revision, "tree": self.git("rev-parse", "HEAD^{tree}", cwd=target),
                "packageSha256": sha256_file(archive), "entries": entries,
                "sourceHashes": hashes, "productAndBuildSourceHashes": product_hashes,
                "harnessSourceHashes": {name: sha256_file(target / name) for name in required_same | {OVERLAY}},
                "productSourceDelta": self.git("diff", "--name-only", BASELINE, revision).splitlines(),
                "sourceDirty": bool(self.git("status", "--porcelain", cwd=target)),
                "status": self.git("status", "--porcelain", cwd=target),
                "overlay": {"path": OVERLAY, "originalSha256": original_overlay, "measurementSha256": self.plan["overlaySha256"]},
            }
            self.sources[arm] = target
            write_json(self.evidence / f"package-entries-{arm}.json", entries)
            write_json(self.evidence / "source-identities.json", self.identities)
        baseline_entries = self.identities["A"]["entries"]
        suffixes = ("js/dictionary/wasm/term-bank-parser.c", "lib/term-bank-parser.wasm") if self.args.study == "utf8" else ("js/dictionary/dictionary-database.js",)
        allowed = set()
        for suffix in suffixes:
            found = [name for name in baseline_entries if name == suffix or name.endswith("/" + suffix)]
            require(len(found) == 1, f"Cannot uniquely identify runtime member {suffix}")
            allowed.add(found[0])
        diffs = {}
        for arm in "BC":
            entries = self.identities[arm]["entries"]
            same(sorted(entries), sorted(baseline_entries), f"Package file set changed for {arm}")
            diffs[arm] = sorted(name for name in entries if entries[name] != baseline_entries[name])
            expected = set() if self.args.study == "borrowed-content" and arm == "C" else allowed
            same(set(diffs[arm]) == expected, True, f"Unexpected runtime delta for {arm}: {diffs[arm]}")
        if self.args.study == "borrowed-content":
            same(self.identities["C"]["packageSha256"], self.identities["A"]["packageSha256"], "Control C is not byte-identical A")
        write_json(self.evidence / "source-identities.json", self.identities)
        write_json(self.evidence / "runtime-package-deltas.json", {"allowed": sorted(allowed), "actualVsA": diffs})

    def validate(self, output, arm, media_check):
        summary, report = read_json(output / "summary.json"), read_json(output / "run-1.json")
        identity = self.identities[arm]
        for key, expected in (("schemaVersion", 3), ("dictionary", self.args.dictionary), ("buildTarget", "chrome"),
                              ("fixture", self.fixture), ("gitSha", identity["sha"]), ("importFlags", None),
                              ("traceEnabled", False), ("authoritativeTiming", True), ("mediaCheck", media_check),
                              ("timingBoundary", TIMING_BOUNDARY), ("browserVersion", CHROMIUM_VERSION)):
            same(summary.get(key), expected, f"Summary {key} mismatch")
        require(type(summary.get("runs")) is list and len(summary["runs"]) == 1, "Expected one complete native benchmark run")
        run = summary["runs"][0]
        same(run.get("index"), 1, "Unexpected native run index")
        same(run.get("tracePath"), None, "Timed observation unexpectedly contains tracing")
        same(summary.get("source", {}).get("gitSha"), identity["sha"], "Source lineage mismatch")
        same(summary["source"].get("dirty"), identity["sourceDirty"], "Source dirty state mismatch")
        same(summary["source"].get("sha256"), identity["sourceHashes"], "Source provenance hash mismatch")
        for obj in (report, run):
            same(obj.get("packageSha256"), identity["packageSha256"], "Wrong runtime package")
            same(obj.get("browserVersion"), CHROMIUM_VERSION, "Wrong browser runtime")
        for obj in (report, summary):
            same(obj.get("hostEnvironment", {}).get("nodeVersion"), NODE_VERSION, "Wrong Node runtime")
        for key, expected in (("status", "success"), ("skippedVerification", False), ("buildTarget", "chrome"),
                              ("browserFlavor", "chromium"), ("launchMode", "headless")):
            same(report.get(key), expected, f"Report {key} mismatch")
        benchmark = report.get("benchmark", {})
        for key, expected in (("dictionary", self.args.dictionary), ("pinnedDictionaries", True), ("productionImportDefaults", True),
                              ("traceEnabled", False), ("authoritativeTiming", True), ("phaseProfiling", False),
                              ("phaseScreenshots", False), ("processSampling", False), ("importFlags", None), ("mediaCheck", media_check)):
            same(benchmark.get(key), expected, f"Benchmark {key} mismatch")
        same(run.get("validation"), benchmark.get("validation"), "Summary/raw validation mismatch")
        phases = [phase for phase in report.get("phases", []) if phase.get("name") == f"{self.fixture['label']}: total import"]
        require(len(phases) == 1, "Missing or duplicate import phase")
        data = phases[0].get("data", {})
        same(run.get("importDebug"), data.get("importDebug"), "Summary/raw debug mismatch")
        same(run.get("step4Breakdown"), data.get("step4Breakdown"), "Summary/raw parser receipt mismatch")
        for key, expected in (("hasResult", True), ("resultTitle", self.fixture["expectedTitle"]),
                              ("errorCount", 0), ("addSettingsErrorCount", 0), ("usesFallbackStorage", False)):
            same(run.get("importDebug", {}).get(key), expected, f"Import completion {key} mismatch")
        receipt_keys = set()
        effective = {}
        for phase in run["importDebug"].get("importerPhaseTimings", []):
            details = phase.get("details", {})
            receipt_keys.update(details)
            for key in ("parserExperiments", "fastPathParserEffectiveExperiments"):
                if key in details:
                    require(key not in effective, f"Duplicate effective parser receipt: {key}")
                    effective[key] = details
        require({"parserExperiments", "fastPathParserEffectiveExperiments", "fastPathParserExperiments", "compressionExperiments"} <= receipt_keys,
                "Missing effective/requested/compression policy receipts")
        banks, compressed, uncompressed = SOURCE_BANKS[self.args.dictionary]
        policies = []
        for key, details in effective.items():
            prefix = "parser" if key == "parserExperiments" else "fastPathParser"
            workers = details.get(prefix + "ParallelWorkerCount")
            groups_per_worker = 4 if self.args.dictionary == "jmdict" else 3
            require(type(workers) is int and workers in (2, 3, 5), "Unexpected production parser worker count")
            groups = min(banks, max(workers * groups_per_worker, math.ceil(uncompressed / (24 * 1024 * 1024))))
            for suffix, expected in (("BankSpanCount", banks), ("SourceCompressedBytes", compressed),
                                     ("SourceUncompressedBytes", uncompressed), ("ParallelGroupCount", groups),
                                     ("ParallelPipelineGroupsPerWorker", groups_per_worker), ("ParallelSkipReason", None),
                                     ("FusedAttempts", groups), ("FusedFallbacks", 0), ("DiscardedFusedRows", 0)):
                same(details.get(prefix + suffix), expected, f"Invalid production parser receipt {prefix + suffix}")
            policies.append({"workers": workers, "groupsPerWorker": groups_per_worker, "groups": groups})
        require(len(policies) == 2, "Missing parser policy contexts")
        same(policies[0], policies[1], "Effective parser policy contexts differ")
        if self.references["parserPolicy"] is None:
            self.references["parserPolicy"] = policies[0]
        same(policies[0], self.references["parserPolicy"], "Parser policy changed within this host cell")
        duration = run.get("totalImportMs")
        require(type(duration) in (int, float) and math.isfinite(duration) and duration > 0, "Invalid complete-import duration")
        timing = data.get("browserTiming", {})
        same(timing.get("trigger"), "file-input-change", "Invalid browser timing trigger")
        same(timing.get("errorCount"), 0, "Browser timing reports errors")
        require(abs(duration - (timing["completedAtMs"] - timing["startedAtMs"])) <= 0.001, "Timing is not browser monotonic duration")
        same(summary.get("timing", {}).get("count"), 1, "Wrong timing count")
        for key in ("minMs", "medianMs", "p95Ms", "maxMs"):
            same(summary["timing"].get(key), duration, f"Wrong timing {key}")
        receipts = semantic_receipts(run["validation"], self.fixture, media_check)
        if self.references["public"] is None:
            self.references["public"] = receipts["public"]
        same(receipts["public"], self.references["public"], "Public semantic results differ across arms/observations")
        if arm not in self.references["physical"]:
            self.references["physical"][arm] = receipts["physical"]
        same(receipts["physical"], self.references["physical"][arm], "Physical result changed within arm")
        if media_check not in self.references["media"]:
            self.references["media"][media_check] = receipts["media"]
        same(receipts["media"], self.references["media"][media_check], "Persisted media results differ across arms")
        write_json(output / "canonical-receipts.json", receipts)
        return {"totalImportMs": duration, "publicSha256": fingerprint(receipts["public"]),
                "physicalSha256": fingerprint(receipts["physical"]), "mediaSha256": fingerprint(receipts["media"])}

    def observe(self, item):
        output = self.evidence / item["id"]
        output.mkdir()
        attempt = {**item, "status": "started", "startedAtUnix": time.time()}
        write_json(output / "attempt.json", attempt)
        temporary = self.work / "profiles" / item["id"]
        temporary.mkdir(parents=True)
        target, identity = self.sources[item["arm"]], self.identities[item["arm"]]
        try:
            self.verify_arm_identity(item["arm"])
            attempt["sourceIdentityBeforePassed"] = True
            self.command(["node", "dev/perf/host-environment.js"], target, output / "host-before.json", timeout=30)
            argv = ["node", "dev/perf/import-benchmark.js", self.args.dictionary, "--runs", "1", "--no-build",
                    "--build-target", "chrome", "--media-check", item["mediaCheck"], "--output", str(output)]
            attempt["command"] = argv
            attempt["freshProfileRoot"] = str(temporary)
            write_json(output / "attempt.json", attempt)
            attempt["process"] = self.command(argv, target, output / "run.log", env={**self.env, "TMPDIR": str(temporary)},
                                               timeout=1800 if item["kind"] == "exhaustive-media" else 900, check=False)
            require(attempt["process"]["returnCode"] == 0 and not attempt["process"].get("timedOut"), "Native benchmark command failed; see run.log")
            attempt.update(self.validate(output, item["arm"], item["mediaCheck"]))
            same(sha256_file(target / "builds/manabitan-chrome.zip"), identity["packageSha256"], "Package changed during observation")
            self.command(["node", "dev/perf/host-environment.js"], target, output / "host-after.json", timeout=30)
            attempt["status"] = "passed"
        except Exception as error:
            attempt.update(status="failed", error=str(error))
            (output / "failure.txt").write_text(traceback.format_exc())
        finally:
            try:
                self.verify_arm_identity(item["arm"])
                attempt["sourceIdentityAfterPassed"] = True
            except Exception as error:
                attempt.update(status="failed", sourceIdentityAfterPassed=False, identityError=str(error))
            # The cache belongs to this one sequential hosted job. Renderer and
            # GPU children can omit --user-data-dir, so also inspect executable
            # paths inside that private cache. An orphan invalidates the run.
            orphans = []
            for proc in Path("/proc").glob("[0-9]*/cmdline"):
                try:
                    command = proc.read_bytes().replace(b"\0", b" ").decode(errors="replace")
                    executable = (proc.parent / "exe").resolve(strict=True)
                    if str(temporary) in command or executable.is_relative_to(self.browser_cache):
                        pid = int(proc.parent.name)
                        orphans.append({"pid": pid, "command": command})
                        os.kill(pid, signal.SIGKILL)
                except (OSError, ValueError):
                    continue
            if orphans:
                attempt.update(status="failed", orphanProcesses=orphans, cleanupError="Browser processes survived the native harness")
            shutil.rmtree(temporary, ignore_errors=True)
            attempt["finishedAtUnix"] = time.time()
            write_json(output / "attempt.json", attempt)
            self.observations.append(attempt)
            write_json(self.evidence / "observations.json", self.observations)
            print(f"{self.args.study}/{self.args.dictionary} {item['id']}: {attempt['status']}", flush=True)

    def summarize(self):
        complete = self.fatal_error is None and len(self.observations) == len(self.plan["schedule"]) and all(row["status"] == "passed" for row in self.observations)
        comparisons = {}
        if complete:
            timed = {(row["block"], row["arm"]): row["totalImportMs"] for row in self.observations if row["kind"] == "timed"}
            for numerator, denominator in (("B", "A"), ("C", "A"), ("C", "B")):
                changes = [100 * (timed[(block, numerator)] / timed[(block, denominator)] - 1) for block in range(1, 7)]
                comparisons[f"{numerator}/{denominator}"] = {
                    "pairs": 6, "pairedMedianPercentChange": statistics.median(changes),
                    "fasterPairs": sum(change < 0 for change in changes), "equalPairs": sum(change == 0 for change in changes),
                    "pairedPercentChanges": changes,
                    "numeratorMedianMs": statistics.median(timed[(block, numerator)] for block in range(1, 7)),
                    "denominatorMedianMs": statistics.median(timed[(block, denominator)] for block in range(1, 7)),
                }
        result = {"status": "complete-correctness-passed" if complete else "incomplete-or-failed",
                  "qualificationClaim": False, "scope": self.plan["scope"], "study": self.args.study,
                  "dictionary": self.args.dictionary, "plannedObservations": len(self.plan["schedule"]),
                  "completedObservations": len(self.observations), "comparisons": comparisons,
                  "campaignFailure": self.fatal_error,
                  "negativePercentMeans": "Numerator completed the full import faster",
                  "statisticsPolicy": "All six registered complete blocks required; warmups and exhaustive media imports excluded; no replacement or partial-pair statistics",
                  "failedOrMissing": [row["id"] for row in self.observations if row["status"] != "passed"] +
                                     [row["id"] for row in self.plan["schedule"] if row["id"] not in {done["id"] for done in self.observations}]}
        write_json(self.evidence / "screen-summary.json", result)
        write_json(self.evidence / "comparison-references.json", self.references)
        return complete

    def verify_arm_identity(self, arm):
        target, identity = self.sources[arm], self.identities[arm]
        same(self.git("rev-parse", "HEAD", cwd=target), identity["sha"], f"Source HEAD changed: {arm}")
        same(self.git("status", "--porcelain", cwd=target), identity["status"], f"Source status changed: {arm}")
        for category in ("productAndBuildSourceHashes", "harnessSourceHashes"):
            for name, expected in identity[category].items():
                same(sha256_file(target / name), expected, f"Recorded source changed: {arm} {name}")
        same(sha256_file(target / "builds/manabitan-chrome.zip"), identity["packageSha256"], f"Runtime package changed: {arm}")

    def verify_final_identities(self):
        same(sha256_file(self.runtime["chromiumExecutable"]), self.runtime["chromiumSha256"], "Chromium changed during the screen")
        same(sha256_file(self.runtime["nodeExecutable"]), self.runtime["nodeSha256"], "Node changed during the screen")
        fixture_path = self.root / "builds/e2e-dictionary-cache" / self.fixture["cacheFile"]
        same(sha256_file(fixture_path), self.fixture["sha256"], "Fixture changed during the screen")
        for arm in self.sources:
            self.verify_arm_identity(arm)
        write_json(self.evidence / "final-identity-checks.json", {"passed": True, "runtime": True, "fixture": True, "allArmSourcesAndPackages": True})

    def finish(self):
        files = sorted(path for path in self.evidence.rglob("*") if path.is_file() and path.name != "SHA256SUMS")
        (self.evidence / "SHA256SUMS").write_text("".join(f"{sha256_file(path)}  {path.relative_to(self.evidence)}\n" for path in files))


def self_test():
    plan = schedule()
    require(len(plan) == 24 and len({row["id"] for row in plan}) == 24, "Invalid registered schedule")
    for arm in "ABC":
        require(sum(row["kind"] == "warmup" and row["arm"] == arm for row in plan) == 1, "Warmup schedule")
        require(sum(row["kind"] == "exhaustive-media" and row["arm"] == arm for row in plan) == 1, "Media schedule")
        for position in (1, 2, 3):
            require(sum(row["kind"] == "timed" and row["arm"] == arm and row["position"] == position for row in plan) == 2, "Unbalanced arm position")
    storage = {"kind": STORAGE_KIND, "bytes": 4100, "files": [
        {"path": "manabitan/sqlite-sahpool-v1/.opaque/abc123", "bytes": 4096}, {"path": "product.bin", "bytes": 4}]}
    renamed = copy.deepcopy(storage)
    renamed["files"][0]["path"] = "manabitan/sqlite-sahpool-v1/.opaque/def456"
    same(canonical_storage(storage), canonical_storage(renamed), "Random name normalization")
    altered = copy.deepcopy(storage)
    altered["bytes"] += 1
    altered["files"][1]["bytes"] += 1
    require(canonical_storage(storage) != canonical_storage(altered), "Physical allocation change was hidden")
    try:
        canonical_storage({**storage, "files": storage["files"] + [storage["files"][0]]})
        raise AssertionError("Duplicate storage paths accepted")
    except ValueError:
        pass
    print("Registered schedule and physical-receipt negative checks passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", choices=tuple(STUDIES))
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"))
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.study or not args.dictionary or args.evidence is None:
        parser.error("--study, --dictionary and --evidence are required")
    screen = Screen(args)
    try:
        screen.prepare()
        for item in screen.plan["schedule"]:
            screen.observe(item)
        screen.verify_final_identities()
        return 0 if screen.summarize() else 1
    except Exception:
        screen.fatal_error = traceback.format_exc()
        (screen.evidence / "campaign-failure.txt").write_text(traceback.format_exc())
        screen.summarize()
        traceback.print_exc()
        return 1
    finally:
        screen.finish()


if __name__ == "__main__":
    sys.exit(main())
